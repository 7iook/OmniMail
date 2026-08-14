import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const [tag, outputPath] = process.argv.slice(2)
const match = /^v(\d+\.\d+\.\d+)$/.exec(tag || '')

if (!match || !outputPath) {
  throw new Error('Usage: node scripts/prepare-release.mjs vX.Y.Z <notes-path>')
}

const version = match[1]
const packageMetadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const packageLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
const extensionManifest = JSON.parse(readFileSync(
  join(root, 'extension/public/manifest.json'),
  'utf8',
))
const versions = {
  'package.json': packageMetadata.version,
  'package-lock.json': packageLock.version,
  'package-lock root package': packageLock.packages?.['']?.version,
  'extension manifest': extensionManifest.version,
}

for (const [source, actual] of Object.entries(versions)) {
  if (actual !== version) {
    throw new Error(`${source} version ${actual} does not match tag ${tag}`)
  }
}

const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  .replaceAll('\r\n', '\n')
const heading = `## [${version}]`
const headingStart = changelog.indexOf(heading)
if (headingStart < 0) throw new Error(`CHANGELOG.md is missing ${heading}`)

const contentStart = headingStart + heading.length
const nextHeading = changelog.indexOf('\n## [', contentStart)
const notes = changelog.slice(
  contentStart,
  nextHeading < 0 ? changelog.length : nextHeading,
).trim()
if (!notes) throw new Error(`CHANGELOG.md section ${heading} is empty`)

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, `${notes}\n`, 'utf8')
console.log(`Prepared release metadata for ${tag}`)
