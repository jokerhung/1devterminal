# Plan: per-session CODEX_HOME for Codex UI

Status: implemented (spike confirmed: CODEX_HOME works with copied config/auth, linked sessions, per-home hook trust). Trust is recomputed per home; no template. Flag: NREMOTE_CODEX_SHARED_HOME=1 restores the shared home.

## Problem

Opening several Codex UI chats / terminals at once makes codex fail with
`failed to load configuration` (config.toml unreadable or invalid TOML).

`~/.codex/config.toml` is one shared file with no lock, and many writers do
non-atomic read-modify-write on it:

- 9remote: `host/mcp/mcpConfig.js` (`enable`/`disable`, `writeFileSync`),
  `host/features/terminal/hookManager.js` (`upsertCodexTrust`, `dropCodexTrust`,
  `dropLegacyCodexNotify`), run at startup via `autoEnableInstalledHooks` /
  `reconcileCodexTrust` (`terminalSocket.js`).
- codex itself (one process per chat; `app-server` writes `[projects.*]`,
  `[hooks.state.*]`, `[tui.*]`), and it already quarantines broken files as
  `config.toml.invalid-toml.<ts>` / `config.toml.bakN`.
- Other tools: computer-use plugin (`notify`, `SKY_CUA_*`), Cockpit Tools
  (`model_provider`), 1DevTool (`notify`).

`retryCodexConfig` (`host/features/ai/codexConfigRecovery.js`) only retries after
the failure; it does not remove the race.

## Idea

Give every Codex UI chat its own `CODEX_HOME` directory and spawn codex with
`CODEX_HOME=<that dir>`. Only that one codex process (plus 9remote, once, at
creation) touches that `config.toml`, so there is nothing to race on.

Codex already honours `CODEX_HOME`; 9remote already reads it in `models.js`,
`transcript.js`, `agentHistory.js`, `codexFetcher.js`.

## Scope

In: codex processes spawned for the Codex UI chat:
- `LocalProc.start` via `CodexAdapter` / `CodexAppServer`
  (`host/features/ai/adapters/codexAdapter.js`, `proc/localProc.js`, daemon carrier)
- `host/features/ai/goal.js` (`codex app-server` one-shot) — must use the same home
  as the chat whose thread it reads.

Out (unchanged, still `~/.codex`): codex typed by the user in a PTY terminal,
`codexFetcher` quota check, `codex doctor`.

## Design

### Layout

```
~/.9remote/codexHomes/
  <chatId>/              # = CODEX_HOME for that chat
    config.toml          # copy of ~/.codex/config.toml (+ 9remote edits)
    hooks.json           # copy of ~/.codex/hooks.json
    auth.json            # copy of ~/.codex/auth.json
    sessions/            # junction/symlink -> ~/.codex/sessions
    (everything else codex creates: logs, sqlite state, cache)
```

### New module `host/features/ai/codexHome.js`

- `prepareCodexHome(chatId)` → returns dir. Idempotent; reused on resume/restart.
  1. mkdir dir.
  2. Copy `config.toml`, `hooks.json`, `auth.json` from the real home (missing is fine).
  3. Link `sessions/` to the real `~/.codex/sessions` (junction on Windows — no admin
     needed; symlink elsewhere; fall back to no link + warning).
  4. Apply 9remote edits to the copy only: MCP block, hook trust (see below).
- `codexHomeEnv(chatId)` → `{ CODEX_HOME: dir }`, merged into the spawn env.
- `disposeCodexHome(chatId)` → remove dir (never follow the `sessions` junction;
  unlink it first, then `rm -rf`).
- `sweepCodexHomes()` → on host start, delete dirs whose chat no longer exists.
- Path constant lives in `host/lib/constants.js` (no hardcoded paths).

### Writing into the private config

