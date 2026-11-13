# Session History CLI Sources Implementation Plan

> **For agentic workers:** Use executing-plans to implement the approved design in this checkout. Steps use checkbox syntax for tracking.

**Goal:** Choose visible CLI histories in plugin settings and include Command Code sessions.

**Architecture:** Use BB's native boolean plugin settings and the existing local/remote scanner pipeline. Add a Command Code reader that delegates v3 transcripts to Pi and handles legacy v2 records. Include source selections in cache keys and subscribe open views to native settings updates.

**Tech Stack:** TypeScript, React, BB SDK 0.6.132, Node's test runner.

## Global Constraints

- All five CLI sources default to enabled; selecting none is valid.
- No new runtime dependencies and no guessed legacy working directories.
- No source-session mutation during scans, tests, or transcript verification.
- Continue sessions through BB's existing continuation flow.
- Keep upstream PR creation for the user.

### Task 1: Source selection and Command Code readers

**Files:** `lib/sessions/types.ts`, `settings.ts`, `command-code.ts`, `index.ts`, `lib/remote.ts`, `tests/sources.test.ts`, `tests/command-code.test.ts`, `scripts/test.mjs` under `plugins/session-history`.

**Interfaces:** `enabledAgents(settings: Readonly<Record<string, unknown>>): Agent[]`; `listCommandCodeSessions(root?: string): Promise<SessionSummary[]>`; `readCommandCodeTranscript(file: string, complete?: boolean): Promise<Transcript>`.

- [ ] Add synthetic v2/v3 files in temporary project folders; assert title/model metadata, branch-aware text, checkpoint exclusion, and unchanged source files.
- [ ] Add selection tests: absent settings return every source; `showQwen: false` excludes Qwen; every false flag returns none.
- [ ] Extend the test runner to compile and run every `tests/*.test.ts`; run `npm test` and confirm new tests fail for missing behavior.
- [ ] Add `command-code` to the agent union, reader dispatch, resume command, and remote scanner/parser.
- [ ] Implement source-aware cache keys and discovery filtering. Verify a disabled source is not read even when an all-source cache exists.
- [ ] Run `npm test`; require all tests to pass.

Example selection assertion:

```ts
assert.deepEqual(enabledAgents({ showClaude: false, showCodex: false,
  showQwen: false, showPi: false, showCommandCode: true }), ["command-code"]);
```

### Task 2: Native settings, UI, documentation, integration

**Files:** `server.ts`, `app.tsx`, `README.md`, `PLUGIN_OVERVIEW.md` under `plugins/session-history`.

**Interfaces:** Native `showClaude`, `showCodex`, `showQwen`, `showPi`, `showCommandCode` booleans. Existing `sessions_list` response remains compatible. Command Code maps to the BB `command-code` provider.

- [ ] Define all five settings with `type: "boolean"`, `default: true`, and CLI-name labels.
- [ ] Pass enabled sources through local, remote, background, cached, and CLI paths; return no results or scans when all are disabled.
- [ ] Use `useSettings()` in views to reload on source changes, hide disabled filter buttons, and reset an invalid active filter to All.
- [ ] Add the Command Code badge and route handling; document locations, settings, CLI usage, and v2 directory limitation.
- [ ] Run `npm test`, `npm run typecheck`, and `bb plugin build .`.
- [ ] Review the diff for unrelated changes and verify no real session fixtures or credentials were added.
- [ ] Commit, push the branch to the user's fork, and install its `plugins/session-history` subdirectory in BB.
- [ ] Verify settings persist, Command Code history/transcripts load, disabling a source hides it, and re-enabling restores it. Restore all sources to enabled after checks.
- [ ] Report the fork/branch and validation evidence; do not open an upstream PR.
