/**
 * Tailnet access host half for the dsh-remote bundle.
 *
 * DSH binds one concrete address and rejects wildcard listens: `0.0.0.0` is a
 * refused configuration, not an oversight. This bundle therefore leaves the
 * webserver on its loopback default and forwards the machine's Tailscale
 * address(es) at the same port to that loopback listener over raw TCP, which
 * carries HTTP, WebSocket upgrades, and TLS unchanged.
 *
 * Two wire obligations follow from forwarding:
 *  - The `/api` Host fence accepts the webserver's own bind address only, so
 *    each forwarded authority must be named in Connection's `trustedHosts`.
 *    The plugin provides them as the `remoteBind` service for that row.
 *  - DSH keeps its settings and credential surfaces loopback-only. A served
 *    page off loopback marks itself non-privileged, creates the settings
 *    mirror in memory mode, and never touches the Host document — which is why
 *    a tailnet browser would otherwise see read-only models and disabled
 *    API-key forms. Injecting the transport global the desktop shell uses
 *    (`__DSH_TRANSPORT__ = { ownsHost: true }`) declares this deployment's
 *    browsers are the operator, restoring host-persisted settings and
 *    credential writes.
 *
 * A third obligation applies to host plugins that keep their own loopback
 * fence instead of deferring to Connection's `trustedHosts` — dsh-notion's
 * settings API is one. Those fences compare the exact `host:port`, so the
 * sync below names the forwarded authorities in the plugin's own allowlist as
 * well. Both faces must agree, or the GUI loads while that plugin's settings
 * page answers 403.
 *
 * Authentication is unchanged: the launch token and signed session cookie
 * still admit a browser, and credential reads stay redacted, so stored key
 * values never cross the wire.
 *
 * @module dsh-remote
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { networkInterfaces, hostname as osHostname, homedir } from 'node:os'
import { connect, createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

/** Stable Cordis plugin name; the bundle patch inserts this row by it. */
export const name = 'dsh-remote'

/** Activate after the webserver whose port this forwards. */
export const inject = ['webServer']

/** The listener every forwarded connection is relayed to. */
const LOOPBACK = '127.0.0.1'

/**
 * The local node's MagicDNS name from `tailscale status` output, without the
 * trailing dot. Browsers reach this machine by that name (it is what the
 * tailnet resolver answers), so it must be trusted and advertised next to the
 * interface addresses — a URL at the FQDN sends that FQDN as the Host header,
 * which the /api fence would otherwise reject.
 * @param {string} json raw `tailscale status --json --peers=false` output.
 * @returns {string} FQDN in lowercase, or '' when the output names no node.
 */
export function parseTailscaleFqdn(json) {
  try {
    const fqdn = JSON.parse(json)?.Self?.DNSName
    if (typeof fqdn === 'string' && fqdn.length > 0) return fqdn.replace(/\.$/u, '').toLowerCase()
  } catch {
    // Not JSON or unreadable: no name to trust.
  }
  return ''
}

/**
 * Read the local node's MagicDNS name synchronously (the fence authorities
 * must exist before the first await). The tailscale CLI is local-only here.
 * @param {() => string} [readStatus] seam returning the status JSON; the
 *   default runs the CLI and returns '' on any failure.
 * @returns {string} FQDN without the trailing dot, or '' when unavailable.
 */
export function tailscaleFqdn(readStatus = defaultTailscaleStatus) {
  return parseTailscaleFqdn(readStatus())
}

