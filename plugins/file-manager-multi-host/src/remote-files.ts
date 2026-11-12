// src/remote-files.ts вЂ” the adapter for enrolled BB machines.
//
// The original manager operates on the server's own filesystem. This adapter
// keeps that path intact and uses the public SDK for another enrolled host:
// host.directory for one-level listings, files.* for reads and writes, and
// files.createPreview for browser media. Every path is checked against the
// home directory reported by the host before it crosses the SDK boundary.
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import {
  MAX_SEARCH_RESULTS,
  MAX_LIST_ENTRIES,
  MAX_SEARCH_DEPTH,
  MAX_REMOTE_FILE_BYTES,
  MAX_TEXT_PREVIEW_BYTES,
  PREVIEW_TTL_MS,
  detectArchiveFormat,
  type FileEntry,
  type FileManagerMachine,
} from "../contract";
import { fmError } from "./errors";
import { contentTypeOf } from "./properties";
import { validateName } from "./root";

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
  searchDir(input: { hostId: string; path: string; query: string; showHidden: boolean; maxDepth: number }): Promise<{
    entries: FileEntry[];
    truncated: boolean;
  }>;
  pathProperties(input: { hostId: string; path: string }): Promise<Record<string, unknown>>;
  directorySize(input: { hostId: string; path: string }): Promise<Record<string, unknown>>;
  createFolder(input: { hostId: string; path: string; name: string }): Promise<{ entry: FileEntry }>;
  renameEntry(input: { hostId: string; path: string; newName: string }): Promise<{ entry: FileEntry }>;
  deleteEntries(input: { hostId: string; paths: string[]; recursive: boolean }): Promise<{ succeeded: string[]; failed: Array<{ path: string; code: any; message: string }> }>;
  moveEntries(input: { hostId: string; paths: string[]; destinationDir: string; conflict: "rename" | "overwrite" | "fail" }): Promise<{ succeeded: string[]; failed: Array<{ path: string; code: any; message: string }> }>;
  copyEntries(input: { hostId: string; paths: string[]; destinationDir: string; conflict: "rename" | "overwrite" | "fail" }): Promise<{ succeeded: string[]; failed: Array<{ path: string; code: any; message: string }> }>;
  writeFile(input: { hostId: string; path: string; content: string; contentEncoding: "base64" | "utf8" }): Promise<void>;
  uploadFile(input: { hostId: string; dirPath: string; relativeDir: string; fileName: string; content: string; conflict: "rename" | "overwrite" | "fail" }): Promise<{ entry: FileEntry }>;
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
  if (/permission|access denied|not permitted/iu.test(message)) throw fmError("permission_denied", detail);
  if (/already exists|file exists/iu.test(message)) throw fmError("exists", detail);
  if (/not empty|directory not empty/iu.test(message)) throw fmError("not_empty", detail);
  if (/not a directory/iu.test(message)) throw fmError("not_a_directory", detail);
  if (/is a directory/iu.test(message)) throw fmError("not_a_file", detail);
  if (/invalid.*name/iu.test(message)) throw fmError("invalid_name", detail);
  if (/not found|no such|unknown host|disconnected|offline|unavailable/iu.test(message)) {
    throw fmError("not_found", detail);
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
        machine: { id: host.id, name: host.name, status: "connected", root, readOnly: false },
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
              readOnly: false,
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
      writable: true,
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

  async function entryAt(hostId: string, requested: string): Promise<FileEntry> {
    const target = await loadMachine(hostId);
    const absolute = rootPath(target.root!, requested);
    if (absolute === target.root) {
      return entryFor(target.root!, { name: pathApi(target.root!).basename(absolute), path: absolute, kind: "directory" });
    }
    const parent = pathApi(target.root!).dirname(absolute);
    const listing = await listDir({ hostId, path: parent, showHidden: true });
    const entry = listing.entries.find((candidate) => candidate.path === absolute);
    if (entry === undefined) throw fmError("not_found", absolute);
    if (entry.kind === "file") {
      try {
        const content = await readFile({ hostId, path: absolute });
        return { ...entry, sizeBytes: content.sizeBytes, modifiedAtMs: content.modifiedAtMs ?? 0, metadataAvailable: true };
      } catch {
        return entry;
      }
    }
    return entry;
  }

  async function remoteExists(hostId: string, requested: string): Promise<boolean> {
    try {
      await entryAt(hostId, requested);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("not_found:")) return false;
      throw error;
    }
  }

  async function uniqueRemoteName(hostId: string, dir: string, name: string): Promise<string> {
    validateName(name);
    if (!(await remoteExists(hostId, pathApi(dir).join(dir, name)))) return name;
    const extension = pathApi(dir).extname(name);
    const stem = extension === "" || extension === name ? name : name.slice(0, -extension.length);
    for (let index = 1; index < 10_000; index += 1) {
      const candidate = `${stem} (${index})${extension}`;
      if (!(await remoteExists(hostId, pathApi(dir).join(dir, candidate)))) return candidate;
    }
    throw fmError("exists", pathApi(dir).join(dir, name));
  }

  function batchFailure(requested: string, error: unknown): { path: string; code: any; message: string } {
    const message = error instanceof Error ? error.message : String(error);
    const [code, ...rest] = message.split(": ");
    const known = new Set(["invalid_path", "invalid_name", "path_escape", "not_found", "not_a_directory", "not_a_file", "exists", "not_empty", "permission_denied", "cross_device", "destination_inside_source", "unsupported_archive", "archive_failed", "upload_not_found", "upload_busy", "offset_mismatch", "size_mismatch", "no_space", "io_error", "unsupported"]);
    return { path: requested, code: known.has(code) ? code : "io_error", message: rest.join(": ") || message };
  }

  async function searchDir(input: { hostId: string; path: string; query: string; showHidden: boolean; maxDepth: number }) {
    const target = await loadMachine(input.hostId);
    const absolute = rootPath(target.root!, input.path);
    try {
      const result = await bb.sdk.files.listPaths({
        hostId: input.hostId,
        path: absolute,
        query: input.query,
        limit: MAX_SEARCH_RESULTS,
        includeFiles: true,
        includeDirectories: true,
        includeHidden: input.showHidden,
        excludeNames: [],
      });
      const api = pathApi(target.root!);
      const entries: FileEntry[] = [];
      for (const item of result.paths) {
        const candidate = rootPath(target.root!, item.path);
        const relative = api.relative(absolute, candidate);
        const depth = relative === "" ? 0 : relative.split(api.sep).length;
        if (depth > Math.min(MAX_SEARCH_DEPTH, input.maxDepth)) continue;
        const kind = item.kind === "directory" ? "directory" : "file";
        if (!input.showHidden && hiddenName(item.name)) continue;
        entries.push(entryFor(target.root!, { name: item.name, path: candidate, kind }));
      }
      return { entries, truncated: result.truncated || entries.length >= MAX_SEARCH_RESULTS };
    } catch (error) {
      mapRemoteError(error, `could not search ${absolute}`);
    }
  }

  async function pathProperties(input: { hostId: string; path: string }) {
    const target = await loadMachine(input.hostId);
    const entry = await entryAt(input.hostId, input.path);
    let sizeBytes = entry.sizeBytes;
    if (entry.kind === "file") {
      try {
        sizeBytes = (await readFile({ hostId: input.hostId, path: entry.path })).sizeBytes;
      } catch {
        /* retain the listing value when the file is unreadable */
      }
    }
    const api = pathApi(target.root!);
    return {
      name: entry.name,
      path: entry.path,
      parentPath: entry.path === target.root ? null : api.dirname(entry.path),
      kind: entry.kind,
      targetKind: entry.targetKind,
      isSymlink: false,
      escapesRoot: false,
      linkTarget: null,
      linkTargetPath: null,
      sizeBytes,
      modifiedAtMs: entry.modifiedAtMs,
      createdAtMs: null,
      accessedAtMs: entry.modifiedAtMs,
      modeOctal: "0000",
      modeText: entry.kind === "directory" ? "d---------" : "----------",
      ownerUid: 0,
      ownerGid: 0,
      ownerName: null,
      linkCount: 1,
      contentType: contentTypeOf(entry.name),
    };
  }

  async function directorySize(input: { hostId: string; path: string }) {
    const started = Date.now();
    const target = await loadMachine(input.hostId);
    const rootEntry = await entryAt(input.hostId, input.path);
    if (rootEntry.kind !== "directory") throw fmError("not_a_directory", rootEntry.path);
    const api = pathApi(target.root!);
    const queue: Array<{ path: string; depth: number }> = [{ path: rootEntry.path, depth: 0 }];
    let sizeBytes = 0;
    let fileCount = 0;
    let directoryCount = 1;
    let visitedEntries = 0;
    let partial = false;
    let stoppedBy: "depth" | "entries" | "time" | null = null;
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visitedEntries >= 5000) { partial = true; stoppedBy = "entries"; break; }
      if (Date.now() - started > 2_000) { partial = true; stoppedBy = "time"; break; }
      if (current.depth >= MAX_SEARCH_DEPTH) { partial = true; stoppedBy = "depth"; continue; }
      const listing = await listDir({ hostId: input.hostId, path: current.path, showHidden: true });
      for (const entry of listing.entries) {
        visitedEntries += 1;
        if (entry.kind === "directory") {
          directoryCount += 1;
          queue.push({ path: entry.path, depth: current.depth + 1 });
        } else if (entry.kind === "file") {
          fileCount += 1;
          try { sizeBytes += (await readFile({ hostId: input.hostId, path: entry.path })).sizeBytes; }
          catch { partial = true; stoppedBy ??= "time"; }
        }
      }
    }
    return { path: rootEntry.path, sizeBytes, fileCount, directoryCount, visitedEntries, partial, stoppedBy, elapsedMs: Date.now() - started };
  }

  async function createFolder(input: { hostId: string; path: string; name: string }) {
    const target = await loadMachine(input.hostId);
    validateName(input.name);
    const parent = rootPath(target.root!, input.path);
    const destination = pathApi(target.root!).join(parent, input.name);
    if (!inside(target.root!, destination)) throw fmError("path_escape", destination);
    try {
      await bb.sdk.files.mkdir({ hostId: input.hostId, path: destination, rootPath: target.root!, recursive: false });
      return { entry: await entryAt(input.hostId, destination) };
    } catch (error) {
      mapRemoteError(error, `could not create ${destination}`);
    }
  }

  async function renameEntry(input: { hostId: string; path: string; newName: string }) {
    const target = await loadMachine(input.hostId);
    const source = rootPath(target.root!, input.path);
    validateName(input.newName);
    const destination = pathApi(target.root!).join(pathApi(target.root!).dirname(source), input.newName);
    if (!inside(target.root!, destination)) throw fmError("path_escape", destination);
    if (await remoteExists(input.hostId, destination)) throw fmError("exists", destination);
    try {
      await bb.sdk.files.move({ hostId: input.hostId, sourcePath: source, destinationPath: destination, rootPath: target.root! });
      return { entry: await entryAt(input.hostId, destination) };
    } catch (error) {
      mapRemoteError(error, `could not rename ${source}`);
    }
  }

  async function deleteEntries(input: { hostId: string; paths: string[]; recursive: boolean }) {
    const succeeded: string[] = [];
    const failed: Array<{ path: string; code: any; message: string }> = [];
    const target = await loadMachine(input.hostId);
    for (const requested of input.paths) {
      try {
        const absolute = rootPath(target.root!, requested);
        if (absolute === target.root) throw fmError("path_escape", absolute);
        await bb.sdk.files.remove({ hostId: input.hostId, path: absolute, rootPath: target.root!, recursive: input.recursive });
        succeeded.push(requested);
      } catch (error) { failed.push(batchFailure(requested, error)); }
    }
    return { succeeded, failed };
  }

  async function moveEntries(input: { hostId: string; paths: string[]; destinationDir: string; conflict: "rename" | "overwrite" | "fail" }) {
    const succeeded: string[] = [];
    const failed: Array<{ path: string; code: any; message: string }> = [];
    const target = await loadMachine(input.hostId);
    const destinationDir = rootPath(target.root!, input.destinationDir);
    for (const requested of input.paths) {
      try {
        const source = rootPath(target.root!, requested);
        const name = pathApi(target.root!).basename(source);
        let destination = pathApi(target.root!).join(destinationDir, name);
        if (await remoteExists(input.hostId, destination)) {
          if (input.conflict === "fail") throw fmError("exists", destination);
          if (input.conflict === "rename") destination = pathApi(target.root!).join(destinationDir, await uniqueRemoteName(input.hostId, destinationDir, name));
          else await bb.sdk.files.remove({ hostId: input.hostId, path: destination, rootPath: target.root!, recursive: true });
        }
        await bb.sdk.files.move({ hostId: input.hostId, sourcePath: source, destinationPath: destination, rootPath: target.root! });
        succeeded.push(requested);
      } catch (error) { failed.push(batchFailure(requested, error)); }
    }
    return { succeeded, failed };
  }

  async function copyOne(hostId: string, root: string, source: string, destination: string): Promise<void> {
    const entry = await entryAt(hostId, source);
    if (entry.kind === "directory") {
      await bb.sdk.files.mkdir({ hostId, path: destination, rootPath: root, recursive: false });
      const listing = await listDir({ hostId, path: source, showHidden: true });
      for (const child of listing.entries) await copyOne(hostId, root, child.path, pathApi(root).join(destination, child.name));
      return;
    }
    const file = await readFile({ hostId, path: source });
    await bb.sdk.files.write({ hostId, path: destination, rootPath: root, content: file.content, contentEncoding: file.contentEncoding, createParents: false });
  }

  async function copyEntries(input: { hostId: string; paths: string[]; destinationDir: string; conflict: "rename" | "overwrite" | "fail" }) {
    const succeeded: string[] = [];
    const failed: Array<{ path: string; code: any; message: string }> = [];
    const target = await loadMachine(input.hostId);
    const destinationDir = rootPath(target.root!, input.destinationDir);
    for (const requested of input.paths) {
      try {
        const source = rootPath(target.root!, requested);
        const name = pathApi(target.root!).basename(source);
        let destination = pathApi(target.root!).join(destinationDir, name);
        if (await remoteExists(input.hostId, destination)) {
          if (input.conflict === "fail") throw fmError("exists", destination);
          if (input.conflict === "rename") destination = pathApi(target.root!).join(destinationDir, await uniqueRemoteName(input.hostId, destinationDir, name));
          else await bb.sdk.files.remove({ hostId: input.hostId, path: destination, rootPath: target.root!, recursive: true });
        }
        await copyOne(input.hostId, target.root!, source, destination);
        succeeded.push(requested);
      } catch (error) { failed.push(batchFailure(requested, error)); }
    }
    return { succeeded, failed };
  }

  async function writeFile(input: { hostId: string; path: string; content: string; contentEncoding: "base64" | "utf8" }): Promise<void> {
    const target = await loadMachine(input.hostId);
    const destination = rootPath(target.root!, input.path);
    const bytes = input.contentEncoding === "base64" ? Buffer.from(input.content, "base64") : Buffer.from(input.content, "utf8");
    if (bytes.byteLength > MAX_REMOTE_FILE_BYTES) throw fmError("unsupported", `remote files are limited to ${MAX_REMOTE_FILE_BYTES} bytes`);
    try {
      await bb.sdk.files.write({ hostId: input.hostId, path: destination, rootPath: target.root!, content: input.content, contentEncoding: input.contentEncoding, createParents: false });
    } catch (error) {
      mapRemoteError(error, `could not write ${destination}`);
    }
  }

  async function uploadFile(input: { hostId: string; dirPath: string; relativeDir: string; fileName: string; content: string; conflict: "rename" | "overwrite" | "fail" }) {
    const target = await loadMachine(input.hostId);
    const api = pathApi(target.root!);
    validateName(input.fileName);
    let destinationDir = rootPath(target.root!, input.dirPath);
    for (const segment of input.relativeDir.split("/").filter(Boolean)) {
      validateName(segment);
      destinationDir = api.join(destinationDir, segment);
      if (!(await remoteExists(input.hostId, destinationDir))) {
        await bb.sdk.files.mkdir({ hostId: input.hostId, path: destinationDir, rootPath: target.root!, recursive: false });
      }
    }
    let destination = api.join(destinationDir, input.fileName);
    if (await remoteExists(input.hostId, destination)) {
      if (input.conflict === "fail") throw fmError("exists", destination);
      if (input.conflict === "rename") destination = api.join(destinationDir, await uniqueRemoteName(input.hostId, destinationDir, input.fileName));
      else await bb.sdk.files.remove({ hostId: input.hostId, path: destination, rootPath: target.root!, recursive: true });
    }
    await writeFile({ hostId: input.hostId, path: destination, content: input.content, contentEncoding: "base64" });
    return { entry: await entryAt(input.hostId, destination) };
  }

  return { listMachines, listDir, statPath, createPreviewUrl, readTextFile, readFile, searchDir, pathProperties, directorySize, createFolder, renameEntry, deleteEntries, moveEntries, copyEntries, writeFile, uploadFile };
}

