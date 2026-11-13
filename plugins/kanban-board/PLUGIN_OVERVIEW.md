This plugin turns BB threads into a shared Kanban board for agents and humans.

## What you get

- A **Доска** page in the sidebar with four workflow columns: **В очереди**, **В работе**, **На проверке**, and **Готово**.
- Every visible thread appears as a draggable card. Opening a card takes you to that thread.
- Optional **Автопереходы** checkbox: while enabled, a thread that starts working moves to **В работе** and a finished turn moves to **На проверке**. A hand move pins the card (shown with a pin icon) and automation leaves it alone; moving it back to **В очереди** hands it to automation again. Auto moves never place a card in **Готово** — finishing work stays a human decision.
- Positions are stored in the plugin's own BB storage and updates are broadcast to every open board.

## For agents

Move a thread with:

`bb kanban-board move <thread-id> <backlog|in_progress|review|done>`

Show or toggle auto moves with:

`bb kanban-board auto [on|off]`

Use the exact thread id from the sidebar or the current conversation. The same command works for human operators and agents.