function defaultTailscaleStatus() {
  try {
    return execFileSync('tailscale', ['status', '--json', '--peers=false'], {
      timeout: 2000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
}

/**
 * Tailnet name for the portable bridge. The name is the URL host and the
 * trusted `/api` authority, so it must be DNS-safe; operators can pin it with
 * `DSH_REMOTE_PORTABLE_HOSTNAME` (the default is this machine's hostname).
 * @param {NodeJS.ProcessEnv} [env] environment to read the override from.
 * @param {string} [osName] machine hostname to fall back to.
 * @returns {string} lowercase DNS-label tailnet name.
 */
export function portableHostname(env = process.env, osName = osHostname()) {
  const dnsLabel = (raw) => raw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')
  const override = env.DSH_REMOTE_PORTABLE_HOSTNAME ? dnsLabel(env.DSH_REMOTE_PORTABLE_HOSTNAME) : ''
  if (override) return override
  return dnsLabel(osName ?? '') || 'dsh'
}

/**
 * Command line for the portable bridge: the node serves `port` on the tailnet
 * and relays it to DSH's loopback listener on the same port.
 * @param {object} options - bridge parameters.
 * @param {string} options.hostname - tailnet name for the node.
 * @param {number} options.port - webserver port to bridge.
 * @param {string[]} [options.extra] - additional arguments (e.g. a test
 *   control URL), passed through verbatim.
 * @returns {string[]} arguments for PortableTailscale.
 */
export function portableArgs({ hostname, port, extra = [] }) {
  return ['--json', '--hostname', hostname, '--forward', `${port}:${port}`, ...extra]
}

/**
 * Spawn the portable bridge and watch its `--json` events: the tokenized
 * tailnet URL prints once the node reports it is connected, and error events
 * surface instead of vanishing into a pipe.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {object} options - spawn parameters.
 * @param {string} options.bin - PortableTailscale executable path.
 * @param {string} options.hostname - tailnet name for the node.
 * @param {number} options.port - webserver port being bridged.
 * @param {string[]} [options.extra] - extra CLI arguments for the node.
 * @param {NodeJS.ProcessEnv} [options.env] - environment for the child.
 * @param {(line: string) => void} [options.onLine] - seam for tests.
 * @returns {() => void} disposer that stops the child.
 */
export function startPortable(ctx, { bin, hostname, port, extra = [], env = process.env, onLine }) {
  const child = spawn(bin, portableArgs({ hostname, port, extra }), {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (onLine) onLine(line)
      handlePortableEvent(ctx, { hostname, port }, line)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { process.stderr.write(`portable-tailscale: ${chunk}`) })
  child.once('exit', (code) => {
    console.error(`dsh-remote: portable tailscale exited (code ${code}); the tailnet URL is no longer served`)
  })
  return () => { child.kill() }
}

/** React to one `--json` event line from the portable bridge. */
function handlePortableEvent(ctx, { hostname, port }, line) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    return
  }
  if (event.event === 'connected') {
    ctx.inject(['connection'], (connectionCtx) => {
      const url = connectionCtx.connection.authenticatedUrl(`http://${hostname}:${port}`)
      console.log(`dsh-remote (portable): ${url}`)
    })
  } else if (event.event === 'error') {
    console.error(`dsh-remote: portable tailscale: ${event.message ?? 'unknown error'}`)
  }
}

/**
 * The local addresses this deployment serves on.
 * @param {NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>} [interfaces]
 *   interface table to inspect; defaults to the live one.
 * @returns every non-internal IPv4 address of a Tailscale interface.
 */
export function tailscaleIPv4(interfaces = networkInterfaces()) {
  return Object.entries(interfaces)
    .filter(([name]) => name.startsWith('tailscale'))
    .flatMap(([, rows]) => rows ?? [])
    .filter((row) => row.family === 'IPv4' && !row.internal)
    .map((row) => row.address)
}

/**
 * Whether a peer address belongs to the tailnet: Tailscale's IPv4 range
 * 100.64.0.0/10 or its IPv6 ULA prefix fd7a:115c:a1e0::/48 (IPv4-mapped IPv6
 * included). Linux accepts packets for a local address on any interface, so a
 * LAN host routing to the Tailscale IP over ethernet would otherwise reach the
 * forwarder; Tailscale's own firewall already drops 100.64/10 sources that do
 * not arrive on tailscale0, so a tailnet source address means a tailnet peer.
 * @param {string | undefined} address remote address as Node reports it.
 * @returns {boolean} true only for tailnet addresses.
 */
export function isTailnetAddress(address) {
  if (typeof address !== 'string') return false
  const lower = address.toLowerCase()
  const v4 = lower.startsWith('::ffff:') ? lower.slice(7) : lower
  const octets = v4.split('.')
  if (octets.length === 4 && octets.every((o) => /^\d{1,3}$/u.test(o))) {
    const [a, b] = octets.map(Number)
    return a === 100 && b >= 64 && b <= 127
  }
  return lower.startsWith('fd7a:115c:a1e0:')
}

/**
 * Path of the dsh-notion connector's credential and fence config, the file its
 * 403 body points operators at. It lives next to the other per-user plugin
 * state under `~/.dsh`.
 * @param {string} [home] home directory; defaults to the current user's.
 * @returns {string} absolute config path.
 */
export function notionConfigPath(home = homedir()) {
  return join(home, '.dsh', 'notion.json')
}

/**
 * Whether the dsh-notion connector is installed in the active profile. The
 * environment names the profile for tool shells, but the web service process
 * itself may lack it, so an unnamed profile falls back to every profile under
 * `~/.dsh/profiles` — the connector's config file is per-user, so a hit in any
 * profile means the fence exists and should be synced.
 * @param {string | undefined} [profileDir] `DSH_PROFILE_DIR`; defaults to the environment.
 * @param {string} [home] home directory; defaults to the current user's.
 * @returns {boolean} true when the connector's package resolves in a profile.
 */
export function notionInstalled(profileDir = process.env.DSH_PROFILE_DIR, home = homedir()) {
  const profilesDir = join(home, '.dsh', 'profiles')
  const profiles = []
  if (typeof profileDir === 'string' && profileDir !== '') {
    profiles.push(profileDir)
  } else {
    try {
      for (const name of readdirSync(profilesDir)) profiles.push(join(profilesDir, name))
    } catch {
      // No profiles directory: no profile-installed connector either.
    }
  }
  return profiles.some((dir) => existsSync(join(dir, 'node_modules', 'dsh-notion-connector', 'package.json')))
}

/**
 * The `Host` values a fence scoped to one port must trust: dsh-notion compares
 * the browser's exact `host:port`, not a hostname on any port like Connection's
 * `trustedHosts`.
 * @param {string[]} authorities forwarded hostnames or addresses.
 * @param {number} port the webserver port the fence scopes to.
 * @returns {string[]} one `host:port` entry per authority.
 */
export function fenceHosts(authorities, port) {
  return authorities.filter(Boolean).map((authority) => `${authority}:${port}`)
}

/**
 * Keep dsh-notion's loopback fence in step with the authorities this bundle
 * serves. The connector re-reads `allowedHosts` on every settings request, so
 * a tailnet browser can read status and save or clear the token — the one
 * surface Connection's `trustedHosts` cannot reach, because the connector
 * keeps its own fence.
 *
 * Only the allowlist is managed: the token and workspace fields are preserved
 * verbatim, nothing is written when the connector is absent, and an existing
 * file that cannot be parsed is left alone rather than clobbered.
 * @param {object} options - sync parameters.
 * @param {string[]} options.authorities forwarded hostnames or addresses.
 * @param {number} options.port the webserver port the fence scopes to.
 * @param {string} [options.configPath] config file to update.
 * @param {boolean} [options.installed] whether the connector is in the profile.
 * @param {(line: string) => void} [options.log] announcement sink.
 * @returns {'updated' | 'unchanged' | 'skipped'} what the sync did.
 */
export function syncNotionFence({
  authorities,
  port,
  configPath = notionConfigPath(),
  installed = notionInstalled(),
  log = console.log,
} = {}) {
  const wanted = fenceHosts(authorities, port)
  if (wanted.length === 0) return 'skipped'
  const exists = existsSync(configPath)
  if (!exists && !installed) return 'skipped'
  let current = {}
  if (exists) {
    try {
      current = JSON.parse(readFileSync(configPath, 'utf8'))
    } catch {
      return 'skipped'
    }
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return 'skipped'
  }
  const hosts = Array.isArray(current.allowedHosts)
    ? current.allowedHosts.filter((host) => typeof host === 'string' && host !== '')
    : []
  const merged = [...new Set([...hosts, ...wanted])]
  if (exists && merged.length === hosts.length) return 'unchanged'
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, `${JSON.stringify({ ...current, allowedHosts: merged }, null, 2)}\n`, { mode: 0o600 })
  chmodSync(configPath, 0o600)
  log(`dsh-remote: trusted ${wanted.join(', ')} in ${configPath} for the Notion settings fence`)
  return 'updated'
}

/**
 * Relay raw TCP from each authority to the loopback listener. Piping in both
 * directions keeps the protocol out of the picture: HTTP, WebSocket upgrades,
 * and TLS all pass through untouched.
 * @param {object} options - authorities, listen port, target port.
 * @param {string[]} options.addresses - local addresses to listen on.
 * @param {number} options.port - listen port (`0` lets the OS choose).
 * @param {number} options.targetPort - loopback port to relay to.
 * @param {string} [options.targetHost] - loopback host to relay to.
 * @param {(address: string | undefined) => boolean} [options.allow] - which
 *   peers may connect; default: tailnet addresses only (no LAN).
 * @returns {Promise<{bound: {address: string, port: number}[], failures: {address: string, error: Error}[], close(): void}>}
 *   the authorities that bound, the ones that did not, and one disposer.
 */
export async function startForwarders({ addresses, port, targetPort, targetHost = LOOPBACK, allow = isTailnetAddress }) {
  const listening = []
  const failures = []
  const sockets = new Set()
  await Promise.all(addresses.map((address) => new Promise((resolve) => {
    const server = createServer((socket) => {
      // Tailnet only: drop any other peer before a byte reaches DSH.
      if (!allow(socket.remoteAddress)) {
        console.error(`dsh-remote: refused ${socket.remoteAddress ?? 'unknown peer'} (not a tailnet address)`)
        socket.destroy()
        return
      }
      sockets.add(socket)
      socket.once('close', () => { sockets.delete(socket) })
      const upstream = connect({ host: targetHost, port: targetPort })
      sockets.add(upstream)
      upstream.once('close', () => { sockets.delete(upstream) })
      // A half-open failure must tear down its peer: raw relays otherwise leak
      // sockets until the process exits.
      socket.on('error', () => { upstream.destroy() })
      upstream.on('error', () => { socket.destroy() })
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    server.once('error', (error) => {
      failures.push({ address, error })
      resolve()
    })
    server.listen({ host: address, port }, () => {
      const bound = server.address()
      listening.push({ address, port: typeof bound === 'object' && bound !== null ? bound.port : port, server })
      resolve()
    })
  })))
  return {
    bound: listening.map(({ address, port: boundPort }) => ({ address, port: boundPort })),
    failures,
    close() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      for (const { server } of listening) server.close()
    },
  }
}

/** Test seams; production never mutates them. */
export const internals = { tailscaleIPv4, tailscaleFqdn, startForwarders, startPortable, isTailnetAddress, syncNotionFence }

/**
 * Run the fence sync without letting a config problem take the boot down: a
 * stale fence is one 403 in a settings page, a thrown boot is worse.
 * @param {string[]} authorities forwarded hostnames or addresses.
 * @param {number} port the webserver port.
 */
function syncFence(authorities, port) {
  try {
    internals.syncNotionFence({ authorities, port })
  } catch (error) {
    console.error('dsh-remote: could not sync the Notion settings fence:', error instanceof Error ? error.message : error)
  }
}

/**
 * Mount tailnet forwarding, the fence authorities, and the operator transport
 * global when this machine has a Tailscale address. Without one, fall back to
 * the portable bridge: an ephemeral userspace tailnet node
 * (PortableTailscale) that serves the port inside the tunnel and relays to
 * DSH's loopback listener — no Tailscale installation, no administrator
 * rights. The same two wire obligations apply: the tailnet name becomes the
 * fence authority, and the transport global still declares the remote browser
 * the operator.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 */
export function apply(ctx) {
  const addresses = internals.tailscaleIPv4()
  if (addresses.length > 0) {
    // Browsers reach this machine by its MagicDNS name, so that name is an
    // authority next to the interface addresses; unresolvable is fine (the
    // addresses still are).
    const fqdn = internals.tailscaleFqdn()
    const authorities = fqdn ? [...addresses, fqdn] : addresses
    // Connection activates against this service, so provide it before any await.
    ctx.provide('remoteBind', { authorities })
    const port = ctx.webServer.port
    if (port === undefined) throw new Error('dsh-remote: the webserver bound no port, so there is nothing to forward')
    syncFence(authorities, port)
    ctx.effect(() => ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: '__DSH_TRANSPORT__', value: { ownsHost: true } })
    }), 'dsh-remote: remote operator transport')
    ctx.effect(() => {
      let stopped = false
      let handle
      void internals.startForwarders({ addresses, port, targetPort: port }).then((started) => {
        for (const failure of started.failures) {
          console.error(`dsh-remote: cannot listen on ${failure.address}:${port} (${failure.error.message})`)
        }
        if (stopped) started.close()
        else handle = started
      }).catch((error) => {
        console.error('dsh-remote: forwarding failed:', error)
      })
      return () => {
        stopped = true
        handle?.close()
      }
    }, 'dsh-remote: tailnet forwarders')
    ctx.inject(['connection'], (connectionCtx) => {
      for (const host of [...addresses, fqdn].filter(Boolean)) {
        const url = connectionCtx.connection.authenticatedUrl(`http://${host}:${port}`)
        console.log(`dsh-remote: ${url}`)
      }
    })
    return
  }
  applyPortable(ctx)
}

