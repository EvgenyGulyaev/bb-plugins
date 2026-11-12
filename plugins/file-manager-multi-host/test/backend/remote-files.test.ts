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
        readOnly: true,
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
    expect(listed.writable).toBe(false);
    await expect(remote.readTextFile({ hostId: "host_remote", path: "/home/remote/docs/readme.txt" })).resolves.toMatchObject({
      text: "hello",
      sizeBytes: 5,
    });
    await host.harness.lifecycle.dispose();
  });
});
