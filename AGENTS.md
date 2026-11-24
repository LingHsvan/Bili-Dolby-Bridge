# Repository Guidelines

## Project Structure & Module Organization

This repository is an unpacked Chrome/Edge Manifest V3 extension; source files
live at the repository root. `manifest.json` defines permissions and entry
points. `content.js` runs in the isolated world, while `page-bridge.js` runs in
the page's main world. `background.js` handles service-worker messages,
`storage.js` centralizes settings and status, and `popup.html`/`options.html`
with their scripts provide the UI. There are currently no tests or asset
directories. Keep build artifacts outside the repository.

## Build, Test, and Development Commands

No compilation or package manager is required. Run these checks from the root:

```powershell
Get-ChildItem -Filter *.js | ForEach-Object { node --check $_.FullName }
Get-Content -Raw manifest.json | ConvertFrom-Json | Out-Null
git diff --check
```

Load the repository through `chrome://extensions` or `edge://extensions` with
Developer mode enabled. After modifying a MAIN-world script, reload the
extension and then refresh Bilibili; existing tabs do not receive the new
script automatically.

## Coding Style & Naming Conventions

Use strict-mode ES2022 JavaScript, two-space indentation, semicolons, double
quotes, and trailing commas where applicable. Prefer `const`, small arrow
functions, and explicit names. Use `camelCase` for variables/functions,
`UPPER_SNAKE_CASE` for constants, and `bili-dolby-bridge:*` for message events.
Keep cross-context messages as plain, serializable data. No formatter or linter
is configured, so match the surrounding file and avoid unrelated refactors.

## Testing Guidelines

No automated test framework or coverage target is checked in. Validate changes
in both Chrome and Edge, including a full page refresh and the extension error
page. For audio changes, confirm that a real media request or player response
contains track `30250`; writing a preference alone is not proof of Dolby
playback. Test logged-out behavior and account/entitlement restrictions. In
pull requests, include the observed track ID and any relevant errors.

## Architecture & Safety

Do not introduce credential collection or logic that bypasses membership,
copyright, regional, or account restrictions. Keep messages origin-checked and
idempotent because injected scripts may run more than once.

## Commit & Pull Request Guidelines

Follow the existing Conventional Commits style, for example
`feat: add Bili Dolby Bridge extension` or `fix: preserve page state`.
Keep commits focused. Pull requests should include the behavior change, linked
issue (if any), validation evidence for both browsers, and screenshots for UI
changes. Update the README and manifest version when behavior or release
contents change.
