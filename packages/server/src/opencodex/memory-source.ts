import path from "path"

export type MemorySourceID = "global" | "project" | "workspace"

export interface MemorySourceContext {
  globalConfig: string
  directory: string
  worktree: string
}

export function memorySourceDefinitions(ctx: MemorySourceContext) {
  const projectRoot =
    path.resolve(ctx.worktree) === path.parse(path.resolve(ctx.worktree)).root ? ctx.directory : ctx.worktree
  return [
    {
      id: "global" as const,
      name: "Global memory",
      path: path.join(ctx.globalConfig, "memory.md"),
      scope: "global" as const,
    },
    {
      id: "project" as const,
      name: "Project instructions",
      path: path.join(projectRoot, "AGENTS.md"),
      scope: "project" as const,
    },
    {
      id: "workspace" as const,
      name: "Workspace memory",
      path: path.join(ctx.directory, ".opencode", "memory.md"),
      scope: "workspace" as const,
    },
  ]
}

export function memorySourceDefinition(ctx: MemorySourceContext, id: MemorySourceID) {
  return memorySourceDefinitions(ctx).find((item) => item.id === id)
}
