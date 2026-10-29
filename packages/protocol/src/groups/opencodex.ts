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

export const OpencodexGroup = HttpApiGroup.make("server.opencodex")
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
  .annotateMerge(
    OpenApi.annotations({
      title: "opencodex",
      description: "OpenCodex fork routes that extend the OpenCode V2 API surface.",
    }),
  )
