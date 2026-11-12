// src/remote-files.ts — the read-only adapter for enrolled BB machines.
//
// The original manager operates on the server's own filesystem. This adapter
// keeps that path intact and uses the public SDK for another enrolled host:
// host.directory for one-level listings, files.read for bounded content, and
// files.createPreview for browser media. Every path is checked against the
// home directory reported by the host before it crosses the SDK boundary.
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import {
  MAX_LIST_ENTRIES,
  MAX_REMOTE_FILE_BYTES,
  MAX_TEXT_PREVIEW_BYTES,
  PREVIEW_TTL_MS,
  detectArchiveFormat,
  type FileEntry,
  type FileManagerMachine,
} from "../contract";
import { fmError } from "./errors";

export interface RemoteFilesModule {
  listMachines(): Promise<FileManagerMachine[]>;
  listDir(input: { hostId: string; path: string; showHidden: boolean }): Promise<{
    path: string;
    parentPath: string | null;
    isRoot: boolean;
    entries: FileEntry[];
    truncated: boolean;
    totalEntries: number;
    hiddenCount: number;
    writable: boolean;
    volume: null;
  }>;
  statPath(input: { hostId: string; path: string }): Promise<{
    entry: FileEntry;
    parentPath: string | null;
  }>;
  createPreviewUrl(input: { hostId: string; path: string }): Promise<{
    baseUrl: string;
    path: string;
    expiresAtMs: number;
  }>;
  readTextFile(input: { hostId: string; path: string }): Promise<{
    path: string;
    text: string;
    sizeBytes: number;
    readBytes: number;
    truncated: boolean;
  }>;
  readFile(input: { hostId: string; path: string }): Promise<{
    path: string;
    content: string;
    contentEncoding: "base64" | "utf8";
    mimeType?: string;
    modifiedAtMs?: number;
    sizeBytes: number;
  }>;
}

type HostRecord = { id: string; name: string; status: string };

interface CachedMachine {
  machine: FileManagerMachine;
  root: string | null;
}

function statusOf(host: HostRecord): FileManagerMachine["status"] {
  const raw = String(host.status).toLowerCase();
  if (raw === "connected" || raw === "online" || raw === "active") return "connected";
  if (raw === "creating" || raw === "provisioning") return "creating";
  if (raw === "offline" || raw === "disconnected" || raw === "suspended") return "offline";
  return "unknown";
}

function pathApi(root: string): typeof path.posix | typeof path.win32 {
  return /^[A-Za-z]:[\\/]/u.test(root) || root.includes("\\") ? path.win32 : path.posix;
}

function inside(root: string, candidate: string): boolean {
  const api = pathApi(root);
  const relative = api.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative));
}

function rootPath(root: string, requested: string): string {
  const api = pathApi(root);
  const candidate = api.resolve(root, requested === "" || requested === "~" ? root : requested);
  if (!inside(root, candidate)) throw fmError("path_escape", requested);
  return candidate;
}

function hiddenName(name: string): boolean {
  return name.startsWith(".");
}

function entryFor(root: string, item: { name: string; path: string; kind: "directory" | "file" }): FileEntry {
  const absolute = rootPath(root, item.path);
  return {
    name: item.name,
    path: absolute,
    kind: item.kind,
    targetKind: null,
    sizeBytes: 0,
    modifiedAtMs: 0,
    isHidden: hiddenName(item.name),
    isSymlink: false,
    escapesRoot: false,
    archiveFormat: item.kind === "file" ? detectArchiveFormat(item.name) : null,
    metadataAvailable: false,
  };
}

function decodeContent(content: string, encoding: "base64" | "utf8"): Buffer {
  return encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
}

function mapRemoteError(error: unknown, detail: string): never {
  const message = String(error);
  if (/not found|no such|unknown host|disconnected|offline|unavailable/iu.test(message)) {
    throw fmError("io_error", detail);
  }
  throw fmError("io_error", detail);
}

