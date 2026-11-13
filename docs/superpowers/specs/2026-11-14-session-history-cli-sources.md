# Session History CLI sources

Add five persistent boolean settings to Session History: Claude Code, Codex,
Qwen Code, Pi, and Command Code. All default to enabled. Disabled sources are
not scanned on local or connected machines, do not contribute cached results,
and are hidden from the homepage and Sessions filter buttons. Changing settings
refreshes open views; disabling every source is valid.

Command Code reads `~/.commandcode/projects/*/*.jsonl`. Exclude checkpoint
files. Support both current Pi-compatible v3 sessions and legacy v2 message
records. Prefer the adjacent `.meta.json` title/model, falling back to recorded
messages. Missing or malformed metadata must not hide a valid conversation.
Legacy sessions that never recorded a working directory use Unknown folder;
do not guess a directory by decoding a lossy project slug.

Reuse the Pi transcript reader for v3 sessions. Legacy v2 parsing retains user
and assistant text and tool-call descriptions, excludes reasoning and raw tool
results, and observes the existing transcript limits. Remote discovery and
transcripts support the same formats. Continuations use the existing BB
continuation flow and the installed `command-code` provider; reading history
never starts a model request or modifies source sessions.

Develop on `feat/session-history-cli-sources` in the user's GitHub fork. Keep
changes confined to Session History and its documentation. Add no runtime
dependencies. Verify synthetic v2/v3 fixtures, metadata updates, disabled
source discovery/cache behavior, remote selection, native settings, typecheck,
build, and live read-only BB queries. Install the verified branch in BB, retain
plugin settings, and leave upstream PR creation to the user.
