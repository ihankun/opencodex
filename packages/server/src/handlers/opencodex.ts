import { Location } from "@opencode/core/location"
import { ModelsDev } from "@opencode/core/models-dev"
import { Snapshot } from "@opencode/core/snapshot"
import { Global } from "@opencode/util/global"
import { FSUtil } from "@opencode/util/fs-util"
import { Effect, Option } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import { applyEdits, modify, parse } from "jsonc-parser"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Api } from "../api"
import * as Checkpoint from "../opencodex/checkpoint"
import * as Goal from "../opencodex/goal"
import * as HookManager from "../opencodex/hooks"
import { memorySourceDefinition, type MemorySourceID } from "../opencodex/memory-source"

type GitResult = { code: number; stdout: string; stderr: string }

async function git(cwd: string, args: string[]): Promise<GitResult> {
  const { execFile } = await import("node:child_process")
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 20 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error && typeof error === "object" && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") })
      },
    )
  })
}

const runGit = (cwd: string, args: string[]) => Effect.promise(() => git(cwd, args))

const output = (result: GitResult) => [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n")

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) return patch
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    result[key] = key in result ? deepMerge(result[key], value) : value
  }
  return result
}

const literal = (file: string) => `:(literal)${file}`

export const OpencodexHandler = HttpApiBuilder.group(Api, "server.opencodex", (handlers) =>
  Effect.gen(function* () {
    const global = yield* Global.Service
    const fs = yield* FSUtil.Service
    const models = yield* ModelsDev.Service

    const configPath = Effect.fn("Opencodex.configPath")(function* (directory: string, globalConfig: boolean) {
      const root = globalConfig ? global.config : directory
      for (const name of ["opencode.jsonc", "opencode.json"]) {
        const candidate = path.join(root, name)
        if (yield* fs.exists(candidate)) return candidate
      }
      return path.join(root, "opencode.json")
    })

    const configPatch = (ctx: { payload: Record<string, unknown>; query: { directory?: string; global?: string } }) =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        const payload = { ...ctx.payload }
        const directory = typeof payload.directory === "string" ? payload.directory : undefined
        delete payload.directory
        const isGlobal = ctx.query.global === "true" || !directory
        const file = yield* configPath(location.directory, isGlobal)
        const text = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("{}")))
        const parsed = parse(text) ?? {}
        const current = isRecord(parsed) ? parsed : {}
        let edits: ReturnType<typeof modify> = []
        for (const [key, value] of Object.entries(payload)) {
          const merged = deepMerge(current[key], value)
          current[key] = merged
          edits = edits.concat(modify(text, [key], merged, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
        }
        yield* fs.writeFileString(file, applyEdits(text, edits))
        return HttpApiSchema.NoContent.make()
      }).pipe(Effect.orDie)

    const providerRefresh = () =>
      Effect.gen(function* () {
        yield* models.refresh(true)
        return HttpApiSchema.NoContent.make()
      })

    const projectSubrepos = () =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        const inside = yield* runGit(location.directory, ["rev-parse", "--is-inside-work-tree"])
        if (inside.stdout.trim() === "true") return { directory: location.directory, repos: [] }
        const root = yield* fs.resolve(location.directory).pipe(Effect.catch(() => Effect.succeed(location.directory)))
        const entries = yield* fs.readDirectoryEntries(location.directory).pipe(Effect.catch(() => Effect.succeed([])))
        const discovered = yield* Effect.forEach(
          entries.filter((entry) => entry.type === "directory"),
          (entry) =>
            Effect.gen(function* () {
              const sub = path.join(location.directory, entry.name)
              if (!(yield* fs.exists(path.join(sub, ".git")))) return undefined
              const result = yield* runGit(sub, ["rev-parse", "--show-toplevel"])
              if (result.code !== 0) return undefined
              const worktree = result.stdout.trim()
              if (!worktree || !FSUtil.contains(root, worktree)) return undefined
              return { worktree }
            }),
          { concurrency: "unbounded" },
        )
        return { directory: location.directory, repos: discovered.filter((repo): repo is { worktree: string } => !!repo) }
      }).pipe(Effect.orDie)

    const switchBranch = (ctx: { payload: { branch: string } }) =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        const branches = yield* runGit(location.directory, ["branch", "--list", ctx.payload.branch])
        if (branches.code !== 0 || !branches.stdout.trim()) {
          const remote = yield* runGit(location.directory, ["branch", "-r", "--list", `*/${ctx.payload.branch}`])
          const remoteName = remote.stdout.trim().split(/\r?\n/)[0]?.trim()
          if (!remoteName) return { branch: ctx.payload.branch }
          const result = yield* runGit(location.directory, ["switch", "--track", remoteName])
          if (result.code !== 0) return { branch: ctx.payload.branch }
          return { branch: ctx.payload.branch }
        }
        yield* runGit(location.directory, ["switch", ctx.payload.branch])
        return { branch: ctx.payload.branch }
      })

    const stage = (ctx: { payload: { files: readonly string[] } }) =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        const result = yield* runGit(location.directory, ["add", "--all", "--", ...ctx.payload.files.map(literal)])
        return { output: output(result) }
      })

    const unstage = (ctx: { payload: { files: readonly string[] } }) =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        const files = ctx.payload.files.map(literal)
        const head = yield* runGit(location.directory, ["rev-parse", "--verify", "HEAD"])
        const result = yield* runGit(
          location.directory,
          head.code === 0 ? ["reset", "HEAD", "--", ...files] : ["rm", "--cached", "-r", "--", ...files],
        )
        return { output: output(result) }
      })

    const discard = (ctx: { payload: { files: readonly string[] } }) =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        const selected = new Set(ctx.payload.files.map((file) => file.trim()))
        const status = yield* runGit(location.directory, ["status", "--porcelain", "-z"])
        const items = status.stdout
          .split("\0")
          .filter(Boolean)
          .flatMap((entry) => {
            const code = entry.slice(0, 2)
            const file = entry.slice(3)
            return file ? [{ code, file }] : []
          })
        const added = items
          .filter((item) => selected.has(item.file) && item.code[0] === "A")
          .map((item) => literal(item.file))
        const tracked = items
          .filter((item) => selected.has(item.file) && item.code !== "??" && item.code[0] !== "A")
          .map((item) => literal(item.file))
        const untracked = items
          .filter((item) => selected.has(item.file) && item.code === "??")
          .map((item) => literal(item.file))
        const commands = [
          ...(added.length ? [runGit(location.directory, ["rm", "--cached", "-f", "--", ...added])] : []),
          ...(tracked.length
            ? [runGit(location.directory, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked])]
            : []),
          ...(untracked.length || added.length
            ? [runGit(location.directory, ["clean", "-f", "--", ...untracked, ...added])]
            : []),
        ]
        const results = yield* Effect.forEach(commands, (command) => command, { concurrency: 1 })
        return { output: results.map(output).filter(Boolean).join("\n") }
      })

    const commit = (ctx: { payload: { message: string } }) =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        const message = ctx.payload.message.trim()
        if (!message || message.length > 10_000 || message.includes("\0")) return { output: "Invalid commit message" }
        const result = yield* runGit(location.directory, ["commit", "--message", message])
        return { output: output(result) }
      })

    const push = () =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        const upstream = yield* runGit(location.directory, [
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          "@{upstream}",
        ])
        if (upstream.code === 0) {
          const result = yield* runGit(location.directory, ["push"])
          return { output: output(result) }
        }
        const branch = yield* runGit(location.directory, ["branch", "--show-current"])
        const remotes = yield* runGit(location.directory, ["remote"])
        const list = remotes.stdout
          .split(/\r?\n/)
          .map((remote) => remote.trim())
          .filter(Boolean)
        const remote = list.includes("origin") ? "origin" : list[0]
        const name = branch.stdout.trim()
        if (!name || !remote) return { output: "Configure a Git remote before pushing this branch" }
        const result = yield* runGit(location.directory, ["push", "--set-upstream", remote, name])
        return { output: output(result) }
      })

    const operation = (ctx: { payload: { action: string; argument?: string } }) =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        const argument = ctx.payload.argument?.trim()
        const args =
          ctx.payload.action === "fetch"
            ? ["fetch", "--prune"]
            : ctx.payload.action === "pull"
              ? ["pull", "--ff-only"]
              : ctx.payload.action === "stash"
                ? ["stash", "push", "--include-untracked", "--message", argument || "OpenCodex stash"]
                : ctx.payload.action === "stash-pop"
                  ? ["stash", "pop"]
                  : ctx.payload.action === "create-branch"
                    ? ["switch", "--create", argument ?? ""]
                    : ctx.payload.action === "merge"
                      ? ["merge", "--no-edit", argument ?? ""]
                      : ctx.payload.action === "undo-commit"
                        ? ["reset", "--soft", "HEAD~1"]
                        : ["merge", "--abort"]
        if (
          (ctx.payload.action === "create-branch" || ctx.payload.action === "merge") &&
          (!argument || argument.length > 255 || argument.startsWith("-") || /[\0\r\n]/.test(argument))
        ) {
          return { output: "A valid branch name is required" }
        }
        const result = yield* runGit(location.directory, args)
        return { output: output(result) }
      })

    const history = (ctx: { query: { limit?: number } }) =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        const limit = Math.max(1, Math.min(200, ctx.query.limit ?? 50))
        const result = yield* runGit(location.directory, [
          "log",
          `--max-count=${limit}`,
          "--pretty=format:%H%x1f%h%x1f%an%x1f%at%x1f%s",
        ])
        return result.stdout.split(/\r?\n/).flatMap((line) => {
          const [hash, shortHash, author, timestamp, subject] = line.split("\u001f")
          if (!hash || !shortHash || !author || !timestamp || subject === undefined) return []
          return [{ hash, shortHash, author, timestamp: Number(timestamp) * 1000, subject }]
        })
      })

    const worktreeDetails = () =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        const list = yield* runGit(location.directory, ["worktree", "list", "--porcelain"])
        const blocks = list.stdout.split(/\r?\n\r?\n/).filter(Boolean)
        const managedRoot = path.join(global.data, "worktree", location.project.id)
        return yield* Effect.forEach(
          blocks,
          (block) =>
            Effect.gen(function* () {
              const lines = block.split(/\r?\n/)
              const directory = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length) ?? ""
              const branchRef = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length)
              if (!directory) return undefined
              const status = yield* runGit(directory, ["status", "--porcelain"])
              const stat = yield* fs.stat(directory).pipe(Effect.catch(() => Effect.succeed(undefined)))
              const measured = yield* Effect.promise(async () => {
                const { readdir, stat } = await import("node:fs/promises")
                let size = 0
                let count = 0
                const walk = async (dir: string) => {
                  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
                  for (const entry of entries) {
                    if (entry.name === ".git" || entry.name === "node_modules") continue
                    const full = path.join(dir, entry.name)
                    if (entry.isDirectory()) await walk(full)
                    else {
                      const info = await stat(full).catch(() => undefined)
                      if (info) {
                        size += info.size
                        count += 1
                      }
                    }
                  }
                }
                await walk(directory)
                return { sizeBytes: size, fileCount: count }
              })
              return {
                name: path.basename(directory),
                branch: branchRef?.replace(/^refs\/heads\//, ""),
                directory,
                dirty: Boolean(status.stdout.trim()),
                managed: directory === managedRoot || directory.startsWith(`${managedRoot}${path.sep}`),
                sizeBytes: measured.sizeBytes,
                fileCount: measured.fileCount,
                measuredCompletely: true,
                createdAt: stat && Option.isSome(stat.birthtime) ? stat.birthtime.value.getTime() : 0,
                modifiedAt: stat && Option.isSome(stat.mtime) ? stat.mtime.value.getTime() : 0,
              }
            }),
          { concurrency: 4 },
        ).pipe(
          Effect.map((items) => items.filter((item): item is NonNullable<typeof item> => !!item)),
          Effect.orDie,
        )
      })

    const worktreeReset = (ctx: { payload: { directory: string } }) =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        const target = ctx.payload.directory
        if (!target || path.resolve(target) === path.resolve(location.project.directory)) {
          return HttpApiSchema.NoContent.make()
        }
        const head = yield* runGit(location.directory, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        const base =
          head.code === 0
            ? head.stdout.trim()
            : (yield* runGit(location.directory, ["rev-parse", "--verify", "main"])).code === 0
              ? "main"
              : "master"
        yield* runGit(target, ["reset", "--hard", base])
        yield* runGit(target, ["clean", "-fd"])
        return HttpApiSchema.NoContent.make()
      })

    const memoryContext = (location: {
      directory: string
      project: { id: string; directory: string; canonical: string }
    }) => ({
      globalConfig: global.config,
      directory: location.directory,
      worktree: location.project.directory,
    })

    const readMemory = async (
      location: { directory: string; project: { id: string; directory: string; canonical: string } },
      id: MemorySourceID,
    ) => {
      const source = memorySourceDefinition(memoryContext(location), id)
      if (!source) throw new Error("Memory source not found")
      const content = await readFile(source.path, "utf8").catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
        throw error
      })
      return { ...source, exists: content !== undefined, content: content ?? "" }
    }

    const writeMemory = async (
      location: { directory: string; project: { id: string; directory: string; canonical: string } },
      id: MemorySourceID,
      content: string,
    ) => {
      if (Buffer.byteLength(content) > 1_000_000) throw new Error("Memory content exceeds 1 MB")
      const source = memorySourceDefinition(memoryContext(location), id)
      if (!source) throw new Error("Memory source not found")
      await mkdir(path.dirname(source.path), { recursive: true })
      await writeFile(source.path, content)
      return readMemory(location, id)
    }

    const goalGet = (ctx: { params: { sessionID: string } }) =>
      Effect.gen(function* () {
        const goal = yield* Effect.promise(() => Goal.getGoal(ctx.params.sessionID))
        return { goal }
      }).pipe(Effect.orDie)

    const goalStatus = (ctx: { params: { sessionID: string }; payload: { status: "active" | "paused" } }) =>
      Effect.gen(function* () {
        const goal = yield* Effect.promise(() => Goal.setGoalStatus(ctx.params.sessionID, ctx.payload.status))
        return { goal }
      }).pipe(Effect.orDie)

    const goalClear = (ctx: { params: { sessionID: string } }) =>
      Effect.gen(function* () {
        return yield* Effect.promise(() => Goal.clearGoal(ctx.params.sessionID))
      }).pipe(Effect.orDie)

    const hooksGet = () =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        return yield* Effect.promise(() => HookManager.read(location.directory))
      }).pipe(Effect.orDie)

    const hooksUpdate = (ctx: { payload: { hooks: readonly HookManager.Definition[] } }) =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        return yield* Effect.promise(() => HookManager.write(location.directory, [...ctx.payload.hooks]))
      }).pipe(Effect.orDie)

    const hooksRun = (ctx: { payload: { event: HookManager.Event } }) =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        return yield* Effect.promise(() => HookManager.execute(location.directory, ctx.payload.event))
      }).pipe(Effect.orDie)

    const memoryGet = (ctx: { params: { sourceID: MemorySourceID } }) =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        return yield* Effect.promise(() => readMemory(location, ctx.params.sourceID))
      }).pipe(Effect.orDie)

    const memoryUpdate = (ctx: { params: { sourceID: MemorySourceID }; payload: { content: string } }) =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        return yield* Effect.promise(() => writeMemory(location, ctx.params.sourceID, ctx.payload.content))
      }).pipe(Effect.orDie)

    const memoryCapture = (ctx: { payload: { content: string } }) =>
      Effect.gen(function* () {
        const content = ctx.payload.content.trim()
        if (!content) return yield* Effect.die(new Error("Memory content is required"))
        const location = yield* Location.Service
        const current = yield* Effect.promise(() => readMemory(location, "workspace"))
        const heading = current.content.trim() ? "\n\n" : "# Workspace memory\n\n"
        return yield* Effect.promise(() =>
          writeMemory(
            location,
            "workspace",
            `${current.content.trimEnd()}${heading}## Saved ${new Date().toISOString()}\n\n${content}\n`,
          ),
        )
      }).pipe(Effect.orDie)

    const checkpointList = (ctx: { query: { sessionID?: string } }) =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        return yield* Checkpoint.list(location.project.id, location.project.directory, ctx.query.sessionID)
      }).pipe(Effect.orDie)

    const checkpointCreate = (ctx: { payload: { sessionID: string; label: string } }) =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        const snapshots = yield* Snapshot.Service
        return yield* Checkpoint.create({
          snapshots,
          projectID: location.project.id,
          worktree: location.project.directory,
          directory: location.directory,
          sessionID: ctx.payload.sessionID,
          label: ctx.payload.label,
        })
      }).pipe(Effect.orDie)

    const checkpointRestore = (ctx: { payload: { id: string } }) =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        const snapshots = yield* Snapshot.Service
        return yield* Checkpoint.restore({
          snapshots,
          projectID: location.project.id,
          worktree: location.project.directory,
          directory: location.directory,
          id: ctx.payload.id,
        })
      }).pipe(Effect.orDie)

    const checkpointDelete = (ctx: { params: { checkpointID: string } }) =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        return yield* Checkpoint.remove(location.project.id, location.project.directory, ctx.params.checkpointID)
      }).pipe(Effect.orDie)

    const checkpointDiff = (ctx: { params: { checkpointID: string } }) =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        const snapshots = yield* Snapshot.Service
        return yield* Checkpoint.diff({
          snapshots,
          projectID: location.project.id,
          worktree: location.project.directory,
          id: ctx.params.checkpointID,
        })
      }).pipe(Effect.orDie)

    const withGitHooks = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const location = yield* Location.Service
        yield* Effect.promise(() => HookManager.execute(location.directory, "git.before")).pipe(
          Effect.catch(() => Effect.void),
        )
        return yield* effect.pipe(
          Effect.ensuring(
            Effect.promise(() => HookManager.execute(location.directory, "git.after")).pipe(
              Effect.catch(() => Effect.void),
            ),
          ),
        )
      })

    return handlers
      .handle("opencodex.config.patch", configPatch)
      .handle("opencodex.provider.refresh", providerRefresh)
      .handle("opencodex.project.subrepos", projectSubrepos)
      .handle("opencodex.vcs.branch", (ctx) => withGitHooks(switchBranch(ctx)))
      .handle("opencodex.vcs.stage", (ctx) => withGitHooks(stage(ctx)))
      .handle("opencodex.vcs.unstage", (ctx) => withGitHooks(unstage(ctx)))
      .handle("opencodex.vcs.discard", (ctx) => withGitHooks(discard(ctx)))
      .handle("opencodex.vcs.commit", (ctx) => withGitHooks(commit(ctx)))
      .handle("opencodex.vcs.push", () => withGitHooks(push()))
      .handle("opencodex.vcs.operation", (ctx) => withGitHooks(operation(ctx)))
      .handle("opencodex.vcs.history", history)
      .handle("opencodex.worktree.details", worktreeDetails)
      .handle("opencodex.worktree.reset", (ctx) => withGitHooks(worktreeReset(ctx)))
      .handle("opencodex.goal.get", goalGet)
      .handle("opencodex.goal.status", goalStatus)
      .handle("opencodex.goal.clear", goalClear)
      .handle("opencodex.hooks.get", hooksGet)
      .handle("opencodex.hooks.update", hooksUpdate)
      .handle("opencodex.hooks.run", hooksRun)
      .handle("opencodex.memory.get", memoryGet)
      .handle("opencodex.memory.update", memoryUpdate)
      .handle("opencodex.memory.capture", memoryCapture)
      .handle("opencodex.checkpoint.list", checkpointList)
      .handle("opencodex.checkpoint.create", checkpointCreate)
      .handle("opencodex.checkpoint.restore", checkpointRestore)
      .handle("opencodex.checkpoint.delete", checkpointDelete)
      .handle("opencodex.checkpoint.diff", checkpointDiff)
  }),
)