export function createRemoteFiles(bb: BbPluginApi): RemoteFilesModule {
  const cache = new Map<string, CachedMachine>();

  async function loadMachine(hostId: string): Promise<CachedMachine> {
    const current = cache.get(hostId);
    try {
      const host = await bb.sdk.hosts.get({ hostId });
      const status = statusOf(host);
      if (status !== "connected") throw fmError("io_error", `${host.name} is ${status}`);
      let root = current?.root ?? null;
      if (root === null) {
        const listing = await bb.sdk.hosts.directory({ hostId });
        root = listing.directory;
      }
      if (root === null || root === "") throw fmError("io_error", "home folder is unavailable");
      const result: CachedMachine = {
        machine: { id: host.id, name: host.name, status: "connected", root, readOnly: true },
        root,
      };
      cache.set(hostId, result);
      return result;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("io_error:")) throw error;
      mapRemoteError(error, `machine ${hostId} is unavailable`);
    }
  }

  async function listMachines(): Promise<FileManagerMachine[]> {
    try {
      const hosts = await bb.sdk.hosts.list({});
      const results = await Promise.all(
        hosts.map(async (host) => {
          const status = statusOf(host);
          if (status !== "connected") {
            const machine: FileManagerMachine = {
              id: host.id,
              name: host.name,
              status,
              root: null,
              readOnly: true,
            };
            cache.set(host.id, { machine, root: null });
            return machine;
          }
          try {
            const listing = await bb.sdk.hosts.directory({ hostId: host.id });
            const machine: FileManagerMachine = {
              id: host.id,
              name: host.name,
              status,
              root: listing.directory,
              readOnly: true,
            };
            cache.set(host.id, { machine, root: listing.directory });
            return machine;
          } catch {
            const machine: FileManagerMachine = {
              id: host.id,
              name: host.name,
              status: "offline",
              root: null,
              readOnly: true,
            };
            cache.set(host.id, { machine, root: null });
            return machine;
          }
        }),
      );
      return results;
    } catch (error) {
      bb.log.warn(`could not list machines for File Manager: ${String(error)}`);
      return [];
    }
  }

  async function listDir(input: { hostId: string; path: string; showHidden: boolean }) {
    const target = await loadMachine(input.hostId);
    const absolute = rootPath(target.root!, input.path);
    let listing;
    try {
      listing = await bb.sdk.hosts.directory({ hostId: input.hostId, path: absolute });
    } catch (error) {
      mapRemoteError(error, `could not open ${absolute}`);
    }
    const all = listing.entries.map((item) => entryFor(target.root!, item));
    const visible = input.showHidden ? all : all.filter((entry) => !entry.isHidden);
    const kept = visible.slice(0, MAX_LIST_ENTRIES);
    // Some daemon versions return the nearest filesystem root in `directory`
    // when the requested path is a user home. Keep the already validated
    // target as the panel's canonical path and derive its parent locally.
    const canonical = absolute;
    const parent = canonical === target.root ? null : pathApi(target.root!).dirname(canonical);
    return {
      path: canonical,
      parentPath: parent,
      isRoot: canonical === target.root,
      entries: kept,
      truncated: visible.length > MAX_LIST_ENTRIES,
      totalEntries: all.length,
      hiddenCount: all.length - visible.length,
      writable: false,
      volume: null,
    };
  }

  async function statPath(input: { hostId: string; path: string }) {
    const target = await loadMachine(input.hostId);
    const absolute = rootPath(target.root!, input.path);
    const parent = pathApi(target.root!).dirname(absolute);
    const listing = await listDir({ hostId: input.hostId, path: parent, showHidden: true });
    const entry = listing.entries.find((candidate) => candidate.path === absolute);
    if (entry === undefined) throw fmError("not_found", absolute);
    return { entry, parentPath: listing.path };
  }

  async function createPreviewUrl(input: { hostId: string; path: string }) {
    const target = await loadMachine(input.hostId);
    const absolute = rootPath(target.root!, input.path);
    try {
      const preview = await bb.sdk.files.createPreview({
        hostId: input.hostId,
        rootPath: absolute,
        ttlMs: PREVIEW_TTL_MS,
      });
      return { baseUrl: preview.baseUrl, path: absolute, expiresAtMs: preview.expiresAtMs };
    } catch (error) {
      mapRemoteError(error, `previews are unavailable on ${target.machine.name}`);
    }
  }

  async function readFile(input: { hostId: string; path: string }) {
    const target = await loadMachine(input.hostId);
    const absolute = rootPath(target.root!, input.path);
    try {
      const result = await bb.sdk.files.read({ hostId: input.hostId, path: absolute, rootPath: target.root! });
      if (result.sizeBytes > MAX_REMOTE_FILE_BYTES) {
        throw fmError("unsupported", `remote files are limited to ${MAX_REMOTE_FILE_BYTES} bytes`);
      }
      return { ...result, path: absolute };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("unsupported:")) throw error;
      mapRemoteError(error, `could not read ${absolute}`);
    }
  }

  async function readTextFile(input: { hostId: string; path: string }) {
    const result = await readFile(input);
    const bytes = decodeContent(result.content, result.contentEncoding);
    const window = bytes.subarray(0, Math.min(bytes.length, MAX_TEXT_PREVIEW_BYTES));
    if (window.includes(0)) throw fmError("unsupported", `${result.path} is not a text file`);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(window);
    } catch {
      throw fmError("unsupported", `${result.path} is not a text file`);
    }
    return {
      path: result.path,
      text,
      sizeBytes: result.sizeBytes,
      readBytes: Buffer.byteLength(text, "utf8"),
      truncated: result.sizeBytes > window.byteLength,
    };
  }

  return { listMachines, listDir, statPath, createPreviewUrl, readTextFile, readFile };
}
