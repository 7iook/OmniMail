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
    const result = prepare('v0.2.5')

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('v0.2.5.md')
    const notes = readFileSync(
      join(process.cwd(), 'docs', 'releases', 'web', 'v0.2.5.md'),
      'utf8',
    )
    expect(notes).toContain('### 新增')
    expect(notes).toContain('邮箱地址管理')
    expect(notes).toContain('随机邮箱固定前缀')
    expect(notes).toContain('OmniMail Float 扩展版本统一为 `0.2.5`')
  })

  it('rejects a tag that does not match package metadata', () => {
    const result = prepare('v0.2.6')

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('does not match tag v0.2.6')
  })
})
