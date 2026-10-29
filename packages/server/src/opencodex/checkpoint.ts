import { Snapshot } from "@opencode/core/snapshot"
import { Global } from "@opencode/util/global"
import { Hash } from "@opencode/util/hash"
import { Effect } from "effect"
import path from "node:path"
import { DurableJson } from "./durable-json"

export type CheckpointEntry = {
  id: string
  snapshot: string
  sessionID: string
  directory: string
  label: string
  createdAt: number
}

function registryFile(projectID: string, worktree: string) {
  return path.join(Global.Path.data, "checkpoint-registry", `${projectID}-${Hash.fast(worktree)}.json`)
}

async function readRegistry(file: string): Promise<CheckpointEntry[]> {
  return normalize(await DurableJson.read<unknown>(file, []))
}

function normalize(value: unknown): CheckpointEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): CheckpointEntry[] => {
    if (!item || typeof item !== "object") return []
    if (!("id" in item) || typeof item.id !== "string") return []
    if (!("snapshot" in item) || typeof item.snapshot !== "string") return []
    if (!("sessionID" in item) || typeof item.sessionID !== "string") return []
    if (!("directory" in item) || typeof item.directory !== "string") return []
    if (!("label" in item) || typeof item.label !== "string") return []
    if (!("createdAt" in item) || typeof item.createdAt !== "number") return []
    return [item as CheckpointEntry]
  })
}

async function updateRegistry<R>(
  file: string,
  change: (entries: CheckpointEntry[]) => { entries: CheckpointEntry[]; result: R },
) {
  return DurableJson.update<unknown, R>(file, [], (value) => {
    const next = change(normalize(value))
    return { value: next.entries, result: next.result }
  })
}

export function list(projectID: string, worktree: string, sessionID?: string) {
  return Effect.promise(async () => {
    const entries = await readRegistry(registryFile(projectID, worktree))
    return sessionID ? entries.filter((entry) => entry.sessionID === sessionID) : entries
  })
}

export function create(input: {
  snapshots: Snapshot.Interface
  projectID: string
  worktree: string
  directory: string
  sessionID: string
  label: string
}) {
  return Effect.gen(function* () {
    const snapshot = yield* input.snapshots.capture()
    if (!snapshot) return yield* Effect.fail(new Error("Snapshots are not available"))
    const file = registryFile(input.projectID, input.worktree)
    const entry: CheckpointEntry = {
      id: crypto.randomUUID(),
      snapshot,
      sessionID: input.sessionID,
      directory: input.directory,
      label: input.label.trim() || new Date().toISOString(),
      createdAt: Date.now(),
    }
    yield* Effect.promise(() =>
      updateRegistry(file, (entries) => ({
        entries: [entry, ...entries].filter(
          (item, index, all) =>
            index < 100 && all.slice(0, index).filter((previous) => previous.sessionID === item.sessionID).length < 20,
        ),
        result: undefined,
      })),
    )
    return entry
  })
}

export function restore(input: { snapshots: Snapshot.Interface; projectID: string; worktree: string; directory: string; id: string }) {
  return Effect.gen(function* () {
    const file = registryFile(input.projectID, input.worktree)
    const snapshot = yield* input.snapshots.capture()
    if (!snapshot) return yield* Effect.fail(new Error("Snapshots are not available"))
    const found = yield* Effect.promise(() =>
      updateRegistry(file, (entries) => {
        const target = entries.find((entry) => entry.id === input.id)
        if (!target) return { entries, result: undefined }
        const backup: CheckpointEntry = {
          id: crypto.randomUUID(),
          snapshot,
          sessionID: target.sessionID,
          directory: input.directory,
          label: `Before restore: ${target.label}`,
          createdAt: Date.now(),
        }
        return { entries: [backup, ...entries].slice(0, 100), result: { target, backup } }
      }),
    )
    if (!found) return yield* Effect.fail(new Error("Checkpoint not found"))
    const changed = yield* input.snapshots.files({ from: found.target.snapshot as never, to: snapshot })
    const files = new Map(changed.map((item) => [item, found.target.snapshot as never]))
    yield* input.snapshots.restore({ files })
    return { backupID: found.backup.id }
  })
}

export function remove(projectID: string, worktree: string, checkpointID: string) {
  return Effect.promise(() =>
    updateRegistry(registryFile(projectID, worktree), (entries) => ({
      entries: entries.filter((entry) => entry.id !== checkpointID),
      result: entries.some((entry) => entry.id === checkpointID),
    })),
  )
}

export function diff(input: { snapshots: Snapshot.Interface; projectID: string; worktree: string; id: string }) {
  return Effect.gen(function* () {
    const entries = yield* Effect.promise(() => readRegistry(registryFile(input.projectID, input.worktree)))
    const target = entries.find((entry) => entry.id === input.id)
    if (!target) return yield* Effect.fail(new Error("Checkpoint not found"))
    const current = yield* input.snapshots.capture()
    if (!current) return ""
    const diffs = yield* input.snapshots.diff({ from: target.snapshot as never, to: current })
    return diffs
      .map((item) => item.patch ?? "")
      .filter(Boolean)
      .join("\n")
  })
}
