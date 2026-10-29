import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"

const DirectoryQuery = Schema.Struct({
  directory: Schema.optional(Schema.String),
  global: Schema.optional(Schema.String),
})

const FilesPayload = Schema.Struct({ files: Schema.Array(Schema.String) })
const Output = Schema.Struct({ output: Schema.String })
const BranchPayload = Schema.Struct({ branch: Schema.String })
const BranchResult = Schema.Struct({ branch: Schema.String })
const CommitPayload = Schema.Struct({ message: Schema.String })
const OperationPayload = Schema.Struct({
  action: Schema.String,
  argument: Schema.optional(Schema.String),
})
const HistoryItem = Schema.Struct({
  hash: Schema.String,
  shortHash: Schema.String,
  author: Schema.String,
  timestamp: Schema.Number,
  subject: Schema.String,
})
const SubRepo = Schema.Struct({ worktree: Schema.String })
const SubRepos = Schema.Struct({
  directory: Schema.String,
  repos: Schema.Array(SubRepo),
})
const WorktreeDetail = Schema.Struct({
  name: Schema.String,
  branch: Schema.optional(Schema.String),
  directory: Schema.String,
  dirty: Schema.Boolean,
  managed: Schema.Boolean,
  sizeBytes: Schema.Number,
  fileCount: Schema.Number,
  measuredCompletely: Schema.Boolean,
  createdAt: Schema.Number,
  modifiedAt: Schema.Number,
})
const WorktreeResetPayload = Schema.Struct({ directory: Schema.String })
const ConfigPatch = Schema.Record(Schema.String, Schema.Unknown)

const Capabilities = Schema.Struct({
  apiVersion: Schema.Number,
  backgroundSubagents: Schema.Boolean,
  worktree: Schema.Boolean,
  worktreeBaseBranch: Schema.Boolean,
  vcsMutations: Schema.Boolean,
  workspaceCheckpoints: Schema.Boolean,
  advancedVcs: Schema.Boolean,
  checkpointRegistry: Schema.Boolean,
  memory: Schema.Boolean,
  hooks: Schema.Boolean,
  pullRequests: Schema.Boolean,
})

const GoalHistoryEntry = Schema.Struct({
  type: Schema.String,
  detail: Schema.String,
  timestamp: Schema.Number,
})
const Goal = Schema.Struct({
  sessionID: Schema.String,
  objective: Schema.String,
  status: Schema.Literals(["active", "paused", "complete", "blocked"]),
  step: Schema.Number,
  statusMessage: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  pausedAt: Schema.NullOr(Schema.Number),
  completedAt: Schema.NullOr(Schema.Number),
  evidence: Schema.NullOr(Schema.String),
  blocker: Schema.NullOr(Schema.String),
  history: Schema.Array(GoalHistoryEntry),
})
const GoalResponse = Schema.Struct({ goal: Schema.NullOr(Goal) })
const GoalStatusPayload = Schema.Struct({ status: Schema.Literals(["active", "paused"]) })

const HookEvent = Schema.Literals(["automation.before", "automation.after", "git.before", "git.after", "notification"])
const HookDefinition = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  event: HookEvent,
  command: Schema.String,
  enabled: Schema.Boolean,
  approved: Schema.Boolean,
  sandbox: Schema.Boolean,
  timeoutSeconds: Schema.Number,
})
const HookRun = Schema.Struct({
  id: Schema.String,
  hookID: Schema.String,
  hookName: Schema.String,
  event: HookEvent,
  status: Schema.Literals(["completed", "failed", "timed_out", "blocked"]),
  sandboxed: Schema.Boolean,
  output: Schema.String,
  startedAt: Schema.Number,
  completedAt: Schema.Number,
})
const HookState = Schema.Struct({ hooks: Schema.Array(HookDefinition), runs: Schema.Array(HookRun) })
const HookUpdatePayload = Schema.Struct({ hooks: Schema.Array(HookDefinition) })
const HookRunPayload = Schema.Struct({ event: HookEvent })

const MemorySourceID = Schema.Literals(["global", "project", "workspace"])
const MemorySource = Schema.Struct({
  id: MemorySourceID,
  name: Schema.String,
  path: Schema.String,
  scope: MemorySourceID,
  exists: Schema.Boolean,
  content: Schema.String,
})
const MemoryUpdatePayload = Schema.Struct({ content: Schema.String })
const MemoryCapturePayload = Schema.Struct({ content: Schema.String })

const CheckpointEntry = Schema.Struct({
  id: Schema.String,
  snapshot: Schema.String,
  sessionID: Schema.String,
  directory: Schema.String,
  label: Schema.String,
  createdAt: Schema.Number,
})
const CheckpointListQuery = Schema.Struct({
  directory: Schema.optional(Schema.String),
  sessionID: Schema.optional(Schema.String),
})
const CheckpointCreatePayload = Schema.Struct({ sessionID: Schema.String, label: Schema.String })
const CheckpointRestorePayload = Schema.Struct({ id: Schema.String })
const CheckpointRestoreResult = Schema.Struct({ backupID: Schema.String })


