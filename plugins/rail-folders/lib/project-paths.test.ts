import { describe, expect, it } from "vitest";

import {
  checkoutLabel,
  dedupeProjectPaths,
  isUsableCheckoutPath,
  projectPathsInputSchema,
  projectPathsOutputSchema,
  type ProjectPathItem,
} from "./project-paths";

function item(partial: Partial<ProjectPathItem> & { path: string }): ProjectPathItem {
  return {
    projectId: "proj_1",
    projectName: "picker-routes",
    ...partial,
  };
}

describe("project_paths input", () => {
  it("trims the project name and rejects a blank one", () => {
    expect(projectPathsInputSchema.parse({ projectName: "  picker-routes " })).toEqual({
      projectName: "picker-routes",
    });
    expect(projectPathsInputSchema.safeParse({ projectName: "   " }).success).toBe(false);
    expect(projectPathsInputSchema.safeParse({}).success).toBe(false);
  });
});

describe("project_paths output", () => {
  it("keeps the optional environment fields off the wire when they are unknown", () => {
    const payload = { items: [item({ path: "/work/picker-routes" })] };
    expect(projectPathsOutputSchema.parse(payload)).toEqual(payload);
    expect("environmentName" in payload.items[0]!).toBe(false);
    expect("branchName" in payload.items[0]!).toBe(false);
  });

  it("requires a path on every item", () => {
    expect(
      projectPathsOutputSchema.safeParse({
        items: [{ projectId: "p", projectName: "n" }],
      }).success,
    ).toBe(false);
    expect(
      projectPathsOutputSchema.safeParse({ items: [item({ path: "" })] }).success,
    ).toBe(false);
  });
});

describe("dedupeProjectPaths", () => {
  it("keeps the first record per checkout path", () => {
    const first = item({ environmentName: "main", path: "/work/picker-routes" });
    const duplicate = item({
      projectId: "proj_2",
      environmentName: "copy",
      path: "/work/picker-routes",
    });
    const other = item({ environmentName: "feat", path: "/work/picker-routes-feat" });

    expect(dedupeProjectPaths([first, duplicate, other])).toEqual([first, other]);
  });

  it("returns an empty list unchanged", () => {
    expect(dedupeProjectPaths([])).toEqual([]);
  });
});

describe("isUsableCheckoutPath", () => {
  const tmp = "/var/folders/2n/test/T";

  it("rejects missing, empty and blank paths", () => {
    expect(isUsableCheckoutPath(null, tmp)).toBe(false);
    expect(isUsableCheckoutPath(undefined, tmp)).toBe(false);
    expect(isUsableCheckoutPath("", tmp)).toBe(false);
    expect(isUsableCheckoutPath("   ", tmp)).toBe(false);
  });

  it("rejects bb temporary checkouts inside the platform tmpdir", () => {
    expect(isUsableCheckoutPath(`${tmp}/bb-x5-connect-1`, tmp)).toBe(false);
    expect(isUsableCheckoutPath(`${tmp}/bb-x5-connect-1`, `${tmp}/`)).toBe(false);
    expect(isUsableCheckoutPath(tmp, tmp)).toBe(false);
  });

  it("keeps real checkouts and sibling prefixes of the tmpdir", () => {
    expect(isUsableCheckoutPath("/Users/dev/work/repo", tmp)).toBe(true);
    expect(isUsableCheckoutPath("/var/folders/2n/test/T2/repo", tmp)).toBe(true);
  });
});

describe("checkoutLabel", () => {
  it("prefers the environment name", () => {
    expect(checkoutLabel({ name: "main", branchName: "dev", isWorktree: true })).toBe("main");
  });

  it("marks unnamed worktrees with their branch", () => {
    expect(checkoutLabel({ name: null, branchName: "feat/x", isWorktree: true })).toBe(
      "worktree feat/x",
    );
    expect(checkoutLabel({ name: null, branchName: null, isWorktree: true })).toBe("worktree");
  });

  it("falls back to the branch and then to a generic label", () => {
    expect(checkoutLabel({ name: null, branchName: "dev", isWorktree: false })).toBe("dev");
    expect(checkoutLabel({ name: null, branchName: null, isWorktree: false })).toBe("чекаут");
  });
});
