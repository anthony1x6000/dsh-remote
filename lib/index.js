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
 * Authentication is unchanged: the launch token and signed session cookie
 * still admit a browser, and credential reads stay redacted, so stored key
 * values never cross the wire.
 *
 * @module dsh-remote
 */

import { networkInterfaces, hostname as osHostname } from 'node:os'
import { connect, createServer } from 'node:net'
import { spawn } from 'node:child_process'

/** Stable Cordis plugin name; the bundle patch inserts this row by it. */
export const name = 'dsh-remote'

/** Activate after the webserver whose port this forwards. */
export const inject = ['webServer']

/** The listener every forwarded connection is relayed to. */
const LOOPBACK = '127.0.0.1'

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
 * Relay raw TCP from each authority to the loopback listener. Piping in both
 * directions keeps the protocol out of the picture: HTTP, WebSocket upgrades,
 * and TLS all pass through untouched.
 * @param {object} options - authorities, listen port, target port.
 * @param {string[]} options.addresses - local addresses to listen on.
 * @param {number} options.port - listen port (`0` lets the OS choose).
 * @param {number} options.targetPort - loopback port to relay to.
 * @param {string} [options.targetHost] - loopback host to relay to.
 * @returns {Promise<{bound: {address: string, port: number}[], failures: {address: string, error: Error}[], close(): void}>}
 *   the authorities that bound, the ones that did not, and one disposer.
 */
export async function startForwarders({ addresses, port, targetPort, targetHost = LOOPBACK }) {
  const listening = []
  const failures = []
  const sockets = new Set()
  await Promise.all(addresses.map((address) => new Promise((resolve) => {
    const server = createServer((socket) => {
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
export const internals = { tailscaleIPv4, startForwarders, startPortable }

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
    // Connection activates against this service, so provide it before any await.
    ctx.provide('remoteBind', { authorities: addresses })
    const port = ctx.webServer.port
    if (port === undefined) throw new Error('dsh-remote: the webserver bound no port, so there is nothing to forward')
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
      for (const address of addresses) {
        const url = connectionCtx.connection.authenticatedUrl(`http://${address}:${port}`)
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
  // The URL's host is the tailnet name, so that name is the fence authority.
  ctx.provide('remoteBind', { authorities: [hostname] })
  ctx.effect(() => ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: '__DSH_TRANSPORT__', value: { ownsHost: true } })
  }), 'dsh-remote: remote operator transport')
  const extra = (process.env.DSH_REMOTE_PORTABLE_ARGS ?? '').split(/\s+/u).filter(Boolean)
  ctx.effect(() => internals.startPortable(ctx, { bin, hostname, port, extra }), 'dsh-remote: portable tailscale bridge')
}
