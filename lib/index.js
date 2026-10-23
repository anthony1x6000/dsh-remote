/**
 * Remote-operator host half for the dsh-remote bundle.
 *
 * DSH keeps the settings and credential surfaces loopback-only: a served page
 * off loopback reports `connection.isLoopback === false`, creates the settings
 * mirror in memory mode, and never reads or writes the Host document. The only
 * sanctioned way past that gate is the transport global the desktop shell
 * sets — `__DSH_TRANSPORT__ = { ownsHost: true }` — which declares that the
 * page owns the Host it talks to.
 *
 * This plugin injects exactly that global into the served index whenever the
 * webserver binds all interfaces, so a LAN browser edits models and API keys
 * as the operator does. A loopback bind is left untouched: DSH's own boundary
 * stays in force for the local GUI.
 *
 * Request admission is unchanged. The /api Host fence still refuses foreign
 * authorities, and the launch token plus signed session cookie still
 * authenticate every browser. Credential reads stay redacted, so storing keys
 * remotely is possible while reading their values back is not.
 *
 * @module dsh-remote
 */

/** Stable Cordis plugin name; the bundle patch inserts this row by it. */
export const name = 'dsh-remote'

/** Activate after the webserver whose bind decides whether to inject. */
export const inject = ['webServer']

/** The webserver literal for an all-interfaces bind. */
const ALL_INTERFACES_HOST = '0.0.0.0'

/**
 * Inject the operator transport global when this deployment serves browsers on
 * other machines.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 */
export function apply(ctx) {
  if (ctx.webServer.host !== ALL_INTERFACES_HOST) return
  ctx.effect(() => ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: '__DSH_TRANSPORT__', value: { ownsHost: true } })
  }), 'dsh-remote: remote operator transport')
}
