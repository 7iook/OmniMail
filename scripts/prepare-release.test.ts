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
    const result = prepare('v0.5.3')

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('v0.5.3.md')
    const notes = readFileSync(
      join(process.cwd(), 'docs', 'releases', 'web', 'v0.5.3.md'),
      'utf8',
    )
    expect(notes).toContain('自动检查是否存在新版本')
    expect(notes).toContain('iCloud 主邮箱')
    expect(notes).toContain('无需新增 D1 迁移')
    expect(notes).toContain('OmniMail Float 扩展包或 Android 安装包')
  })

  it('rejects a tag that does not match package metadata', () => {
    const result = prepare('v0.5.4')

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('does not match tag v0.5.4')
  })
})
