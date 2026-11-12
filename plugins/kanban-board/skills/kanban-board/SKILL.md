---
name: kanban-board
description: Move BB threads between the Kanban board columns when work starts, needs review, or finishes.
---

# Kanban board

Each board card is a BB thread. The board has four columns: `backlog`, `in_progress`, `review`, and `done`.

## Move a card

Use the thread id and one of the four column names:

```
bb kanban-board move <thread-id> in_progress
```

Use `backlog` for work that has not started, `in_progress` while an agent is working, `review` when a human or another agent should check the result, and `done` after the work is complete.

Only move the thread that belongs to the current task. If you do not know its id, use the id shown on the board card or in the sidebar; do not invent one.
