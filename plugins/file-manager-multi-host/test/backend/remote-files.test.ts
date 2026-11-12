import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { createRemoteFiles } from "../../src/remote-files";

const remoteHost = {
  id: "host_remote",
  name: "Remote machine",
  status: "connected",
  type: "persistent",
  lifecycle: { phase: "active" },
} as never;

describe("remote file adapter", () => {
  it("lists connected machines and keeps the home root", async () => {
    const host = createFakePluginHost({ pluginId: "file-manager" });
    host.harness.sdk.stub("hosts.list", async () => [remoteHost]);
    host.harness.sdk.stub("hosts.directory", async () => ({
      directory: "/home/remote",
      parent: null,
      roots: ["/home/remote"],
      entries: [],
    }));

    const remote = createRemoteFiles(host.bb);
    await expect(remote.listMachines()).resolves.toEqual([
      {
        id: "host_remote",
        name: "Remote machine",
        status: "connected",
        root: "/home/remote",
        readOnly: false,
      },
    ]);
    await host.harness.lifecycle.dispose();
  });

  it("filters hidden entries and reads text through the selected host", async () => {
    const host = createFakePluginHost({ pluginId: "file-manager" });
    host.harness.sdk.stub("hosts.get", async () => remoteHost);
    host.harness.sdk.stub("hosts.directory", async (input: { path?: string }) =>
      input.path === undefined
        ? { directory: "/home/remote", parent: null, roots: ["/home/remote"], entries: [] }
        : {
            directory: "/home/remote/docs",
            parent: "/home/remote",
            roots: ["/home/remote"],
            entries: [
              { kind: "file", name: "readme.txt", path: "/home/remote/docs/readme.txt" },
              { kind: "file", name: ".secret", path: "/home/remote/docs/.secret" },
            ],
          },
    );
    host.harness.sdk.stub("files.read", async () => ({
      path: "/home/remote/docs/readme.txt",
      content: "hello",
      contentEncoding: "utf8",
      sha256: "a".repeat(64),
      sizeBytes: 5,
      modifiedAtMs: 1,
    }));

    const remote = createRemoteFiles(host.bb);
    const listed = await remote.listDir({ hostId: "host_remote", path: "/home/remote/docs", showHidden: false });
    expect(listed.entries.map((entry) => entry.name)).toEqual(["readme.txt"]);
    expect(listed.writable).toBe(true);
    await expect(remote.readTextFile({ hostId: "host_remote", path: "/home/remote/docs/readme.txt" })).resolves.toMatchObject({
      text: "hello",
      sizeBytes: 5,
    });
    await host.harness.lifecycle.dispose();
  });

  it("uses host file operations for remote CRUD and search", async () => {
    const host = createFakePluginHost({ pluginId: "file-manager" });
    const root = "/home/remote";
    const entries = new Map<string, { kind: "directory" | "file"; name: string; path: string }[]>([
      [root, [{ kind: "directory", name: "docs", path: `${root}/docs` }]],
      [`${root}/docs`, [{ kind: "file", name: "old.txt", path: `${root}/docs/old.txt` }]],
    ]);
    host.harness.sdk.stub("hosts.get", async () => remoteHost);
    host.harness.sdk.stub("hosts.directory", async (input: { path?: string }) => {
      const directory = input.path ?? root;
      return { directory, parent: directory === root ? null : root, roots: [root], entries: entries.get(directory) ?? [] };
    });
    host.harness.sdk.stub("files.read", async (input: { path: string }) => ({
      path: input.path,
      content: "hello",
      contentEncoding: "utf8",
      sha256: "a".repeat(64),
      sizeBytes: 5,
      modifiedAtMs: 1,
    }));
    host.harness.sdk.stub("files.mkdir", async (input: { path: string }) => {
      const parent = input.path.slice(0, input.path.lastIndexOf("/"));
      const name = input.path.slice(input.path.lastIndexOf("/") + 1);
      const row = { kind: "directory" as const, name, path: input.path };
      entries.set(parent, [...(entries.get(parent) ?? []), row]);
      entries.set(input.path, []);
      return { ok: true };
    });
    host.harness.sdk.stub("files.move", async () => ({ ok: true }));
    host.harness.sdk.stub("files.remove", async () => ({ ok: true }));
    host.harness.sdk.stub("files.write", async () => ({ outcome: "written", sha256: "a".repeat(64), sizeBytes: 5 }));
    host.harness.sdk.stub("files.listPaths", async () => ({
      paths: [{ kind: "file", name: "old.txt", path: `${root}/docs/old.txt`, positions: [], score: 1 }],
      truncated: false,
    }));

    const remote = createRemoteFiles(host.bb);
    await expect(remote.createFolder({ hostId: "host_remote", path: root, name: "new" })).resolves.toMatchObject({ entry: { path: `${root}/new` } });
    await expect(remote.searchDir({ hostId: "host_remote", path: root, query: "old", showHidden: false, maxDepth: 4 })).resolves.toMatchObject({ entries: [{ path: `${root}/docs/old.txt` }] });
    await expect(remote.renameEntry({ hostId: "host_remote", path: `${root}/docs/old.txt`, newName: "new.txt" })).resolves.toMatchObject({ entry: { path: `${root}/docs/new.txt` } });
    await expect(remote.deleteEntries({ hostId: "host_remote", paths: [`${root}/docs/new.txt`], recursive: true })).resolves.toEqual({ succeeded: [`${root}/docs/new.txt`], failed: [] });
    await host.harness.lifecycle.dispose();
  });
});

