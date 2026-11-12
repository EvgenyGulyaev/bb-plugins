// components/dialogs/PropertiesDialog.tsx вЂ” "Properties" (В§8.10).
//
// Two shapes behind one dialog. A single target is described in full from
// `pathProperties`, which is one lstat and therefore safe to run on every
// open. Several selected rows get a summary the panel already has the data
// for вЂ” counting them costs no round trip at all.
//
// A folder's real size is the one expensive question here, so it stays behind
// a button: `directorySize` walks the subtree with hard limits and can answer
// "partial", which this renders as a lower bound rather than as a total. bb's
// RPC has no abort channel, so closing the dialog cannot call the walk off вЂ”
// it retires the ticket the answer would land on, and the walk's own time
// budget bounds what is left running.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { DirectorySize, EntryKind, FileEntry, PathProperties } from "../../contract";
import { parseRpcError } from "../../lib/errors";
import { rootPhrase } from "../../lib/fm-paths";
import { useFmRpc } from "../../lib/fm-rpc";
import { UNKNOWN, formatBytes, formatDateTime, formatExactBytes } from "../../lib/format";
import { defineMessages, messagesNow, pluralRu, useMessages } from "../../lib/i18n";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Icon } from "../ui/icon";
import { effectiveKind } from "../FileRow";

/**
 * What the dialog was opened on. The empty-space menu knows only a folder
 * path; the row menu hands over the listing rows it already has, which is what
 * lets a multi-row selection be summarised without asking the server.
 */
export type PropertiesTarget =
  | { kind: "path"; path: string }
  | { kind: "entries"; entries: readonly FileEntry[] };

export interface PropertiesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: PropertiesTarget;
  hostId?: string | null;
}

