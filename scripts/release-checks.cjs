const { spawnSync } = require('node:child_process')

function capture (cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: false })
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || '').trim()
    throw new Error(detail || `${cmd} ${args.join(' ')} failed`)
  }
  return r.stdout.trim()
}

function assertCleanTree (root) {
  const status = capture('git', ['status', '--porcelain'], root)
  if (status !== '') {
    throw new Error('Working tree is not clean. Commit or stash changes before publishing.')
  }
}

function assertHeadHasTag (root, tag) {
  const tags = capture('git', ['tag', '--points-at', 'HEAD'], root).split('\n').filter(Boolean)
  if (!tags.includes(tag)) {
    throw new Error(`HEAD must be tagged ${tag} before publishing. Run: git tag ${tag} && git push origin ${tag}`)
  }
}

function assertRemoteHasTag (root, tag) {
  try {
    capture('git', ['ls-remote', '--exit-code', '--tags', 'origin', tag], root)
  } catch {
    throw new Error(`Tag ${tag} must be pushed to origin before publishing. Run: git push origin ${tag}`)
  }
}

function assertReleaseChannel (version, channel) {
  const prerelease = version.includes('-')
  if (channel === 'stable' && prerelease) {
    throw new Error(`Stable release cannot publish prerelease version ${version}`)
  }
  if (channel === 'beta' && !prerelease) {
    throw new Error(`Beta release expects a prerelease version, got ${version}`)
  }
}

function assertPublishReady ({ root, version, channel }) {
  assertReleaseChannel(version, channel)
  assertCleanTree(root)
  const tag = `v${version}`
  assertHeadHasTag(root, tag)
  assertRemoteHasTag(root, tag)
}

module.exports = { assertPublishReady }
