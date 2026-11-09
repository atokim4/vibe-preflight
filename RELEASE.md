# Releasing

The repo is an Agent Skill, a Claude Code / Cursor plugin and a GitHub Action at once, so one version number
covers all of them.

## Every release

1. Bump the version in `package.json`, `src/report.ts`, `.claude-plugin/plugin.json` and
   `.cursor-plugin/plugin.json` (a test fails when they differ), and add a `CHANGELOG.md` entry.
2. `npm run check`, then commit the rebuilt `dist/index.js` and `skills/*/scripts/preflight.mjs`. The
   self-test workflow fails when the committed bundles don't match the source.
3. Push to `main` and wait for `self-test` to pass.

## GitHub release and Marketplace listing

Publishing to the Marketplace needs two-factor authentication on the account and the GitHub Marketplace
Developer Agreement accepted once; the Publish checkbox stays disabled without them.

1. Open `action.yml` on GitHub and click **Draft a release** in the banner (or Releases > Draft a new release).
2. Tick **Publish this Action to the GitHub Marketplace**. The page checks `action.yml` (name, description,
   branding) and must say everything looks good.
3. Primary category: **Security**. Secondary: **Code quality**.
4. Tag `v1.5.0` on `main`, title `v1.5.0`, notes from `CHANGELOG.md`. Publish.

## The `v1` tag

Workflows use `atokim4/vibe-preflight@v1`, so `v1` has to point at the newest 1.x release:

```bash
git tag -f v1 v1.5.0
git push -f origin v1
```

Do it after every 1.x release. Without command-line access, delete the `v1` tag on the Tags page and draft a
release that creates it again on the same commit (not published to the Marketplace, not marked latest). A
breaking change to inputs, outputs or exit codes gets `v2` instead.
