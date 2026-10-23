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

import { networkInterfaces } from 'node:os'
import { connect, createServer } from 'node:net'

/** Stable Cordis plugin name; the bundle patch inserts this row by it. */
export const name = 'dsh-remote'

/** Activate after the webserver whose port this forwards. */
export const inject = ['webServer']

/** The listener every forwarded connection is relayed to. */
const LOOPBACK = '127.0.0.1'

/**
 * The local addresses this deployment serves on.
 * @returns every non-internal IPv4 address of a Tailscale interface.
 */
function tailscaleIPv4() {
  return Object.entries(networkInterfaces())
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
export const internals = { tailscaleIPv4, startForwarders }

/**
 * Mount tailnet forwarding, the fence authorities, and the operator transport
 * global when this machine has a Tailscale address.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 */
export function apply(ctx) {
  const addresses = internals.tailscaleIPv4()
  // Connection activates against this service, so provide it before any await.
  ctx.provide('remoteBind', { authorities: addresses })
  if (addresses.length === 0) return
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
}
