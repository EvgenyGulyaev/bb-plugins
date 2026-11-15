Folders for the BB rail icons.

Rail Folders takes over the left rail and lets you group its icons. A folder
is one rail button; clicking it opens its members with their icons, names and
badges. Clicking a member opens it in place, and with ⌘/Ctrl held it opens in a
neighbouring pane, exactly like a normal rail icon. A folder shows a dot when
any member carries a badge, and lights up while one of its members is open.

Right-click an icon to create a folder around it, add it to an existing
folder, remove it, or open the owning plugin's details. Right-click a folder to
rename or delete it. Icons the user hid stay reachable from the "More" menu
instead of disappearing.

Settings → Rail Folders creates folders and manages their name, BB icon name,
order and removal. Deleting a folder never disables a plugin or deletes a
panel: its members simply return to the rail one by one.

The arrangement is stored on the BB server, survives restarts, and every open
window updates immediately when it changes. No account, API key, or external
service is involved.

The plugin picks itself as the navigation provider once, on install. To go back
to the built-in rail, choose it in Settings → Appearance → Navigation or run
`bb settings ui set sidebar.navigationProvider navigation/rail`.
