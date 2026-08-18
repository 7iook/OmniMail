import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const wranglerCli = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const mode = process.argv[2]

if (mode !== '--remote' && mode !== '--local') {
  throw new Error('Usage: node scripts/apply-d1-migrations.mjs --remote|--local')
}

function runWrangler(args, capture = false) {
  const result = spawnSync(process.execPath, [wranglerCli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
    stdio: capture ? 'pipe' : 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    if (capture) process.stderr.write(result.stderr)
    throw new Error(`Wrangler exited with code ${result.status}`)
  }
  return result.stdout
}

function migrationNames() {
  return readdirSync(join(root, 'migrations'))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()
}

function appliedMigrationNames() {
  const output = runWrangler([
    'd1', 'execute', 'DB', '--remote',
    '--command', 'SELECT name FROM d1_migrations ORDER BY name',
    '--json',
  ], true)
  const response = JSON.parse(output)
  return new Set(response[0]?.results?.map(({ name }) => name) ?? [])
}

function migrationImport(names) {
  return names.map((name) => {
    const sql = readFileSync(join(root, 'migrations', name), 'utf8').trimEnd()
    const escapedName = name.replaceAll("'", "''")
    return `${sql}\nINSERT INTO d1_migrations (name) VALUES ('${escapedName}');`
  }).join('\n\n') + '\n'
}

runWrangler([
  'd1', 'execute', 'DB', mode,
  '--file', 'scripts/bootstrap-legacy-d1.sql',
])

if (mode === '--local') {
  runWrangler(['d1', 'migrations', 'apply', 'DB', '--local'])
} else {
  const applied = appliedMigrationNames()
  const pending = migrationNames().filter((name) => !applied.has(name))
  if (pending.length === 0) {
    console.log('✅ No migrations to apply!')
  } else {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'omnimail-d1-'))
    const importPath = join(temporaryDirectory, 'migrations.sql')
    try {
      writeFileSync(importPath, migrationImport(pending), 'utf8')
      runWrangler(['d1', 'execute', 'DB', '--remote', '--file', importPath])
      const completed = appliedMigrationNames()
      const missing = pending.filter((name) => !completed.has(name))
      if (missing.length > 0) {
        throw new Error(`D1 migrations were not recorded: ${missing.join(', ')}`)
      }
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  }
}