const messages = defineMessages(
  {
    kindFile: "File",
    kindDirectory: "Folder",
    kindSymlink: "Symbolic link",
    kindOther: "Special file",
    linkUnresolved: "Symbolic link (unresolved)",
    linkTo: (kind: string) => `Symbolic link to ${kind.toLowerCase()}`,
    stopDepth: "the tree is deeper than the walk goes",
    stopEntries: "there are more entries than one walk counts",
    stopTime: "the walk ran out of time",
    items: (count: number) => `${String(count)} ${count === 1 ? "item" : "items"}`,
    title: "Properties",
    selection: "Selection",
    files: "Files",
    special: (count: number) => ` (+${String(count)} special)`,
    folders: "Folders",
    size: "Size",
    unmeasured:
      "Folders and links are not measured here вЂ” the total covers the selected files. Open a folder on its own to calculate its size.",
    reading: "ReadingвЂ¦",
    name: "Name",
    kind: "Kind",
    type: "Type",
    location: "Location",
    home: "the home folder",
    calculating: "CalculatingвЂ¦",
    calculate: "Calculate size",
    over: "over ",
    filesInFolders: (files: number, folders: number) =>
      `${String(files)} ${files === 1 ? "file" : "files"} in ${String(folders)} ${folders === 1 ? "folder" : "folders"}`,
    target: "Target",
    resolvesTo: "Resolves to",
    modified: "Modified",
    created: "Created",
    accessed: "Accessed",
    permissions: "Permissions",
    owner: "Owner",
    links: "Links",
    partial: (reason: string) =>
      `Partial result вЂ” ${reason}. The real total is larger than the number above.`,
    leavesRoot: (root: string) => `This link leaves ${root}, so the panel cannot follow it.`,
    close: "Close",
  },
  {
    kindFile: "Р¤Р°Р№Р»",
    kindDirectory: "РџР°РїРєР°",
    kindSymlink: "РЎРёРјРІРѕР»РёС‡РµСЃРєР°СЏ СЃСЃС‹Р»РєР°",
    kindOther: "РћСЃРѕР±С‹Р№ С„Р°Р№Р»",
    linkUnresolved: "РЎРёРјРІРѕР»РёС‡РµСЃРєР°СЏ СЃСЃС‹Р»РєР° (С†РµР»СЊ РЅРµ РЅР°Р№РґРµРЅР°)",
    linkTo: (kind) => `РЎРёРјРІРѕР»РёС‡РµСЃРєР°СЏ СЃСЃС‹Р»РєР°: ${kind.toLowerCase()}`,
    stopDepth: "РґРµСЂРµРІРѕ РіР»СѓР±Р¶Рµ, С‡РµРј РїСЂРѕС…РѕРґРёС‚ РѕР±С…РѕРґ",
    stopEntries: "СЌР»РµРјРµРЅС‚РѕРІ Р±РѕР»СЊС€Рµ, С‡РµРј СЃС‡РёС‚Р°РµС‚ РѕРґРёРЅ РѕР±С…РѕРґ",
    stopTime: "РѕР±С…РѕРґСѓ РЅРµ С…РІР°С‚РёР»Рѕ РІСЂРµРјРµРЅРё",
    items: (count) => `${String(count)} ${pluralRu(count, ["СЌР»РµРјРµРЅС‚", "СЌР»РµРјРµРЅС‚Р°", "СЌР»РµРјРµРЅС‚РѕРІ"])}`,
    title: "РЎРІРѕР№СЃС‚РІР°",
    selection: "Р’С‹Р±СЂР°РЅРѕ",
    files: "Р¤Р°Р№Р»С‹",
    special: (count) => ` (+${String(count)} РѕСЃРѕР±С‹С…)`,
    folders: "РџР°РїРєРё",
    size: "Р Р°Р·РјРµСЂ",
    unmeasured:
      "РџР°РїРєРё Рё СЃСЃС‹Р»РєРё Р·РґРµСЃСЊ РЅРµ РёР·РјРµСЂСЏСЋС‚СЃСЏ вЂ” РІ СЃСѓРјРјРµ С‚РѕР»СЊРєРѕ РІС‹Р±СЂР°РЅРЅС‹Рµ С„Р°Р№Р»С‹. Р§С‚РѕР±С‹ СѓР·РЅР°С‚СЊ СЂР°Р·РјРµСЂ РїР°РїРєРё, РѕС‚РєСЂРѕР№С‚Рµ СЃРІРѕР№СЃС‚РІР° С‚РѕР»СЊРєРѕ РµС‘.",
    reading: "Р§РёС‚Р°СЋвЂ¦",
    name: "РРјСЏ",
    kind: "Р’РёРґ",
    type: "РўРёРї",
    location: "Р“РґРµ",
    home: "Р”РѕРјР°С€РЅСЏСЏ РїР°РїРєР°",
    calculating: "РЎС‡РёС‚Р°СЋвЂ¦",
    calculate: "РџРѕСЃС‡РёС‚Р°С‚СЊ СЂР°Р·РјРµСЂ",
    over: "Р±РѕР»СЊС€Рµ ",
    filesInFolders: (files, folders) =>
      `${String(files)} ${pluralRu(files, ["С„Р°Р№Р»", "С„Р°Р№Р»Р°", "С„Р°Р№Р»РѕРІ"])} РІ ${String(folders)} ${pluralRu(folders, ["РїР°РїРєРµ", "РїР°РїРєР°С…", "РїР°РїРєР°С…"])}`,
    target: "Р¦РµР»СЊ",
    resolvesTo: "Р’РµРґС‘С‚ Рє",
    modified: "РР·РјРµРЅС‘РЅ",
    created: "РЎРѕР·РґР°РЅ",
    accessed: "РћС‚РєСЂС‹С‚",
    permissions: "РџСЂР°РІР°",
    owner: "Р’Р»Р°РґРµР»РµС†",
    links: "РЎСЃС‹Р»РѕРє",
    partial: (reason) =>
      `РќРµРїРѕР»РЅС‹Р№ СЂРµР·СѓР»СЊС‚Р°С‚ вЂ” ${reason}. РќР° СЃР°РјРѕРј РґРµР»Рµ Р±РѕР»СЊС€Рµ, С‡РµРј РїРѕРєР°Р·Р°РЅРѕ РІС‹С€Рµ.`,
    leavesRoot: (root) => `РЎСЃС‹Р»РєР° РІРµРґС‘С‚ Р·Р° РїСЂРµРґРµР»С‹ ${root}, РїР°РЅРµР»СЊ РїРѕ РЅРµР№ РЅРµ РїРѕР№РґС‘С‚.`,
    close: "Р—Р°РєСЂС‹С‚СЊ",
  },
);

type Messages = (typeof messages)["en"];

function kindLabel(kind: EntryKind, t: Messages): string {
  switch (kind) {
    case "file":
      return t.kindFile;
    case "directory":
      return t.kindDirectory;
    case "symlink":
      return t.kindSymlink;
    case "other":
      return t.kindOther;
  }
}

/** Why a walk stopped early, in words the dialog can put under a number. */
function stopReason(reason: NonNullable<DirectorySize["stoppedBy"]>, t: Messages): string {
  switch (reason) {
    case "depth":
      return t.stopDepth;
    case "entries":
      return t.stopEntries;
    case "time":
      return t.stopTime;
  }
}

/** "Folder", "File", "Symbolic link to folder". */
export function describeKind(properties: PathProperties): string {
  const t = messagesNow(messages);
  if (!properties.isSymlink) return kindLabel(properties.kind, t);
  if (properties.targetKind === null) return t.linkUnresolved;
  return t.linkTo(kindLabel(properties.targetKind, t));
}

