import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'package.json'), 'utf8')) as {
  name: string
  files: string[]
  dsh?: { bundle?: { patch?: string } }
}
assert.strictEqual(manifest.name, 'dsh-remote', 'package name identifies the bundle')
const patchRel = manifest.dsh?.bundle?.patch
assert(typeof patchRel === 'string' && patchRel.length > 0, 'package.json must declare dsh.bundle.patch')
const patchContent = readFileSync(join(import.meta.dirname, patchRel), 'utf8')
assert((manifest.files as string[]).includes(patchRel.replace(/^\.\//u, '')), 'files must ship the patch layer')
assert(patchContent.includes('id: webserver'), 'patch must contain id: webserver')
assert(patchContent.includes("host: '0.0.0.0'"), 'patch must bind host 0.0.0.0')
assert(patchContent.includes('port: !!js ctx.webStartup.port ?? 3080'), 'patch must preserve port')
assert(!/^ *- name:.*/mu.test(patchContent), 'a config-only bundle must reference no modules')
console.log('dsh-remote selfcheck: ok')
