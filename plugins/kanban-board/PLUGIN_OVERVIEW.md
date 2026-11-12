This plugin turns BB threads into a shared Kanban board for agents and humans.

## What you get

- A **Доска** page in the sidebar with four workflow columns: **В очереди**, **В работе**, **На проверке**, and **Готово**.
- Every visible thread appears as a draggable card. Opening a card takes you to that thread.
- Positions are stored in the plugin's own BB storage and updates are broadcast to every open board.

## For agents

Move a thread with:

`bb kanban-board move <thread-id> <backlog|in_progress|review|done>`

Use the exact thread id from the sidebar or the current conversation. The same command works for human operators and agents.