/** True for anything whose size means "its contents", i.e. needs the walk. */
export function needsSizeWalk(properties: PathProperties): boolean {
  if (properties.escapesRoot) return false;
  return properties.isSymlink
    ? properties.targetKind === "directory"
    : properties.kind === "directory";
}

export interface SelectionSummary {
  total: number;
  files: number;
  folders: number;
  others: number;
  /** Total of the sizes the listing already knows: plain files only. */
  knownBytes: number;
  /** True when something selected has no size the panel can add up. */
  hasUnmeasured: boolean;
}

/**
 * The multi-selection answer, straight off the rows on screen. Folders have no
 * size in a listing and a symlink's `sizeBytes` is the length of its target
 * string rather than of the file вЂ” so neither is added up, and `hasUnmeasured`
 * says the total is only about the plain files.
 */
export function summarizeEntries(entries: readonly FileEntry[]): SelectionSummary {
  let files = 0;
  let folders = 0;
  let others = 0;
  let knownBytes = 0;
  let hasUnmeasured = false;
  for (const entry of entries) {
    const kind = effectiveKind(entry);
    if (kind === "directory") {
      folders += 1;
      hasUnmeasured = true;
      continue;
    }
    if (kind === "file") {
      files += 1;
      if (entry.isSymlink) hasUnmeasured = true;
      else knownBytes += entry.sizeBytes;
      continue;
    }
    others += 1;
    hasUnmeasured = true;
  }
  return { total: entries.length, files, folders, others, knownBytes, hasUnmeasured };
}

function Row({
  id,
  label,
  value,
  title,
}: {
  id: string;
  label: string;
  value: ReactNode;
  title?: string;
}) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-3 py-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className="min-w-0 break-words text-xs text-foreground"
        data-testid={`fm-properties-${id}`}
        title={title}
      >
        {value}
      </dd>
    </div>
  );
}

