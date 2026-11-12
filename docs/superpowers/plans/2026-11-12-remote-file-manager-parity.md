# Remote File Manager Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the file manager use the same navigation, search, download, upload, folder, rename, delete, move and copy actions on enrolled remote machines as it does on the server.

**Architecture:** Extend the existing remote adapter with the public `bb.sdk.files` read/write API, keep every remote path clamped to the machine home directory, and route the existing RPC handlers by `hostId`. The panel will pass the selected machine to all mutating, property, search, upload and download calls; local behavior remains unchanged. Archive extraction and low-level filesystem metadata remain capability-gated because the public host API exposes no remote archive process or lstat/statfs operation.

**Tech Stack:** TypeScript, Zod RPC contract, React, `@get-bb/plugin-sdk` host file APIs, Vitest, Vite.

## Global Constraints

- Remote paths must stay inside the root returned by `bb.sdk.hosts.directory`.
- Never execute a shell command on a remote host; use only typed SDK file operations.
- Preserve local server behavior and existing error codes.
- Remote file transfer through `files.read`/`files.write` is bounded by `MAX_REMOTE_FILE_BYTES`.
- Bump the plugin version for the wire-contract change and update README capability notes.

---

### Task 1: Extend the remote adapter

**Files:**
- Modify: `plugins/file-manager-multi-host/src/remote-files.ts`
- Test: `plugins/file-manager-multi-host/test/backend/remote-files.test.ts`

**Interfaces:**
- Produce `searchDir`, `pathProperties`, `directorySize`, `createFolder`, `renameEntry`, `deleteEntries`, `moveEntries`, `copyEntries`, `writeFile` methods on `RemoteFilesModule`.
- Use `bb.sdk.files.listPaths`, `mkdir`, `move`, `remove`, `write`, and `read`; retain `hosts.directory` for one-level navigation.

- [ ] Add the methods with root validation, conflict handling and `fmError` mapping.
- [ ] Mark connected remote directories writable when the SDK write operation is available.
- [ ] Add tests proving remote mkdir, rename, delete, move, copy and search call the selected `hostId` and reject paths outside the remote root.
- [ ] Run `npm test -- --run test/backend/remote-files.test.ts` and require all tests to pass.

### Task 2: Route metadata and mutations through RPC

**Files:**
- Modify: `plugins/file-manager-multi-host/src/rpc.ts`
- Modify: `plugins/file-manager-multi-host/contract.ts`
- Modify: `plugins/file-manager-multi-host/package.json`
- Test: `plugins/file-manager-multi-host/test/backend/rpc.test.ts`

**Interfaces:**
- Add optional `hostId` to mutation, archive-listing and upload inputs where the selected machine is needed.
- `createCoreHandlers` must dispatch remote metadata and mutation calls to `deps.remote` and local calls to the existing modules.

- [ ] Update schemas and TypeScript input types without changing output shapes.
- [ ] Add dispatch branches for properties, directory size, search and all five mutations.
- [ ] Add contract tests for local and remote dispatch, including the selected `hostId`.
- [ ] Run the focused RPC tests and `npm run build`.

### Task 3: Make upload and download target a remote host

**Files:**
- Modify: `plugins/file-manager-multi-host/src/uploads.ts`
- Modify: `plugins/file-manager-multi-host/src/http-routes.ts`
- Modify: `plugins/file-manager-multi-host/lib/upload-manager.ts`
- Modify: `plugins/file-manager-multi-host/components/FileManagerPanel.tsx`
- Modify: `plugins/file-manager-multi-host/lib/download.ts`
- Test: `plugins/file-manager-multi-host/test/backend/http-routes.test.ts`
- Test: `plugins/file-manager-multi-host/test/frontend/uploads.test.tsx`

**Interfaces:**
- Upload sessions carry `hostId`; finish writes the staged bytes through the remote adapter and returns a remote entry.
- Download URLs already carry `hostId`; zip download must report a clear capability error for a remote multi-selection until a remote archive stream is available.

- [ ] Pass `hostId` from the panel into upload requests and download URLs.
- [ ] Store and validate remote upload sessions; reject files over `MAX_REMOTE_FILE_BYTES` with `unsupported`.
- [ ] Call `remote.writeFile` at finish and clean the local staging file only after success.
- [ ] Add tests for remote upload finish and remote single-file download.
- [ ] Run upload tests and `npm run build`.

### Task 4: Enable the remote UI actions

**Files:**
- Modify: `plugins/file-manager-multi-host/components/FileManagerPanel.tsx`
- Modify: `plugins/file-manager-multi-host/components/dialogs/PropertiesDialog.tsx`
- Modify: `plugins/file-manager-multi-host/components/PanelActions.tsx`
- Modify: `plugins/file-manager-multi-host/components/selected-entry-actions.ts`
- Modify: `plugins/file-manager-multi-host/hooks/useUploads.ts`
- Test: `plugins/file-manager-multi-host/test/frontend/properties.test.tsx`
- Test: `plugins/file-manager-multi-host/test/frontend/menus.test.tsx`

**Interfaces:**
- Every RPC call that describes or changes the current selection includes the active machine id.
- The existing `writable` and `canExtract` flags continue to control visibility; remote capability errors become ordinary toasts.

- [ ] Remove the remote-only read-only assumptions for supported actions.
- [ ] Pass `hostId` to properties, directory-size, mutations, search and upload manager calls.
- [ ] Keep remote zip download and archive extraction disabled with an explanatory message.
- [ ] Add frontend assertions for enabled remote CRUD actions and host-aware property calls.
- [ ] Run focused frontend tests and `npm run build`.

### Task 5: Documentation, version and release verification

**Files:**
- Modify: `plugins/file-manager-multi-host/README.md`
- Modify: `plugins/file-manager-multi-host/PLUGIN_OVERVIEW.md`
- Modify: `plugins/file-manager-multi-host/package.json`

- [ ] Document supported remote operations and the two SDK limits (bounded single-file transfer; no remote archive process/zip stream).
- [ ] Bump `package.json` and `server.ts` version to `0.12.0`.
- [ ] Run `git diff --check`, `npm run build`, focused Vitest suites, and `bb plugin build .`.
- [ ] Commit the completed change and publish the changed files to `deicer/bb-plugins` `main`.


