# bb-plugin-kanban-board

A BB plugin that adds a shared Kanban board. Every card is a BB thread, and agents can move cards between workflow columns from the board or the command line.

- `server.ts` stores thread positions, exposes RPC methods, registers `bb kanban-board move` and `bb kanban-board auto`, and follows thread lifecycle events for optional auto moves.
- `app.tsx` adds the **Доска** page to the sidebar with draggable thread cards and an **Автопереходы** toggle.
- `skills/kanban-board/SKILL.md` teaches agents how to move cards safely.
- `server.test.ts` covers the auto-move policy (vitest).

Install with:

```
bb plugin install .
```

Then open **Доска** in the sidebar. Agents can update a card with:

```
bb kanban-board move <thread-id> in_progress
```

Auto moves are off by default. Enable them with the **Автопереходы** checkbox on the board or with:

```
bb kanban-board auto on
```

While auto moves are on, a thread that starts working moves to `in_progress` and a finished turn moves to `review`. A manual move (drag or CLI) pins the card against automation; moving it back to `backlog` unpins it. Auto moves never place a card in `done`.

The board uses the host's thread list, so it follows the current BB workspace and does not copy conversation content into plugin storage.
