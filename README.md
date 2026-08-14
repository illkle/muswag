# muswag

navidrome\opensubsonic client in development

The repository contains one Electron application. Its source is split into the
Electron processes under `src/main`, `src/preload`, and `src/renderer`, plus the
source-level `src/core` and `src/subsonic-api` modules.

```sh
pnpm install
pnpm dev
```

Unit tests are colocated with source files. Navidrome integration tests and the
sync benchmark live under `tests/` and run with `pnpm test:integration` and
`pnpm test:sync-benchmark` respectively.

### Mac — “muswag.app” is damaged and can’t be opened.

Apple is strict on running unsigned apps and signing them requires paid developer account.
Run these in terminal to self-sign and then launch

```
sudo xattr -d com.apple.quarantine /Applications/muswag.app

sudo codesign --force --deep --sign - /Applications/muswag.app
```