export const OpencodexGroup = HttpApiGroup.make("server.opencodex")
  .add(
    HttpApiEndpoint.get("opencodex.capabilities", "/experimental/capabilities", {
      query: DirectoryQuery,
      success: Capabilities,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "opencodex.capabilities",
        summary: "Server capabilities",
        description: "Report the OpenCodex feature set available on this server.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("opencodex.config.patch", "/experimental/config", {
      query: DirectoryQuery,
      payload: ConfigPatch,
      success: HttpApiSchema.NoContent,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "opencodex.config.patch",
        summary: "Patch config",
        description: "Deep-merge configuration fields into the active project or global config document.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("opencodex.provider.refresh", "/provider/refresh", {
      query: DirectoryQuery,
      success: HttpApiSchema.NoContent,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "opencodex.provider.refresh",
        summary: "Refresh provider catalog",
        description: "Force a models.dev catalog refresh.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("opencodex.project.subrepos", "/project/subrepos", {
      query: DirectoryQuery,
      success: SubRepos,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "opencodex.project.subrepos",
        summary: "Discover nested git repositories",
        description: "List git repositories found in the immediate subdirectories of a non-git project.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("opencodex.vcs.branch", "/vcs/branch", {
      query: DirectoryQuery,
      payload: BranchPayload,
      success: BranchResult,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "opencodex.vcs.branch.switch",
        summary: "Switch branch",
        description: "Switch the current git project to an existing local or remote branch.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("opencodex.vcs.stage", "/vcs/stage", {
      query: DirectoryQuery,
      payload: FilesPayload,
      success: Output,
    }).annotateMerge(OpenApi.annotations({ identifier: "opencodex.vcs.stage", summary: "Stage files" })),
  )
  .add(
    HttpApiEndpoint.post("opencodex.vcs.unstage", "/vcs/unstage", {
      query: DirectoryQuery,
      payload: FilesPayload,
      success: Output,
    }).annotateMerge(OpenApi.annotations({ identifier: "opencodex.vcs.unstage", summary: "Unstage files" })),
  )
  .add(
    HttpApiEndpoint.post("opencodex.vcs.discard", "/vcs/discard", {
      query: DirectoryQuery,
      payload: FilesPayload,
      success: Output,
    }).annotateMerge(OpenApi.annotations({ identifier: "opencodex.vcs.discard", summary: "Discard changes" })),
  )
  .add(
    HttpApiEndpoint.post("opencodex.vcs.commit", "/vcs/commit", {
      query: DirectoryQuery,
      payload: CommitPayload,
      success: Output,
    }).annotateMerge(OpenApi.annotations({ identifier: "opencodex.vcs.commit", summary: "Commit changes" })),
  )
  .add(
    HttpApiEndpoint.post("opencodex.vcs.push", "/vcs/push", {
      query: DirectoryQuery,
      success: Output,
    }).annotateMerge(OpenApi.annotations({ identifier: "opencodex.vcs.push", summary: "Push branch" })),
  )
  .add(
    HttpApiEndpoint.post("opencodex.vcs.operation", "/vcs/operation", {
      query: DirectoryQuery,
      payload: OperationPayload,
      success: Output,
    }).annotateMerge(OpenApi.annotations({ identifier: "opencodex.vcs.operation", summary: "Run git operation" })),
  )
  .add(
    HttpApiEndpoint.get("opencodex.vcs.history", "/vcs/history", {
      query: Schema.Struct({
        directory: Schema.optional(Schema.String),
        limit: Schema.optional(Schema.NumberFromString),
      }),
      success: Schema.Array(HistoryItem),
    }).annotateMerge(OpenApi.annotations({ identifier: "opencodex.vcs.history", summary: "Get git history" })),
  )
  .add(
    HttpApiEndpoint.get("opencodex.worktree.details", "/experimental/worktree/details", {
      query: DirectoryQuery,
      success: Schema.Array(WorktreeDetail),
    }).annotateMerge(
      OpenApi.annotations({ identifier: "opencodex.worktree.details", summary: "List worktree details" }),
    ),
  )
  .add(
    HttpApiEndpoint.post("opencodex.worktree.reset", "/experimental/worktree/reset", {
      query: DirectoryQuery,
      payload: WorktreeResetPayload,
      success: HttpApiSchema.NoContent,
    }).annotateMerge(OpenApi.annotations({ identifier: "opencodex.worktree.reset", summary: "Reset worktree" })),
  )
  .add(
    HttpApiEndpoint.get("opencodex.goal.get", "/experimental/goal/:sessionID", {
      params: { sessionID: Schema.String },
      query: DirectoryQuery,
      success: GoalResponse,
    }).annotateMerge(OpenApi.annotations({ identifier: "opencodex.goal.get", summary: "Get session goal" })),
  )
  .add(
    HttpApiEndpoint.post("opencodex.goal.status", "/experimental/goal/:sessionID/status", {
      params: { sessionID: Schema.String },
      query: DirectoryQuery,
      payload: GoalStatusPayload,
      success: GoalResponse,
    }).annotateMerge(OpenApi.annotations({ identifier: "opencodex.goal.status", summary: "Set goal status" })),
  )
  .add(
    HttpApiEndpoint.delete("opencodex.goal.clear", "/experimental/goal/:sessionID", {
      params: { sessionID: Schema.String },
      query: DirectoryQuery,
      success: Schema.Boolean,
    }).annotateMerge(OpenApi.annotations({ identifier: "opencodex.goal.clear", summary: "Clear session goal" })),
  )
  .add(
    HttpApiEndpoint.get("opencodex.hooks.get", "/experimental/hooks", {
      query: DirectoryQuery,
      success: HookState,
    }).annotateMerge(OpenApi.annotations({ identifier: "opencodex.hooks.get", summary: "Get hooks" })),
  )
  .add(
    HttpApiEndpoint.put("opencodex.hooks.update", "/experimental/hooks", {
      query: DirectoryQuery,
      payload: HookUpdatePayload,
      success: HookState,
    }).annotateMerge(OpenApi.annotations({ identifier: "opencodex.hooks.update", summary: "Update hooks" })),
  )
  .add(
    HttpApiEndpoint.post("opencodex.hooks.run", "/experimental/hooks/run", {
      query: DirectoryQuery,
      payload: HookRunPayload,
      success: Schema.Array(HookRun),
    }).annotateMerge(OpenApi.annotations({ identifier: "opencodex.hooks.run", summary: "Run hooks" })),
  )
  .add(
    HttpApiEndpoint.get("opencodex.memory.get", "/experimental/memory/:sourceID", {
      params: { sourceID: MemorySourceID },
      query: DirectoryQuery,
      success: MemorySource,
    }).annotateMerge(OpenApi.annotations({ identifier: "opencodex.memory.get", summary: "Get memory source" })),
  )
  .add(
    HttpApiEndpoint.put("opencodex.memory.update", "/experimental/memory/:sourceID", {
      params: { sourceID: MemorySourceID },
      query: DirectoryQuery,
      payload: MemoryUpdatePayload,
      success: MemorySource,
    }).annotateMerge(OpenApi.annotations({ identifier: "opencodex.memory.update", summary: "Update memory source" })),
  )
  .add(
    HttpApiEndpoint.post("opencodex.memory.capture", "/experimental/memory/capture", {
      query: DirectoryQuery,
      payload: MemoryCapturePayload,
      success: MemorySource,
    }).annotateMerge(OpenApi.annotations({ identifier: "opencodex.memory.capture", summary: "Capture workspace memory" })),
  )
  .add(
    HttpApiEndpoint.get("opencodex.checkpoint.list", "/experimental/checkpoint", {
      query: CheckpointListQuery,
      success: Schema.Array(CheckpointEntry),
    }).annotateMerge(OpenApi.annotations({ identifier: "opencodex.checkpoint.list", summary: "List checkpoints" })),
  )
  .add(
    HttpApiEndpoint.post("opencodex.checkpoint.create", "/experimental/checkpoint", {
      query: DirectoryQuery,
      payload: CheckpointCreatePayload,
      success: CheckpointEntry,
    }).annotateMerge(OpenApi.annotations({ identifier: "opencodex.checkpoint.create", summary: "Create checkpoint" })),
  )
  .add(
    HttpApiEndpoint.post("opencodex.checkpoint.restore", "/experimental/checkpoint/restore", {
      query: DirectoryQuery,
      payload: CheckpointRestorePayload,
      success: CheckpointRestoreResult,
    }).annotateMerge(OpenApi.annotations({ identifier: "opencodex.checkpoint.restore", summary: "Restore checkpoint" })),
  )
  .add(
    HttpApiEndpoint.delete("opencodex.checkpoint.delete", "/experimental/checkpoint/:checkpointID", {
      params: { checkpointID: Schema.String },
      query: DirectoryQuery,
      success: Schema.Boolean,
    }).annotateMerge(OpenApi.annotations({ identifier: "opencodex.checkpoint.delete", summary: "Delete checkpoint" })),
  )
  .add(
    HttpApiEndpoint.get("opencodex.checkpoint.diff", "/experimental/checkpoint/:checkpointID/diff", {
      params: { checkpointID: Schema.String },
      query: DirectoryQuery,
      success: Schema.String,
    }).annotateMerge(OpenApi.annotations({ identifier: "opencodex.checkpoint.diff", summary: "Checkpoint diff" })),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencodex",
      description: "OpenCodex fork routes that extend the OpenCode V2 API surface.",
    }),
  )
