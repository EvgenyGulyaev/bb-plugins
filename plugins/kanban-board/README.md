# bb-plugin-kanban-board

A BB plugin that adds a shared Kanban board. Every card is a BB thread, and agents can move cards between workflow columns from the board or the command line.

- `server.ts` stores thread positions, exposes RPC methods, and registers `bb kanban-board move`.
- `app.tsx` adds the **Доска** page to the sidebar with draggable thread cards.
- `skills/kanban-board/SKILL.md` teaches agents how to move cards safely.

Install with:

```
bb plugin install .
```

Then open **Доска** in the sidebar. Agents can update a card with:

```
bb kanban-board move <thread-id> in_progress
```

The board uses the host's thread list, so it follows the current BB workspace and does not copy conversation content into plugin storage.
