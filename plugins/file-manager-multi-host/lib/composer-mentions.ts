// lib/composer-mentions.ts — how "Add to chat" writes file pills into a draft.
//
// Both ends of §8.8 (the row menu in the panel and the composer's own file
// browser) add the same thing: one @-mention pill per file, bound to this
// plugin's `file` provider, with the absolute path as its item id.
import type { PluginComposerApi } from "@get-bb/plugin-sdk/app";

import { MENTION_PROVIDER_ID, type FileEntry } from "../contract";

/**
 * Append one pill per file to the end of the draft, in the order given, and
 * focus the composer.
 *
 * A space separates the first pill from text already there and follows every
 * pill, so the next word never runs into one. The end rather than the caret:
 * the panel's composer is not always on screen, and `insert` at the caret
 * throws for a composer nobody is looking at.
 */
export function addFileMentions(
  composer: PluginComposerApi,
  files: readonly Pick<FileEntry, "name" | "path">[],
): void {
  if (files.length === 0) return;
  const text = composer.text;
  const lead = text.length === 0 || /\s$/u.test(text) ? [] : [" "];
  composer.insert(
    [
      ...lead,
      ...files.flatMap((file) => [
        { provider: MENTION_PROVIDER_ID, id: file.path, label: file.name },
        " ",
      ]),
    ],
    { at: "end" },
  );
  composer.focus();
}
