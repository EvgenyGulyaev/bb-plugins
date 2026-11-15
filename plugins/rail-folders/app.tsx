// bb-plugin-rail-folders — frontend entry.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time (never
// bundled), so this file must be loaded by BB, not imported directly.
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { RailFolders } from "./components/RailFolders";
import { RailFoldersSettings } from "./components/RailFoldersSettings";

export default definePluginApp((app) => {
  // Exclusive navigation provider: this component draws the whole rail.
  // bb draws Settings at the bottom of the column itself.
  app.slots.experimental_sidebarNavigation({
    id: "rail-folders",
    title: "Папки рейла",
    description: "Иконки рейла, объединённые в папки.",
    placement: "rail",
    component: RailFolders,
  });

  app.slots.settingsSection({
    id: "rail-folders",
    title: "Папки рейла",
    description: "Создавайте папки, переименовывайте их, меняйте иконки, порядок папок и участников.",
    component: RailFoldersSettings,
  });
});
