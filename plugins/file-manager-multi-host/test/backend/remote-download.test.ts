import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { DOWNLOAD_ROUTE, registerHttpRoutes } from "../../src/http-routes";

describe("remote download route", () => {
  it("returns bytes from the selected host with a safe filename", async () => {
    const host = createFakePluginHost({ pluginId: "file-manager" });
    registerHttpRoutes(host.bb, {
      uploads: {
        writeChunk: async () => ({ status: 400, body: { ok: false } }),
      },
      remote: {
        readFile: async () => ({
          path: "/home/remote/readme.txt",
          content: Buffer.from("hello").toString("base64"),
          contentEncoding: "base64",
          mimeType: "text/plain",
          sizeBytes: 5,
        }),
      },
    });

    const response = await host.harness.behavior.fetchHttp(
      "GET",
      `${DOWNLOAD_ROUTE}?hostId=host_remote&path=${encodeURIComponent("/home/remote/readme.txt")}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("content-disposition")).toContain("readme.txt");
    expect(await response.text()).toBe("hello");
    await host.harness.lifecycle.dispose();
  });
});
