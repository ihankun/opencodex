# Custom OpenCode Electron

Independent Electron frontend for local and remote OpenCode servers.

## Desktop capabilities

- Manage multiple local or remote servers, verify health and compatibility, and select a default server for new tasks.
- Choose the execution server, project, Git branch, approval profile, and current-directory or isolated-Worktree mode when creating a task.
- Run durable scheduled automations with retry, timeout, overlap, catch-up, concurrency, cancellation, retention, import, and export controls.
- Review session, turn, branch, and working-tree changes; stage, commit, fetch, fast-forward pull, push, stash, merge, and create draft or ready pull requests.
- Manage checkpoints, hooks, memory, MCP servers, skills, plugins, and expert kits from the application UI.
- Preview local development servers in isolated tabs with navigation history, port discovery, element references, screenshots, and external-browser fallback.

Remote plain HTTP endpoints require an explicit per-server opt-in. Credentials and sensitive hook output are redacted from application logs. The debug-log export includes runtime diagnostics but replaces user-data paths and recognized secrets.

## Development

```bash
bun electron:install
bun electron:dev
```

`electron:install` downloads the Electron runtime binary used by `electron-vite`.
The server binary is built with the same Bun compile as the official desktop bundle (`packages/cli/script/build.ts`, channel `local`), not the Node SEA output: inference rejects the Node runtime for the free models even with the same version and client identity. The app starts it as a managed background service (`serve --service`) using the same registration and readiness flow as the official desktop app. It registers under `<userData>/state/opencode` and stops when the app quits, so the TUI and the official desktop app keep their own services. `OPENCODE_DB` keeps the existing `opencode-opencodex.db` so the channel change does not hide recorded sessions.
The Electron renderer dev server starts from port `46237` instead of Vite's common `5173`.

macOS native notifications require a signed app bundle. The `electron:dev` runtime is not a normal signed `OpenCodex.app`, so test system notifications from a packaged build.

## Deep links

Packaged builds register the `opencodex://` protocol with two supported actions:

```text
opencodex://open-project?directory=%2Fpath%2Fto%2Fproject
opencodex://new-session?directory=%2Fpath%2Fto%2Fproject&prompt=Review%20this%20project
```

The directory must be an existing local folder. A `new-session` prompt is only placed in the composer and is never submitted automatically. Unknown actions, relative paths, duplicate parameters, and oversized inputs are rejected.

## Build

```bash
bun electron:build
bun electron:package
```

This repository currently requires `bun@^1.3.14` for the opencode server build scripts.

Run Electron checks from this package rather than the repository root:

```bash
cd packages/electron
bun typecheck
bun run test
bun run build
```

Packaging, signing, notarization, and application updates are separate release operations and are not required for local development builds.

## Skill marketplace

The skill marketplace uses SkillHub's public API for anonymous search and file downloads. It requires no account, token, or proxy service. Set `SKILLHUB_URL` only when developing against a compatible self-hosted SkillHub instance.
