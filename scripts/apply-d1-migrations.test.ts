import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const root = process.cwd()
const migrationScript = join(root, 'scripts', 'apply-d1-migrations.mjs')
const temporaryDirectories: string[] = []

const fakeWranglerSource = String.raw`
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const statePath = process.env.MOCK_D1_STATE_PATH
const callsPath = process.env.MOCK_D1_CALLS_PATH
const migrations = JSON.parse(process.env.MOCK_D1_MIGRATIONS)
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const isBootstrap = args.some((arg) => arg.endsWith('bootstrap-legacy-d1.sql'))
appendFileSync(callsPath, JSON.stringify(args) + '\n')

if (state.failure && isBootstrap) {
  process.stderr.write('Authentication error while accessing D1\n')
  process.exit(1)
}

if (args[1] === 'create') {
  state.exists = true
  writeFileSync(statePath, JSON.stringify(state))
  process.exit(0)
}

if (!state.exists && isBootstrap) {
  process.stderr.write(
    "Couldn't find an auto-provisioned D1 DB named 'omni-mail-db' for binding 'DB'. "
      + "Run 'wrangler deploy' to provision it.\n",
  )
  process.exit(1)
}

if (args.includes('SELECT name FROM d1_migrations ORDER BY name')) {
  const results = state.migrated ? migrations.map((name) => ({ name })) : []
  process.stdout.write(JSON.stringify([{ results }]))
  process.exit(0)
}

if (args.includes('--file') && !isBootstrap) {
  state.migrated = true
  writeFileSync(statePath, JSON.stringify(state))
}
`

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function runMigration(initialState: Record<string, boolean>) {
  const directory = mkdtempSync(join(tmpdir(), 'omnimail-migration-test-'))
  temporaryDirectories.push(directory)
  const wrangler = join(directory, 'wrangler.mjs')
  const statePath = join(directory, 'state.json')
  const callsPath = join(directory, 'calls.jsonl')
  const migrations = readdirSync(join(root, 'migrations'))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()
  writeFileSync(wrangler, fakeWranglerSource, 'utf8')
  writeFileSync(statePath, JSON.stringify(initialState), 'utf8')
  writeFileSync(callsPath, '', 'utf8')

  const result = spawnSync(process.execPath, [migrationScript, '--remote'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      OMNIMAIL_WRANGLER_CLI: wrangler,
      MOCK_D1_STATE_PATH: statePath,
      MOCK_D1_CALLS_PATH: callsPath,
      MOCK_D1_MIGRATIONS: JSON.stringify(migrations),
    },
  })
  const calls = readFileSync(callsPath, 'utf8').trim().split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[])
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, boolean>
  return { calls, result, state }
}

describe('remote D1 deployment migrations', () => {
  it('creates the auto-provisioned database before migrating a new deployment', () => {
    const { calls, result, state } = runMigration({ exists: false, migrated: false })

    expect(result.status).toBe(0)
    expect(calls.filter((args) => args[1] === 'create')).toEqual([
      ['d1', 'create', 'omni-mail-db', '--update-config=false'],
    ])
    expect(state).toMatchObject({ exists: true, migrated: true })
  })

  it('migrates an existing deployment without creating another database', () => {
    const { calls, result, state } = runMigration({ exists: true, migrated: false })

    expect(result.status).toBe(0)
    expect(calls.some((args) => args[1] === 'create')).toBe(false)
    expect(state.migrated).toBe(true)
  })

  it('does not treat other Wrangler failures as a missing first-deploy database', () => {
    const { calls, result } = runMigration({
      exists: false,
      migrated: false,
      failure: true,
    })

    expect(result.status).not.toBe(0)
    expect(calls.some((args) => args[1] === 'create')).toBe(false)
    expect(result.stderr).toContain('Authentication error while accessing D1')
  })
})
