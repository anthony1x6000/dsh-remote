import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const patchContent = readFileSync(join(import.meta.dirname, 'cordis.patch.yml'), 'utf8')
assert(patchContent.includes('id: webserver'), 'patch must contain id: webserver')
assert(patchContent.includes("host: '0.0.0.0'"), 'patch must bind host 0.0.0.0')
assert(patchContent.includes('port: !!js ctx.webStartup.port ?? 3080'), 'patch must preserve port')
console.log('dsh-remote selfcheck: ok')
