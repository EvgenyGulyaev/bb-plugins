import { z } from "zod";

// One checkout of a project: the environment that owns it and where it lives
// on disk. Optional fields are omitted instead of sent as null so the RPC
// payload stays plain JSON with no undefined values.
const projectPathItemSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  environmentName: z.string().min(1).optional(),
  path: z.string().min(1),
  branchName: z.string().min(1).optional(),
});

export type ProjectPathItem = z.infer<typeof projectPathItemSchema>;

export const projectPathsInputSchema = z.object({
  projectName: z.string().trim().min(1).max(200),
});

export const projectPathsOutputSchema = z.object({
  items: z.array(projectPathItemSchema),
});

// bb Connect and friends park ephemeral checkouts in the platform tmpdir;
// they are not the project's own pwd. ponytail: prefix compare only — a
// symlinked tmpdir would slip through; upgrade path is realpath() on the
// server if that ever shows up in practice.
export function isUsableCheckoutPath(
  path: string | null | undefined,
  tmpRoot: string,
): path is string {
  if (typeof path !== "string") return false;
  const trimmed = path.trim();
  if (!trimmed) return false;
  const root = tmpRoot.endsWith("/") ? tmpRoot.slice(0, -1) : tmpRoot;
  return trimmed !== root && !trimmed.startsWith(`${root}/`);
}

export function checkoutLabel(environment: {
  name?: string | null;
  branchName?: string | null;
  isWorktree?: boolean;
}): string {
  if (environment.name) return environment.name;
  if (environment.isWorktree) {
    return environment.branchName ? `worktree ${environment.branchName}` : "worktree";
  }
  return environment.branchName || "чекаут";
}

export function dedupeProjectPaths(items: ProjectPathItem[]): ProjectPathItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.path)) return false;
    seen.add(item.path);
    return true;
  });
}
