#!/usr/bin/env node
/**
 * Build TypeDoc site: verify (local/PR) or pages (GitHub Pages release deploy).
 * The home page gets a specific <title> and the package.json description as meta description.
 *
 * Env:
 *   DOCS_PAGES=1  — basePath, hostedBaseUrl, version in header title
 *   DOCS_VERSION  — semver for --name (defaults to package.json version)
 */
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = process.env.DOCS_VERSION || pkg.version
const pages = process.env.DOCS_PAGES === '1'
const hostedBaseUrl = 'https://yoch.github.io/frozenminisearch/'
const homeTitle = 'FrozenMiniSearch – low-memory, MiniSearch-compatible full-text search'

function run (cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: false })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

function escapeHtml (text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function replaceOnce (text, pattern, replacement, what) {
  const found = typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text)
  if (!found) {
    console.error(`build-docs: ${what} not found (TypeDoc output changed?)`)
    process.exit(1)
  }
  return text.replace(pattern, replacement)
}

// TypeDoc 0.28 has no option for the home page <title> or meta description
// ("Documentation for <name>"), so set them after rendering.
function setHomeMetadata () {
  const indexHtml = join(root, 'docs', 'index.html')
  let html = readFileSync(indexHtml, 'utf8')
  html = replaceOnce(html, /<title>[^<]*<\/title>/, `<title>${escapeHtml(homeTitle)}</title>`, '<title>')
  html = replaceOnce(html, /<meta name="description" content="[^"]*"\/>/,
    `<meta name="description" content="${escapeHtml(pkg.description)}"/>`, 'meta description')
  writeFileSync(indexHtml, html)
}

// --hostedBaseUrl emits sitemap.xml and the home canonical link. List the home page
// under its canonical URL and add the demo, which TypeDoc does not know about.
function fixSitemap () {
  const sitemap = join(root, 'docs', 'sitemap.xml')
  if (!existsSync(sitemap)) return
  let xml = readFileSync(sitemap, 'utf8')
  xml = replaceOnce(xml, `<loc>${hostedBaseUrl}index.html</loc>`, `<loc>${hostedBaseUrl}</loc>`, 'sitemap home')
  xml = replaceOnce(xml, '</urlset>',
    `\t<url>\n\t\t<loc>${hostedBaseUrl}demo/</loc>\n\t</url>\n</urlset>`, 'sitemap end')
  writeFileSync(sitemap, xml)
}

const typedocBin = join(root, 'node_modules', 'typedoc', 'bin', 'typedoc')
const typedocArgs = [typedocBin, '--options', 'typedoc.json']
if (pages) {
  typedocArgs.push(
    '--basePath', '/frozenminisearch/',
    '--hostedBaseUrl', hostedBaseUrl,
    '--name', `@yoch/frozenminisearch v${version}`,
  )
}

run(process.execPath, typedocArgs)
setHomeMetadata()
fixSitemap()
run(process.execPath, [join(root, 'scripts', 'sync-docs-media.cjs')])
run(process.execPath, [join(root, 'scripts', 'build-demo.cjs')])
