## What you get

- **Past sessions** on the new-thread screen. It lists the sessions that ran in the selected project's folders. **All folders** shows the rest.
- **Sessions** in the sidebar. It lists every session, newest first, with a filter per agent and a search over title, first prompt and folder.
- **CLI selection** in Settings → Plugins → Session History. Choose Claude Code, Codex, Qwen Code, Pi and Command Code. Disabled histories are not scanned or shown; changes refresh open views.
- A transcript for each session: your prompts, the agent's replies and, on request, its tool calls. One button copies the command that resumes the session in a terminal (`claude --resume`, `codex resume` or `qwen --resume`).
- Continue below the transcript using BB's composer, then keep chatting in the embedded thread. Reopening the session returns to that continuation. The agent receives all text messages; large conversations are stored as complete snapshots and read in parts using the `session_history_read_context` agent tool.
- `bb session-history list` and `bb session-history show` for the terminal, plus a skill that lets agents in BB look up an earlier session.

## Where the titles come from

Each session keeps the name its agent shows. Claude Code uses your custom title or its own generated title. Codex uses the thread name from its local state database, the same one its VS Code extension shows, and hides subagent threads. Qwen Code stores no title, so its first prompt stands in. Pi uses the session name. Command Code uses its adjacent `.meta.json` title, then its session name or first prompt.

## Requirements

Sessions are read from local and connected machines: `~/.claude/projects`, `~/.codex` (or `CODEX_HOME`), `~/.qwen/projects`, `~/.pi/agent/sessions` and `~/.commandcode/projects`. Command Code v2 and v3 are supported; v2 records without a working directory appear under Unknown folder. Original session files are only read. Starting a continuation sends the conversation to the selected agent provider; this creates a new BB thread rather than reopening the native session. Tool results and image contents are not exported. The interface follows the browser language, Russian or English.
