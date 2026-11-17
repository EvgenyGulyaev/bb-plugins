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

export function dedupeProjectPaths(items: ProjectPathItem[]): ProjectPathItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.path)) return false;
    seen.add(item.path);
    return true;
  });
}
