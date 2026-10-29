import { Schema } from "effect"
import { DurableJson } from "./durable-json"
import { sandboxCommand } from "./security"
import path from "node:path"

export const Event = Schema.Literals([
  "automation.before",
  "automation.after",
  "git.before",
  "git.after",
  "notification",
])
export type Event = typeof Event.Type

export const Definition = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  event: Event,
  command: Schema.String,
  enabled: Schema.Boolean,
  approved: Schema.Boolean,
  sandbox: Schema.Boolean,
  timeoutSeconds: Schema.Number,
})
export type Definition = typeof Definition.Type

export const Run = Schema.Struct({
  id: Schema.String,
  hookID: Schema.String,
  hookName: Schema.String,
  event: Event,
  status: Schema.Literals(["completed", "failed", "timed_out", "blocked"]),
  sandboxed: Schema.Boolean,
  output: Schema.String,
  startedAt: Schema.Number,
  completedAt: Schema.Number,
})
export type Run = typeof Run.Type

export const State = Schema.Struct({ hooks: Schema.Array(Definition), runs: Schema.Array(Run) })
export const UpdatePayload = Schema.Struct({ hooks: Schema.Array(Definition) })
export const RunPayload = Schema.Struct({ event: Event })

function configFile(directory: string) {
  return path.join(directory, ".opencode", "hooks.json")
}

function runsFile(directory: string) {
  return path.join(directory, ".opencode", "hook-runs.json")
}

export async function read(directory: string) {
  const [hooks, runs] = await Promise.all([
    DurableJson.read<unknown>(configFile(directory), []),
    DurableJson.read<unknown>(runsFile(directory), []),
  ])
  return {
    hooks: Array.isArray(hooks) ? hooks.flatMap(normalizeDefinition) : [],
    runs: Array.isArray(runs) ? runs.flatMap(normalizeRun).slice(0, 200) : [],
  }
}

export async function write(directory: string, hooks: Definition[]) {
  const current = await read(directory)
  const normalized = hooks.map(requireDefinition).map((hook) => ({
    ...hook,
    approved: current.hooks.find((item) => item.id === hook.id)?.command === hook.command && hook.approved,
  }))
  await DurableJson.write(configFile(directory), normalized)
  return { ...(await read(directory)), hooks: normalized }
}

export async function execute(directory: string, event: Event) {
  const state = await read(directory)
  const runs: Run[] = []
  for (const hook of state.hooks.filter((item) => item.enabled && item.event === event)) {
    const startedAt = Date.now()
    if (!hook.approved) {
      runs.push({
        id: crypto.randomUUID(),
        hookID: hook.id,
        hookName: hook.name,
        event,
        status: "blocked",
        sandboxed: false,
        output: "Hook is enabled but has not been explicitly approved.",
        startedAt,
        completedAt: Date.now(),
      })
      continue
    }
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh"
    const sandbox = hook.sandbox
      ? await sandboxCommand(hook.command, directory, directory, shell, false)
      : { command: hook.command, sandboxed: false, unavailable: false, configured: false }
    if (hook.sandbox && !sandbox.sandboxed) {
      runs.push({
        id: crypto.randomUUID(),
        hookID: hook.id,
        hookName: hook.name,
        event,
        status: "blocked",
        sandboxed: false,
        output: sandbox.unavailable
          ? "The configured sandbox runtime is unavailable."
          : "This hook requires sandbox execution, but sandboxing is not enabled.",
        startedAt,
        completedAt: Date.now(),
      })
      continue
    }
    const result = await spawnCommand(sandbox.command, directory, hook.timeoutSeconds * 1000, event)
    runs.push({
      id: crypto.randomUUID(),
      hookID: hook.id,
      hookName: hook.name,
      event,
      status: result.timedOut ? "timed_out" : result.exitCode === 0 ? "completed" : "failed",
      sandboxed: sandbox.sandboxed,
      output: redact(result.output).slice(0, 200_000),
      startedAt,
      completedAt: Date.now(),
    })
  }
  await DurableJson.update<unknown, void>(runsFile(directory), [], (value) => ({
    value: [
      ...runs.toReversed(),
      ...(Array.isArray(value) ? value.flatMap(normalizeRun) : []),
    ]
      .filter((run) => run.completedAt > Date.now() - 30 * 24 * 60 * 60 * 1000)
      .slice(0, 200),
    result: undefined,
  }))
  return runs
}

