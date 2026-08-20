import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const script = join(process.cwd(), 'scripts', 'prepare-release.mjs')

function prepare(tag: string) {
  return spawnSync(process.execPath, [script, tag], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
}

describe('release metadata preparation', () => {
  it('validates the matching versioned release notes file', () => {
    const result = prepare('v0.3.4')

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('v0.3.4.md')
    const notes = readFileSync(
      join(process.cwd(), 'docs', 'releases', 'web', 'v0.3.4.md'),
      'utf8',
    )
    expect(notes).toContain('### 修复')
    expect(notes).toContain('未开通 iCloud+')
    expect(notes).toContain('iCloud')
    expect(notes).toContain('无需新增 D1 迁移')
    expect(notes).toContain('OmniMail Float 修复版本独立发布')
  })

  it('rejects a tag that does not match package metadata', () => {
    const result = prepare('v0.3.5')

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('does not match tag v0.3.5')
  })
})
