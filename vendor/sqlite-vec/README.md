# Vendored sqlite-vec binaries

`bin/` holds the [sqlite-vec](https://github.com/asg017/sqlite-vec) loadable extension for each supported platform, committed so that the plugin runs without any `npm install` (Claude Code installs plugin dependencies with `--ignore-scripts`, and the plugin should not depend on that install at all).

- Versions are pinned by `package-lock.json` in this folder. Claude Code never installs it (it only installs the plugin root `package.json`); Dependabot watches it.
- `npm run vendor` downloads each platform package from the URL in the lockfile, checks it against the lockfile's sha512 integrity, extracts the binary and writes `manifest.json` (package, integrity and sha256 of each file).
- `npm run vendor:check` (run by CI) re-downloads and verifies that the committed binaries are exactly the ones from those packages.

| Folder | npm package | Loaded on |
|---|---|---|
| `windows-x64` | `sqlite-vec-windows-x64` | Windows x64 |
| `linux-x64` | `sqlite-vec-linux-x64` | Linux x64 |
| `darwin-x64` | `sqlite-vec-darwin-x64` | macOS Intel |
| `darwin-arm64` | `sqlite-vec-darwin-arm64` | macOS Apple Silicon |

Linux arm64 is not supported: `sqlite-vec-linux-arm64` is not published for the pinned version.

sqlite-vec is licensed MIT OR Apache-2.0 by Alex Garcia.