export function PropertiesDialog({ open, onOpenChange, target, hostId = null }: PropertiesDialogProps) {
  const t = useMessages(messages);
  const rpc = useFmRpc();

  /** The one path to describe, or null when this is a multi-row summary. */
  const singlePath = useMemo(() => {
    if (target.kind === "path") return target.path;
    return target.entries.length === 1 ? (target.entries[0]?.path ?? null) : null;
  }, [target]);
  const summary = useMemo(
    () => (target.kind === "entries" ? summarizeEntries(target.entries) : null),
    [target],
  );

  const [properties, setProperties] = useState<PathProperties | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [size, setSize] = useState<DirectorySize | null>(null);
  const [sizeBusy, setSizeBusy] = useState(false);
  const [sizeError, setSizeError] = useState<string | null>(null);

  /**
   * The only cancellation available. Every answer carries the ticket it was
   * asked under; opening on another path, or closing, retires it, so a reply
   * that arrives late вЂ” a `directorySize` walk in particular вЂ” lands on
   * nothing instead of repainting a dialog about a different file.
   */
  const ticketRef = useRef(0);

  useEffect(() => {
    ticketRef.current += 1;
    const ticket = ticketRef.current;
    setProperties(null);
    setError(null);
    setSize(null);
    setSizeError(null);
    setSizeBusy(false);

    if (!open || singlePath === null) {
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    void (async () => {
      try {
        const result = await rpc.call("pathProperties", {
          path: singlePath,
          ...(hostId === null ? {} : { hostId }),
        });
        if (ticketRef.current !== ticket) return;
        setProperties(result);
      } catch (failure) {
        if (ticketRef.current !== ticket) return;
        setError(parseRpcError(failure).message);
      } finally {
        if (ticketRef.current === ticket) setLoading(false);
      }
    })();

    return () => {
      ticketRef.current += 1;
    };
  }, [hostId, open, rpc, singlePath]);

  const calculateSize = useCallback(() => {
    if (singlePath === null) return;
    const ticket = ticketRef.current;
    setSizeBusy(true);
    setSizeError(null);
    void (async () => {
      try {
        const result = await rpc.call("directorySize", {
          path: singlePath,
          ...(hostId === null ? {} : { hostId }),
        });
        if (ticketRef.current !== ticket) return;
        setSize(result);
      } catch (failure) {
        if (ticketRef.current !== ticket) return;
        setSizeError(parseRpcError(failure).message);
      } finally {
        if (ticketRef.current === ticket) setSizeBusy(false);
      }
    })();
  }, [hostId, rpc, singlePath]);

  const heading =
    singlePath === null
      ? t.items(summary?.total ?? 0)
      : (properties?.name ?? singlePath.split("/").pop() ?? singlePath);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md bg-card text-card-foreground"
        data-testid="fm-properties-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="Info" className="size-4" aria-hidden="true" />
            {t.title}
          </DialogTitle>
          <DialogDescription className="truncate">{heading}</DialogDescription>
        </DialogHeader>

        {singlePath === null && summary !== null ? (
          <dl className="divide-y divide-border">
            <Row id="selection" label={t.selection} value={t.items(summary.total)} />
            <Row
              id="files"
              label={t.files}
              value={`${String(summary.files)}${summary.others > 0 ? t.special(summary.others) : ""}`}
            />
            <Row id="folders" label={t.folders} value={String(summary.folders)} />
            <Row
              id="size"
              label={t.size}
              value={formatBytes(summary.knownBytes)}
              title={formatExactBytes(summary.knownBytes)}
            />
          </dl>
        ) : null}

        {singlePath === null && summary?.hasUnmeasured === true ? (
          <p className="text-xs text-muted-foreground">
            {t.unmeasured}
          </p>
        ) : null}

        {loading ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Icon name="Loading" className="size-4 animate-spin" aria-hidden="true" />
            {t.reading}
          </p>
        ) : null}

        {error === null ? null : (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        {properties === null ? null : (
          <>
            <dl className="max-h-[50vh] divide-y divide-border overflow-y-auto">
              <Row id="name" label={t.name} value={properties.name} />
              <Row id="kind" label={t.kind} value={describeKind(properties)} />
              {properties.contentType === null ? null : (
                <Row id="type" label={t.type} value={properties.contentType} />
              )}
              <Row
                id="location"
                label={t.location}
                value={properties.parentPath ?? t.home}
                title={properties.path}
              />
              {needsSizeWalk(properties) ? (
                <Row
                  id="size"
                  label={t.size}
                  value={
                    size === null ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={sizeBusy}
                        onClick={calculateSize}
                        data-testid="fm-properties-calculate"
                      >
                        {sizeBusy ? (
                          <>
                            <Icon
                              name="Loading"
                              className="size-4 animate-spin"
                              aria-hidden="true"
                            />
                            {t.calculating}
                          </>
                        ) : (
                          t.calculate
                        )}
                      </Button>
                    ) : (
                      <span title={formatExactBytes(size.sizeBytes)}>
                        {size.partial ? t.over : ""}
                        {formatBytes(size.sizeBytes)}
                        <span className="text-muted-foreground">
                          {" В· "}
                          {t.filesInFolders(size.fileCount, size.directoryCount)}
                        </span>
                      </span>
                    )
                  }
                />
              ) : (
                <Row
                  id="size"
                  label={t.size}
                  value={formatBytes(properties.sizeBytes)}
                  title={formatExactBytes(properties.sizeBytes)}
                />
              )}
              {properties.isSymlink ? (
                <Row id="target" label={t.target} value={properties.linkTarget ?? UNKNOWN} />
              ) : null}
              {properties.isSymlink && properties.linkTargetPath !== null ? (
                <Row id="resolved" label={t.resolvesTo} value={properties.linkTargetPath} />
              ) : null}
              <Row id="modified" label={t.modified} value={formatDateTime(properties.modifiedAtMs)} />
              <Row
                id="created"
                label={t.created}
                value={
                  properties.createdAtMs === null ? UNKNOWN : formatDateTime(properties.createdAtMs)
                }
              />
              <Row id="accessed" label={t.accessed} value={formatDateTime(properties.accessedAtMs)} />
              <Row
                id="permissions"
                label={t.permissions}
                value={
                  <span className="font-mono">
                    {properties.modeText} ({properties.modeOctal})
                  </span>
                }
              />
              <Row
                id="owner"
                label={t.owner}
                value={
                  properties.ownerName === null
                    ? `uid ${String(properties.ownerUid)}, gid ${String(properties.ownerGid)}`
                    : `${properties.ownerName} (uid ${String(properties.ownerUid)}, gid ${String(properties.ownerGid)})`
                }
              />
              <Row id="links" label={t.links} value={String(properties.linkCount)} />
            </dl>

            {sizeError === null ? null : (
              <p role="alert" className="text-xs text-destructive">
                {sizeError}
              </p>
            )}

            {size?.partial === true ? (
              <p
                className="rounded-md bg-surface-attention px-2 py-1.5 text-xs text-warning-text"
                data-testid="fm-properties-partial"
              >
                {t.partial(stopReason(size.stoppedBy ?? "time", t))}
              </p>
            ) : null}

            {properties.escapesRoot ? (
              <p className="rounded-md bg-surface-attention px-2 py-1.5 text-xs text-warning-text">
                {t.leavesRoot(rootPhrase())}
              </p>
            ) : null}
          </>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t.close}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

