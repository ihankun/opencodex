import { appendFile, mkdir, readFile, realpath, rename, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime"

type Config = {
  sandbox: {
    enabled: boolean
    denyRead: string[]
    allowRead: string[]
    allowWrite: string[]
    denyWrite: string[]
    allowedDomains: string[]
    deniedDomains: string[]
    allowedIPs: string[]
    deniedIPs: string[]
    blockPrivateNetworks: boolean
    allowUnixSockets: string[]
    allowAllUnixSockets: boolean
    allowLocalBinding: boolean
  }
  audit: {
    enabled: boolean
    directory: string
  }
}

let config: Promise<Config> | undefined
type Initialization = { ok: true } | { ok: false; error: string }

type SandboxedCommand = {
  command: string
  argv?: string[]
  env?: NodeJS.ProcessEnv
  sandboxed: boolean
  unavailable: boolean
  configured: boolean
  error?: string
}

let initialized: Promise<Initialization> | undefined
let auditWrite = Promise.resolve()
const auditedMessages = new Set<string>()

export async function sandboxCommand(
  command: string,
  cwd: string,
  worktree: string,
  shell: string,
  relaxFilesystem: boolean,
  abortSignal?: AbortSignal,
): Promise<SandboxedCommand> {
  const current = await load()
  if (!current.sandbox.enabled) return { command, sandboxed: false, unavailable: false, configured: false }
  const ready = await initialize(current, cwd, worktree)
  if (!ready.ok) {
    return { command, sandboxed: false, unavailable: true, configured: true, error: ready.error }
  }

  const SandboxManager = await sandboxManager()
  const base = runtime(current, cwd, worktree)
  const execution = relaxFilesystem
    ? { ...base, filesystem: { ...base.filesystem, disabled: true } }
    : base
  const wrapped = process.platform === "win32"
    ? SandboxManager.wrapWithSandboxArgv(command, shell, execution, abortSignal, cwd).then((value) => ({
        command,
        argv: [...value.argv],
        env: value.env,
      }))
    : SandboxManager.wrapWithSandbox(command, shell, execution, abortSignal).then((value) => ({
        command: value,
      }))

  return wrapped
    .then((value) => ({ ...value, sandboxed: true, unavailable: false, configured: true }))
    .catch((error) => {
      console.error("[security:sandbox] failed to wrap command", error)
      return {
        command,
        sandboxed: false,
        unavailable: true,
        configured: true,
        error: errorMessage(error),
      }
    })
}

export async function sandboxRisks(command: string) {
  const current = await load()
  if (!current.sandbox.enabled) return []
  const expanded = (value: string) => path.resolve(value.replace(/^~(?=$|[/\\])/, os.homedir()))
  const deniedPaths = [...current.sandbox.denyRead, ...current.sandbox.denyWrite]
    .map(expanded)
    .filter((item) => command.includes(item) || command.includes(item.replace(os.homedir(), "~")))
  return deniedPaths.map((item) => `filesystem:${item}`)
}

export type SandboxFilesystemRequest = {
  path: string
  access: "read" | "write"
  tree?: boolean
}

export type SandboxFilesystemPolicy = Pick<
  Config["sandbox"],
  "enabled" | "denyRead" | "allowRead" | "allowWrite" | "denyWrite"
>

export async function sandboxFilesystemRisks(requests: SandboxFilesystemRequest[], cwd: string, worktree: string) {
  const current = await load()
  return evaluateSandboxFilesystemRisks(current.sandbox, requests, cwd, worktree)
}

export async function evaluateSandboxFilesystemRisks(
  policy: SandboxFilesystemPolicy,
  requests: SandboxFilesystemRequest[],
  cwd: string,
  worktree: string,
) {
  if (!policy.enabled) return []

  const allowRead = await Promise.all(policy.allowRead.map(canonical))
  const denyRead = await Promise.all(policy.denyRead.map(canonical))
  const allowWrite = await Promise.all(
    (policy.allowWrite.length ? policy.allowWrite : [...new Set([cwd, worktree, os.tmpdir()])]).map(
      canonical,
    ),
  )
  const denyWrite = await Promise.all(policy.denyWrite.map(canonical))
  const targets = await Promise.all(
    requests.map(async (request) => ({ ...request, path: await canonical(request.path) })),
  )

  return [
    ...new Set(
      targets.flatMap((request) => {
        if (request.access === "write") {
          const denied = denyWrite.filter((item) => contains(item, request.path))
          if (denied.length) return denied.map((item) => `filesystem:${item}`)
          if (!allowWrite.some((item) => contains(item, request.path))) return [`filesystem:${request.path}`]
          return []
        }

        const denied = denyRead.filter(
          (item) =>
            (contains(item, request.path) || (request.tree && contains(request.path, item))) &&
            !allowRead.some((allowed) => contains(allowed, request.path) || contains(allowed, item)),
        )
        return denied.map((item) => `filesystem:${item}`)
      }),
    ),
  ]
}

export function auditTool(input: {
  event: "tool_execute_before" | "tool_execute_after" | "tool_execute_error"
  sessionID: string
  callID: string
  tool: string
  data: unknown
}) {
  return writeAudit(input.sessionID, { ts: new Date().toISOString(), ...input })
}

export function auditMessage(input: {
  sessionID: string
  messageID: string
  role: "user" | "assistant"
  data: unknown
}) {
  if (auditedMessages.has(input.messageID)) return Promise.resolve()
  auditedMessages.add(input.messageID)
  return writeAudit(input.sessionID, {
    ts: new Date().toISOString(),
    event: "chat_message",
    sessionID: input.sessionID,
    messageID: input.messageID,
    role: input.role,
    data: input.data,
  })
}

function writeAudit(sessionID: string, event: unknown) {
  auditWrite = auditWrite.then(async () => {
    const current = await load()
    if (!current.audit.enabled) return
    await mkdir(current.audit.directory, { recursive: true })
    const file = path.join(current.audit.directory, `${safe(sessionID)}.jsonl`)
    const size = await stat(file).then((info) => info.size, () => 0)
    if (size >= 10 * 1024 * 1024) {
      await rm(`${file}.1`, { force: true })
      await rename(file, `${file}.1`).catch(() => undefined)
    }
    const line = JSON.stringify(redactAuditData(event)) ?? "null"
    await appendFile(
      file,
      `${line.slice(0, 1_000_000)}\n`,
      { mode: 0o600 },
    )
  }).catch((error) => console.error("[security:audit] failed to write audit event", error))
  return auditWrite
}

export function redactAuditData(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[TRUNCATED]"
  if (typeof value === "string") {
    return value
      .replace(/\b((?:bearer|basic)\s+)[^\s"']+/gi, "$1[REDACTED]")
      .replace(/(authorization["'\s:=]+(?:bearer|basic)\s+)[^\s"']+/gi, "$1[REDACTED]")
      .replace(/((?:api[_-]?key|token|secret|password|private[_-]?token)["'\s:=]+)[^\s,"'}]+/gi, "$1[REDACTED]")
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED]")
      .replace(/(https?:\/\/[^\s/:@]+:)[^\s@]+@/gi, "$1[REDACTED]@")
  }
  if (Array.isArray(value)) return value.slice(0, 10_000).map((item) => redactAuditData(item, depth + 1))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key/i.test(key)
      ? "[REDACTED]"
      : redactAuditData(item, depth + 1),
  ]))
}

async function load() {
  config ??= readFile(process.env.OPENCODE_SECURITY_CONFIG ?? "", "utf8")
    .then((value) => JSON.parse(value) as Config)
    .catch(() => ({
      sandbox: {
        enabled: false,
        denyRead: [],
        allowRead: [],
        allowWrite: [],
        denyWrite: [],
        allowedDomains: [],
        deniedDomains: [],
        allowedIPs: [],
        deniedIPs: [],
        blockPrivateNetworks: true,
        allowUnixSockets: [],
        allowAllUnixSockets: false,
        allowLocalBinding: false,
      },
      audit: { enabled: false, directory: "" },
    }))
  return config
}

function runtime(current: Config, cwd: string, worktree: string): SandboxRuntimeConfig {
  const root = process.env.OPENCODE_SANDBOX_RUNTIME_ROOT
  const arch = process.arch === "x64" || process.arch === "arm64" ? process.arch : undefined
  return {
    filesystem: {
      denyRead: current.sandbox.denyRead,
      allowRead: current.sandbox.allowRead,
      allowWrite: current.sandbox.allowWrite.length ? current.sandbox.allowWrite : [...new Set([cwd, worktree, os.tmpdir()])],
      denyWrite: current.sandbox.denyWrite,
    },
    network: {
      allowedDomains: current.sandbox.allowedDomains,
      deniedDomains: current.sandbox.deniedDomains,
      allowedIPs: current.sandbox.allowedIPs,
      deniedIPs: current.sandbox.deniedIPs,
      blockPrivateNetworks: current.sandbox.blockPrivateNetworks,
      strictAllowlist: true,
      allowUnixSockets: current.sandbox.allowUnixSockets,
      allowAllUnixSockets: current.sandbox.allowAllUnixSockets,
      allowLocalBinding: current.sandbox.allowLocalBinding,
    },
    seccomp: root && arch ? { applyPath: path.join(root, "vendor", "seccomp", arch, "apply-seccomp") } : undefined,
    windows: root && arch ? { srtWin: { path: path.join(root, "vendor", "srt-win", arch, "srt-win.exe") } } : undefined,
  }
}

async function sandboxManager() {
  return (await import("@anthropic-ai/sandbox-runtime")).SandboxManager
}

function initialize(current: Config, cwd: string, worktree: string) {
  initialized ??= sandboxManager()
    .then((SandboxManager) => SandboxManager.initialize(runtime(current, cwd, worktree)))
    .then(() => ({ ok: true as const }))
    .catch((error) => {
      console.error("[security:sandbox] initialization failed", error)
      return { ok: false as const, error: errorMessage(error) }
    })
  return initialized
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function canonical(value: string) {
  const full = path.resolve(value.replace(/^~(?=$|[/\\])/, os.homedir()))
  const suffix: string[] = []
  let current = full
  while (true) {
    const resolved = await realpath(current).catch(() => undefined)
    if (resolved) return path.join(resolved, ...suffix.reverse())
    const parent = path.dirname(current)
    if (parent === current) return full
    suffix.push(path.basename(current))
    current = parent
  }
}

function contains(parent: string, target: string) {
  const relative = path.relative(normalize(parent), normalize(target))
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function normalize(value: string) {
  return process.platform === "win32" ? value.toLowerCase() : value
}

function safe(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_")
}
