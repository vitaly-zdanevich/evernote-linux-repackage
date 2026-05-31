# Release Process

This project publishes rebuilt AppImages from the pinned Evernote installer in
`.github/workflows/ci.yml`.

## Tag Naming

Use tags in this format:

```text
v<evernote-version>-<package-revision>
```

Example:

```text
v11.18.1-1
```

Use the Evernote desktop version for `<evernote-version>`. Increase
`<package-revision>` when only this repackaging project changes, for example CI,
patcher, README, AppImage packaging, or release metadata changes.

## Before Tagging

Run local checks:

```bash
npm run check
npm test
npm run verify
```

If you rebuilt locally, smoke-test the unpacked bundle and AppImage:

```bash
npm run smoke
APPIMAGE_EXTRACT_AND_RUN=1 \
EVERNOTE_SMOKE_EXECUTABLE=dist/Evernote-<version>-x86_64.AppImage \
npm run smoke
scripts/smoke-test-clean-container.sh dist/Evernote-<version>-x86_64.AppImage x86_64
```

Confirm `.github/workflows/ci.yml` still pins:

- Evernote installer SHA-256
- expected Evernote version
- expected Electron version
- Electron zip SHA-256 for each architecture
- appimagetool SHA-256 for each architecture
- AppImage runtime SHA-256 for each architecture

## Creating A Release

Create and push a tag:

```bash
git tag -a v11.18.1-1 -m "evernote-linux-repackage v11.18.1-1"
git push origin v11.18.1-1
```

The tag workflow runs:

- `test`
- `build pinned (x86_64)`
- `build pinned (aarch64)`
- `build latest canary (x86_64)`, allowed to fail
- `build latest canary (aarch64)`, allowed to fail
- `release`

The release job publishes the pinned build artifacts only.

## Release Assets

The GitHub release should contain:

```text
Evernote-<tag>-x86_64.AppImage
Evernote-<tag>-aarch64.AppImage
build-info-x86_64.json
build-info-aarch64.json
SHA256SUMS
```

The `build-info-*.json` files record the upstream Evernote installer URL,
Evernote installer SHA-256, Evernote version, Electron version, Electron zip
SHA-256, and target architecture used for each AppImage.

The release notes must keep the unofficial/proprietary redistribution warning.
The CI release job writes this warning automatically.

## Verifying Checksums

Download the AppImage and `SHA256SUMS` into the same directory, then run:

```bash
sha256sum -c SHA256SUMS
```

Expected output includes:

```text
Evernote-<tag>-x86_64.AppImage: OK
Evernote-<tag>-aarch64.AppImage: OK
```

If you download only one architecture, `sha256sum` may report the other AppImage
as missing. That is not a failure for the file you did download; either download
all listed files or verify the single digest manually from `SHA256SUMS`.

## Verifying GitHub Attestations

Install GitHub CLI and authenticate it, then run from the directory containing
the downloaded AppImage:

```bash
gh attestation verify Evernote-<tag>-x86_64.AppImage -R <owner>/<repo>
gh attestation verify Evernote-<tag>-aarch64.AppImage -R <owner>/<repo>
```

For this repository after publication, replace `<owner>/<repo>` with the real
GitHub repository name.

A successful attestation proves the artifact was produced by this repository's
GitHub Actions workflow. It does not make Evernote official, open source, or
audited by this project.

## After Publishing

Check the release page:

- both AppImages are present
- both `build-info-*.json` files are present
- `SHA256SUMS` verifies downloaded files
- `gh attestation verify` succeeds for each AppImage
- the release notes include the unofficial/proprietary warning

If a release is bad, prefer creating a new package revision tag such as
`v11.18.1-2` instead of replacing files silently.
