# bb-plugin-kanban-board

A BB plugin that adds a shared Kanban board. Every card is a BB thread, and agents can move cards between workflow columns from the board or the command line.

- `server.ts` stores thread positions, exposes RPC methods, registers `bb kanban-board move` and `bb kanban-board auto`, and follows thread lifecycle events for optional auto moves.
- `app.tsx` adds the **Доска** page to the sidebar with draggable thread cards and an **Автопереходы** toggle.
- `lib/board-tree.ts` groups threads into cards: a thread whose parent is also on the board is a subcard of that parent, however deep the chain goes.
- `skills/kanban-board/SKILL.md` teaches agents how to move cards safely.
- `server.test.ts` covers the auto-move policy, `lib/board-tree.test.ts` the grouping, and `test/app.test.tsx` the board page (vitest).

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

## Nested cards

A thread started from another thread (`parentThreadId`) is drawn as a compact subcard inside its parent's card instead of a card of its own, so a parent and its children stay together. The parent card shows how many subcards it holds and collapses or expands them; the list starts expanded. A subcard shows the provider icon, the title, a status dot, its own column when that differs from the parent's, and an open button; clicking the row opens the thread.

A thread whose parent is not on the board — archived, hidden, or gone — keeps a card of its own, so nothing disappears. Placement and pinning stay per thread: dragging a parent moves only the parent, dragging a subcard moves that thread and leaves it nested, and auto moves apply to every thread as before. The header counter shows the number of visible threads, not cards.

The board uses the host's thread list, so it follows the current BB workspace and does not copy conversation content into plugin storage.
