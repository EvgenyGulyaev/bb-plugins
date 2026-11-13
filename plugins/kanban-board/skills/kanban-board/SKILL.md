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

## Auto moves

The board can move cards by itself: a thread that starts working goes to `in_progress`, a finished turn goes to `review`. Check or toggle the mode with:

```
bb kanban-board auto        # print auto: on|off
bb kanban-board auto on
bb kanban-board auto off
```

When auto moves are on, do not move cards yourself unless the user asks: a manual move (CLI or drag) pins the card and automation stops touching it. Moving a card to `backlog` hands it back to automation. Auto moves never place a card in `done` — finishing work stays a human decision.
