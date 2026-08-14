import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []
const script = join(process.cwd(), 'scripts', 'prepare-release.mjs')

function prepare(tag: string) {
  const directory = mkdtempSync(join(tmpdir(), 'omnimail-release-'))
  temporaryDirectories.push(directory)
  const output = join(directory, 'notes.md')
  const result = spawnSync(process.execPath, [script, tag, output], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  return { output, result }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('release metadata preparation', () => {
  it('extracts the matching web release section when the extension version differs', () => {
    const { output, result } = prepare('v0.2.4')

    expect(result.status).toBe(0)
    const notes = readFileSync(output, 'utf8')
    expect(notes).toContain('### 新增')
    expect(notes).toContain('官方浏览器扩展')
    expect(notes).toContain('OmniMail Float 保持')
    expect(notes).not.toContain('## [0.2.3]')
  })

  it('rejects a tag that does not match package metadata', () => {
    const { result } = prepare('v0.2.5')

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('does not match tag v0.2.5')
  })
})
