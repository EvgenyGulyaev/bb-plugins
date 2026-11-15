Folders for the BB rail icons.

Rail Folders takes over the left rail and lets you group its icons. A folder is
one rail button drawn as its icon only; the name stays in the tooltip, the
accessible name, the popover header and settings. Clicking the button opens its
members with their icons, names and badges. Clicking a member opens it in place,
and with ⌘/Ctrl held it opens in a neighbouring pane, exactly like a normal rail
icon. A folder shows a dot when any member carries a badge, and lights up while
one of its members is open.

Right-click an icon to start a new folder, add it to an existing folder, remove
it, or open the owning plugin's details. "New folder…" opens a modal with a
grid of BB icons and a name field (default "Папка"), and creates an empty folder
after OK. Renaming a folder uses the same icon picker. Drag an icon onto a
folder with the mouse to add it, drag a member row inside the popover to reorder
the folder, or drag it out onto the free rail to return it. Drag a folder onto
another folder or onto a single icon to place it before or after — the
insertion line follows which half of the target the pointer is over — so a
folder can sit between single icons. Drag it onto the free rail to move it to
the end of the whole rail. Icons the user hid stay reachable from the "More"
menu instead of disappearing; that menu also holds "Customize rail…", which
opens bb's own rail editor.

Settings → Rail Folders creates folders and manages their name, BB icon name,
position in the rail, member order and removal. Folder and member arrow buttons
are the keyboard and screen-reader alternative to dragging. The folder arrows
step through the same mixed order as the rail, so a folder passes both sibling
folders and single icons. Deleting a folder never disables a plugin or deletes a
panel: its members simply return to the rail one by one.

The arrangement is stored on the BB server, survives restarts, and every open
window updates immediately when it changes. No account, API key, or external
service is involved.

The plugin picks itself as the navigation provider once, on install. To go back
to the built-in rail, choose it in Settings → Appearance → Navigation or run
`bb settings ui set sidebar.navigationProvider navigation/rail`.
