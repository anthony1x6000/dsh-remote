import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const patchContent = readFileSync(join(import.meta.dirname, 'cordis.patch.yml'), 'utf8')
assert(patchContent.includes('id: webserver'), 'patch must contain id: webserver')
assert(patchContent.includes("host: '0.0.0.0'"), 'patch must bind host 0.0.0.0')
assert(patchContent.includes('port: !!js ctx.webStartup.port ?? 3080'), 'patch must preserve port')

// The README install one-liner must survive a base-install `[]` patch file.
// The shell body is extracted straight from the README so docs and behavior
// cannot drift, then run against temp HOMEs (missing file, base `[]`
// template, and a rerun for idempotency).
const readme = readFileSync(join(import.meta.dirname, 'README.md'), 'utf8')
const oneliner = readme.split('\n').find((line) => line.startsWith('mkdir -p ') && line.includes('cordis.patch.yml'))
assert(oneliner !== undefined, 'README must contain the install one-liner')
function runInstaller(initial?: string): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-remote-install-'))
  const dir = join(home, '.dsh', 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  const patchPath = join(dir, 'cordis.patch.yml')
  if (initial !== undefined) writeFileSync(patchPath, initial)
  execFileSync('bash', ['-c', oneliner], { env: { ...process.env, HOME: home } })
  return readFileSync(patchPath, 'utf8')
}
const BASE_PATCH = '# Your patch layer for this dsh profile.\n[]\n'
for (const initial of [undefined, BASE_PATCH]) {
  const out = runInstaller(initial)
  assert.strictEqual(out.match(/id: webserver/gu)?.length ?? 0, 1, 'exactly one webserver block')
  assert(out.includes("host: '0.0.0.0'"), 'installed patch must bind host 0.0.0.0')
  assert(!/^\[\]\s*$/mu.test(out), 'base `[]` must be gone')
}
{
  const home = mkdtempSync(join(tmpdir(), 'dsh-remote-install-'))
  const dir = join(home, '.dsh', 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  const env = { ...process.env, HOME: home }
  execFileSync('bash', ['-c', oneliner], { env })
  execFileSync('bash', ['-c', oneliner], { env })
  const out = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
  assert.strictEqual(out.match(/id: webserver/gu)?.length ?? 0, 1, 'rerun must not duplicate the block')
}
console.log('dsh-remote selfcheck: ok')
