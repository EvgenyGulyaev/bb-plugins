---
name: session-history
description: Find and read past Claude Code, Codex, Qwen Code or Pi sessions that ran outside BB (terminal, VS Code) on this or an enrolled machine. Use when the user refers to an earlier session, asks what was done before, or wants its resume command.
---

# Past agent sessions

- `bb session-history list [--agent claude|codex|qwen|pi] [--host <id>] [--cwd <path>] [--limit <n>] [--json]` lists sessions newest first with their titles and ids. `--cwd` keeps sessions whose working directory is inside that path; `--host` selects an enrolled machine.
- `bb session-history show <agent> <session-id> [--host <id>] [--json]` prints the transcript (user and assistant messages; `--json` also includes tool calls). Output over BB's 1 MB CLI limit keeps the newest entries.

Opening a session in the Sessions page also offers a BB composer below its transcript. Sending the first message starts a linked BB continuation with the complete text conversation. Large snapshots are read in order with the `session_history_read_context` tool, available only to threads carrying a continuation snapshot. Original session files are read-only. Quote the session title and id when you reference one.

В боковой вкладке сессий можно выбрать машину и режим группировки по рабочим папкам. Удаление сессии выполняется кнопкой в просмотре с подтверждением; удаляется исходный файл на выбранной машине.