Reuse existing writers by parameterising the target file instead of `PATHS.codex()`:
- `mcpConfig.js` `blockClient` already takes `file()`; call its enable on the copy.
- `upsertCodexTrust(filePath, entries)` already takes a path.
- Hook trust keys embed the `hooks.json` path
  (`<hooks.json path>:event:group:handler`), so keys change per home. Compute
  hashes by running `codexHookList` with `CODEX_HOME` set to the private dir, then
  `upsertCodexTrust` on the private config. Cost: one `app-server` start (≤15 s
  timeout) per new chat. Mitigation: build a warm **template home** once
  (config + hooks + trust computed), then per chat copy it and rewrite only the
  path prefix of the trust keys, hashes stay valid only if the hash does not cover
  the path — verify against codex before relying on this; otherwise recompute.

### Spawn wiring

- `CodexAdapter.start` passes `env: { ...getExtendedEnv(), ...codexHomeEnv(chatId) }`
  through `CodexAppServer` / carrier `start({ env })`. Daemon carrier must forward
  `env` too (check `daemonProc.js` / `agentProc.js`).
- `readThreadGoal(threadId, cwd)` gets the chat's home (thread state lives in codex's
  state DB, which would now be per-home — see Risks).

### Auth

- Copy `auth.json` at prepare time. Tokens refreshed by the chat's codex stay in the
  private copy and are lost on dispose.
- On dispose (and optionally on turn end), if the private `auth.json` is newer than
  the real one, copy it back atomically (write temp + rename). Skip if Cockpit Tools
  or another tool changed the real one in between (compare mtime captured at prepare).

### Lifecycle

- Create: when the chat's app-server is started (`CodexAdapter.start`).
- Reuse: restart/resume of the same chat reuses the dir.
- Dispose: chat destroyed (`ai:destroy`) or host sweep at startup.
- Host restart with a surviving daemon-held codex: the dir must survive; sweep only
  removes dirs with no live chat.

## Risks / open questions

1. **Per-home state DB.** codex keeps a sqlite state DB (threads, goals) in its home.
   A fresh home has none, so resuming a thread by id may fail unless the rollout in
   the shared `sessions/` is enough. Must verify `thread/resume` and `/goal` work
   with only `sessions/` linked; if not, also link/copy the state DB (shared sqlite
   across processes is what codex already does with WAL, so linking is acceptable).
2. **Windows junction semantics** with `fs.symlink(..., "junction")` and safe delete.
3. **Trust key / hash dependence on path** (above) — decides template vs recompute.
4. **Stale user config**: edits made to the real config after the chat started are not
   seen; codex-written changes in the private config are discarded. Acceptable;
   document it.
5. **Third-party tools** (Cockpit model provider, 1DevTool notify, computer-use) keep
   editing the real config; new chats pick it up at creation, running chats do not.
6. **Disk**: copied files are small; logs/cache grow per home — dispose cleans up.
7. Rollback: a flag (e.g. `AI_CODEX_ISOLATED_HOME`) in `host/features/ai/constants.js`
   to fall back to the shared home.

## Steps

1. Spike (no commit): run `CODEX_HOME=<tmp>` with copied config/auth and a linked
   `sessions/`; confirm app-server start, `thread/resume`, `/goal`, hook trust hashes
   and MCP block work. Settles risks 1 and 3.
2. Add constants + `codexHome.js` (prepare/env/dispose/sweep) with unit-style script
   checks (no test runner exists; use a node script under `host/scripts`).
3. Parameterise config writers (`blockClient`, trust upsert/reconcile) by target file.
4. Wire env into `CodexAdapter` carrier start (local + daemon) and `goal.js`.
5. Lifecycle: dispose on destroy, sweep on host start, auth copy-back.
6. Feature flag + manual test: open 5+ Codex UI chats at once while running
   `reconcileCodexTrust` and editing the real config; expect zero
   `failed to load configuration`, and resume/history/goal still work.
7. Keep `retryCodexConfig` as a last-resort guard.

## Not part of this plan

Atomic write + mutex for the shared `~/.codex/config.toml` (still worthwhile for the
PTY-terminal case that keeps using the real home). Tracked separately.
