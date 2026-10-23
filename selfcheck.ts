import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = import.meta.dirname

interface Manifest {
  name: string
  main?: string
  exports?: Record<string, unknown> | string
  files: string[]
  dsh?: { bundle?: { patch?: string } }
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Manifest
assert.strictEqual(manifest.name, 'dsh-remote', 'package name identifies the bundle')
const patchRel = manifest.dsh?.bundle?.patch
assert(typeof patchRel === 'string' && patchRel.length > 0, 'package.json must declare dsh.bundle.patch')
const patchContent = readFileSync(join(root, patchRel), 'utf8')
const patchFile = patchRel.replace(/^\.\//u, '')
assert(manifest.files.includes(patchFile), 'files must ship the patch layer')

// DSH rejects a wildcard bind outright, so the bundle must not rewrite the
// webserver row; it forwards the tailnet address to DSH's own loopback listener.
assert(!patchContent.includes('id: webserver'), 'patch must leave the webserver row alone')
assert(!patchContent.includes('0.0.0.0'), 'patch must never request a wildcard bind')
// The forwarder's authority is not the webserver's bind IP, so the /api fence
// has to be told about it or every tailnet request answers 403.
assert.match(patchContent, /- id: connection\n\s+inject: \[webStartup, remoteBind\]/u, 'connection must wait for the forwarder authorities')
assert.match(patchContent, /trustedHosts: !!js "\[\.\.\.ctx\.webStartup\.trustedHosts, \.\.\.ctx\.remoteBind\.authorities\]"/u, 'connection must trust the forwarded authorities')
// The entry-list dialect tags SCALARS: `!!js [...]` would tag a sequence node
// and fail install validation with `unknown tag`.
assert(!/!!js\s*\[/u.test(patchContent), '!!js expressions must be quoted scalars, not tagged sequences')
assert.match(patchContent, /- id: remote-operator\n\s+name: 'dsh-remote'/u, 'patch must insert the remote-operator row')

assert(typeof manifest.main === 'string' && manifest.main.length > 0, 'package.json must declare the plugin entry')
const entryFile = manifest.main.replace(/^\.\//u, '')
assert(manifest.files.includes(entryFile), 'files must ship the plugin entry')
const exported = typeof manifest.exports === 'string' ? manifest.exports : manifest.exports?.['.']
assert(exported !== undefined, 'package.json must export the plugin entry')

type Forwarders = {
  bound: { address: string, port: number }[]
  failures: { address: string, error: Error }[]
  close(): void
}
interface ForwarderOptions {
  addresses: string[]
  port: number
  targetPort: number
}

const plugin = await import(pathToFileURL(join(root, entryFile)).href) as {
  name: string
  inject: string[]
  apply(ctx: unknown): void
  startForwarders(options: ForwarderOptions): Promise<Forwarders>
  tailscaleIPv4(interfaces?: Record<string, { address: string, family: string, internal: boolean }[]>): string[]
  internals: {
    tailscaleIPv4(): string[]
    startForwarders(options: ForwarderOptions): Promise<Forwarders>
  }
}
assert.strictEqual(plugin.name, 'dsh-remote', 'plugin name matches the row name')
assert(plugin.inject.includes('webServer'), 'plugin activates after the webserver it forwards to')

// Only Tailscale interfaces count, and only their IPv4 rows: a LAN address or
// a tailnet IPv6 row must not become a forwarded authority.
assert.deepStrictEqual(plugin.tailscaleIPv4({
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  ens18: [{ address: '192.168.0.138', family: 'IPv4', internal: false }],
  tailscale0: [
    { address: '100.92.191.33', family: 'IPv4', internal: false },
    { address: 'fd7a:115c:a1e0::ae01:bfd5', family: 'IPv6', internal: false },
  ],
}), ['100.92.191.33'], 'only tailscale IPv4 rows are forwarded')

/** Minimal host context: capture index-inject listeners, provide, and effects. */
function fakeContext(addresses: string[]) {
  plugin.internals.tailscaleIPv4 = () => addresses
  // The forwarder has its own end-to-end case above; the apply cases only
  // assert the table, the provided authorities, and the printed URLs.
  plugin.internals.startForwarders = async () => ({ bound: [], failures: [], close() {} })
  const listeners: ((table: unknown[]) => void)[] = []
  const provided = new Map<string, unknown>()
  const ctx = {
    webServer: { host: '127.0.0.1', port: 3080 },
    provide(name: string, value: unknown) {
      provided.set(name, value)
    },
    on(_event: string, listener: (table: unknown[]) => void) {
      listeners.push(listener)
      return () => {}
    },
    effect(run: () => unknown) {
      return run()
    },
    inject(_services: string[], _run: (ctx: unknown) => void) {
      return () => {}
    },
  }
  return {
    ctx,
    provided,
    emit(table: unknown[]) {
      for (const listener of listeners) listener(table)
    },
  }
}

/** Start a loopback echo server so the forwarder can be exercised end to end. */
async function echoServer() {
  const sockets = new Set<import('node:net').Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.pipe(socket)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('echo server has no port')
  return {
    port: address.port,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}

const echo = await echoServer()
try {
  const forwarder = await plugin.startForwarders({ addresses: ['127.0.0.1'], port: 0, targetPort: echo.port })
  assert.deepStrictEqual(forwarder.failures, [], 'the loopback authority binds')
  assert.strictEqual(forwarder.bound.length, 1, 'one listener per authority')
  const bound = forwarder.bound[0]
  assert.strictEqual(bound.address, '127.0.0.1')
  const reply = await new Promise<string>((resolve, reject) => {
    const client = connect(bound.port, '127.0.0.1')
    const chunks: Buffer[] = []
    client.once('error', reject)
    client.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      if (Buffer.concat(chunks).toString('utf8') === 'ping') {
        client.end()
        resolve('ping')
      }
    })
    client.write('ping')
  })
  assert.strictEqual(reply, 'ping', 'forwarder relays bytes to the loopback listener')
  forwarder.close()
} finally {
  await echo.close()
}

const tailnet = fakeContext(['100.64.0.7'])
plugin.apply(tailnet.ctx as never)
assert.deepStrictEqual(tailnet.provided.get('remoteBind'), { authorities: ['100.64.0.7'] }, 'the fence learns the forwarded authority')
const rows: unknown[] = []
tailnet.emit(rows)
// A tailnet browser is the operator: the page must be told it owns the Host,
// which is what unlocks host-persisted settings and credential writes.
assert.deepStrictEqual(rows, [{ kind: 'global', name: '__DSH_TRANSPORT__', value: { ownsHost: true } }], 'a tailnet address admits remote operators')

const offline = fakeContext([])
plugin.apply(offline.ctx as never)
const noRows: unknown[] = []
offline.emit(noRows)
assert.deepStrictEqual(noRows, [], 'without a tailnet address nothing is injected')
assert.deepStrictEqual(offline.provided.get('remoteBind'), { authorities: [] }, 'an empty authority list keeps the fence closed')

console.log('dsh-remote selfcheck: ok')
