# Release process

This repository publishes two artifacts from the same release commit:

- npm package: `@yoch/frozenminisearch`
- GitHub Pages documentation: <https://yoch.github.io/frozenminisearch/>

GitHub Pages is built by CI from release tags. Do not commit generated `docs/`
HTML; the versioned site is produced from the tagged commit.

## Prerequisites

- Node 24 and the pnpm version pinned in `package.json` (`packageManager`).
- An npm account with publish rights on the `@yoch` scope, with two-factor
  authentication enabled.
- Push access to `master` and to release tags on `origin`.

Since pnpm 12, `pnpm publish` talks to the registry itself instead of
delegating to the npm CLI, so it does not trigger the npm CLI's browser login.
Authenticate with `pnpm login` before each publication: login sessions are
short-lived, and a session from an earlier release is usually expired.

## Stable release

1. Choose the version. New public API or behavior is a minor release; fixes
   and internal changes without search-semantics changes are a patch release.
2. Update `package.json` and `CHANGELOG.md`. Rename `## Unreleased` to
   ``## vX.Y.Z — `@yoch/frozenminisearch` ``, add a one-paragraph summary
   (release type, highlights, and compatibility: search semantics, MSv5 wire
   format, Node support), and restore an empty `## Unreleased` above it.
3. Run local verification:

   ```bash
   pnpm test
   pnpm build
   pnpm test:runtime
   node scripts/verify-npm-pack.cjs
   pnpm docs:build
   ```

4. Commit the release changes (`Release X.Y.Z.`).
5. Create an annotated tag on the release commit and push both:

   ```bash
   git tag -a vX.Y.Z -m vX.Y.Z
   git push origin master
   git push origin vX.Y.Z
   ```

   Pushing the `vX.Y.Z` tag deploys GitHub Pages. The site header is built as
   `@yoch/frozenminisearch vX.Y.Z`.

6. Wait for the **Docs** workflow to pass for the tag, and for **CI Build** to
   pass on `master`.
7. Authenticate and publish from the same tagged commit:

   ```bash
   pnpm login
   pnpm release:stable
   ```

8. Check the published dist-tags on the registry directly; `npm view` may show
   a cached `latest` for a few minutes:

   ```bash
   curl -s https://registry.npmjs.org/-/package/@yoch%2ffrozenminisearch/dist-tags
   ```

The publish script refuses to publish if the working tree is dirty, if `HEAD`
is not tagged with the exact `vX.Y.Z` tag from `package.json`, or if that tag
has not been pushed to `origin`. `prepublishOnly` then runs the tests, the
build, and the bundle and package-content checks.

## Beta release

Use the same flow with a prerelease version, for example `1.2.0-beta.1`, then:

```bash
git tag -a v1.2.0-beta.1 -m v1.2.0-beta.1
git push origin HEAD
git push origin v1.2.0-beta.1
pnpm login
pnpm release:beta
```

Beta tags also deploy the docs because the workflow intentionally matches `v*`.
The `beta` dist-tag moves; `latest` does not.

## Troubleshooting publication

- **`ERR_PNPM_FAILED_TO_PUBLISH … 404 Not Found`**: the request was not
  authenticated, usually because the login session expired. The registry
  answers 404 rather than 401 for unauthorized writes to a scoped package. Run
  `pnpm login`, then publish again.
- **One-time password required**: run the publish script directly, which keeps
  the release checks and passes extra arguments to `pnpm publish`:
  `node scripts/publish-stable.cjs --otp=123456` (or `publish-beta.cjs`).
- **Publication failed after the tag was pushed**: the version is not taken
  until the registry accepts it. Fix authentication and rerun from the same
  tagged commit; do not move or recreate the tag. If the release commit itself
  needs changes, release the next patch version instead.

## Docs-only redeploy

Prefer release tags for published documentation. If a Pages redeploy is needed
without a new release, run the **Docs** workflow manually from GitHub Actions;
the version banner falls back to `package.json`.