/** Portable bridge: no Tailscale interface, serve through PortableTailscale. */
function applyPortable(ctx) {
  const bin = process.env.DSH_REMOTE_PORTABLE_BIN
  if (!bin) {
    // Keep the fence closed rather than guessing an authority; say how to
    // turn the bridge on instead of failing the boot.
    ctx.provide('remoteBind', { authorities: [] })
    console.error('dsh-remote: no Tailscale interface found. To serve the GUI without installing Tailscale, set DSH_REMOTE_PORTABLE_BIN to a PortableTailscale executable (https://github.com/anthony1x6000/PortableTailscale).')
    return
  }
  const port = ctx.webServer.port
  if (port === undefined) throw new Error('dsh-remote: the webserver bound no port, so there is nothing to forward')
  const hostname = portableHostname()
  syncFence([hostname], port)
  // The URL's host is the tailnet name, so that name is the fence authority.
  ctx.provide('remoteBind', { authorities: [hostname] })
  ctx.effect(() => ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: '__DSH_TRANSPORT__', value: { ownsHost: true } })
  }), 'dsh-remote: remote operator transport')
  const extra = (process.env.DSH_REMOTE_PORTABLE_ARGS ?? '').split(/\s+/u).filter(Boolean)
  ctx.effect(() => internals.startPortable(ctx, { bin, hostname, port, extra }), 'dsh-remote: portable tailscale bridge')
}