async function spawnCommand(command: string, cwd: string, timeoutMs: number, event: Event) {
  const { spawn } = await import("node:child_process")
  return new Promise<{ exitCode: number; timedOut: boolean; output: string }>((resolve) => {
    const child = spawn(processCommand(command)[0], processCommand(command).slice(1), {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        OPENCODE_HOOK_EVENT: event,
        OPENCODE_WORKSPACE: cwd,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    let output = ""
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.stdout?.on("data", (chunk) => {
      output += String(chunk)
    })
    child.stderr?.on("data", (chunk) => {
      output += String(chunk)
    })
    child.on("error", (error) => {
      clearTimeout(timeout)
      resolve({ exitCode: 1, timedOut, output: `${output}${error.message}` })
    })
    child.on("close", (code) => {
      clearTimeout(timeout)
      resolve({ exitCode: code ?? 1, timedOut, output })
    })
  })
}

function processCommand(command: string) {
  if (process.platform === "win32") return ["cmd.exe", "/d", "/s", "/c", command]
  return ["/bin/sh", "-lc", command]
}

function requireDefinition(value: Definition) {
  const name = value.name.trim()
  const command = value.command.trim()
  if (!name || !command || command.length > 2_000 || command.includes("\0"))
    throw new Error("Hook name and command are required")
  const timeoutSeconds = Math.max(1, Math.min(120, Math.floor(value.timeoutSeconds)))
  return { ...value, id: value.id || crypto.randomUUID(), name, command, timeoutSeconds }
}

function normalizeDefinition(value: unknown): Definition[] {
  if (!value || typeof value !== "object") return []
  if (!("id" in value) || typeof value.id !== "string") return []
  if (!("name" in value) || typeof value.name !== "string") return []
  if (!("command" in value) || typeof value.command !== "string") return []
  if (!("enabled" in value) || typeof value.enabled !== "boolean") return []
  if (!("timeoutSeconds" in value) || typeof value.timeoutSeconds !== "number") return []
  if (
    !("event" in value) ||
    !["automation.before", "automation.after", "git.before", "git.after", "notification"].includes(String(value.event))
  )
    return []
  return [
    requireDefinition({
      ...(value as Omit<Definition, "approved" | "sandbox">),
      approved: "approved" in value && typeof value.approved === "boolean" ? value.approved : false,
      sandbox: "sandbox" in value && typeof value.sandbox === "boolean" ? value.sandbox : true,
    }),
  ]
}

function normalizeRun(value: unknown): Run[] {
  if (!value || typeof value !== "object") return []
  if (!("id" in value) || typeof value.id !== "string") return []
  if (!("hookID" in value) || typeof value.hookID !== "string") return []
  if (!("hookName" in value) || typeof value.hookName !== "string") return []
  if (
    !("event" in value) ||
    !["automation.before", "automation.after", "git.before", "git.after", "notification"].includes(String(value.event))
  )
    return []
  if (!("status" in value) || !["completed", "failed", "timed_out", "blocked"].includes(String(value.status))) return []
  if (!("output" in value) || typeof value.output !== "string") return []
  if (!("startedAt" in value) || typeof value.startedAt !== "number") return []
  if (!("completedAt" in value) || typeof value.completedAt !== "number") return []
  return [{ ...value, sandboxed: "sandboxed" in value && value.sandboxed === true } as Run]
}

function redact(value: string) {
  return value
    .replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password|private[_-]?token)\s*[:=]\s*)[^\s]+/gi, "$1[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED]")
}

export * as HookManager from "./hooks"
