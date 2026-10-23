import assert from 'node:assert'
import { readFileSync } from 'node:fs'
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
assert(patchContent.includes('id: webserver'), 'patch must contain id: webserver')
assert(patchContent.includes('host: \'0.0.0.0\''), 'patch must bind host 0.0.0.0')
assert(patchContent.includes('port: !!js ctx.webStartup.port ?? 3080'), 'patch must preserve port')

// The bundle now mounts a host plugin beside the bind override.
assert.match(patchContent, /- id: remote-operator\n\s+name: 'dsh-remote'/u, 'patch must insert the remote-operator row')
assert(typeof manifest.main === 'string' && manifest.main.length > 0, 'package.json must declare the plugin entry')
const entryFile = manifest.main.replace(/^\.\//u, '')
assert(manifest.files.includes(entryFile), 'files must ship the plugin entry')
const exported = typeof manifest.exports === 'string' ? manifest.exports : manifest.exports?.['.']
assert(exported !== undefined, 'package.json must export the plugin entry')

const plugin = await import(pathToFileURL(join(root, entryFile)).href) as {
  name: string
  inject: string[]
  apply(ctx: unknown): void
}
assert.strictEqual(plugin.name, 'dsh-remote', 'plugin name matches the row name')
assert(plugin.inject.includes('webServer'), 'plugin activates after the webserver it patches')

/** Minimal host context: capture index-inject listeners and run effects once. */
function fakeContext(host: '0.0.0.0' | '127.0.0.1') {
  const listeners: ((table: unknown[]) => void)[] = []
  return {
    ctx: {
      webServer: { host },
      on(_event: string, listener: (table: unknown[]) => void) {
        listeners.push(listener)
        return () => {}
      },
      effect(run: () => unknown) {
        return run()
      },
    },
    emit(table: unknown[]) {
      for (const listener of listeners) listener(table)
    },
  }
}

function injectedRows(host: '0.0.0.0' | '127.0.0.1'): unknown[] {
  const fake = fakeContext(host)
  plugin.apply(fake.ctx as never)
  const table: unknown[] = []
  fake.emit(table)
  return table
}

// An all-interfaces bind reaches browsers this host does not own, so the page
// must be told its operator owns the Host: that flag is what unlocks the
// settings and credential surfaces the browser otherwise keeps process-local.
assert.deepStrictEqual(
  injectedRows('0.0.0.0'),
  [{ kind: 'global', name: '__DSH_TRANSPORT__', value: { ownsHost: true } }],
  'an all-interfaces bind admits remote operators',
)
// A loopback bind keeps DSH's own privilege boundary: no transport override.
assert.deepStrictEqual(injectedRows('127.0.0.1'), [], 'a loopback bind injects nothing')
console.log('dsh-remote selfcheck: ok')
