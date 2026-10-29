import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { once } from "node:events"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { getCACertificates, setDefaultCACertificates } from "node:tls"

type StartCommand = {
  type: "start"
  hostname: string
  port: number
  password?: string
  userDataPath: string
  cors: string[]
}

type StopCommand = { type: "stop" }
type SidecarCommand = StartCommand | StopCommand

type ParentPort = {
  postMessage(message: SidecarMessage): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}

type SidecarMessage =
  | { type: "ready"; url: string }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }

type Listener = {
  url: URL
  stop(close?: boolean): Promise<void> | void
}

const parentPort = requireParentPort()
let listener: Listener | undefined

parentPort.on("message", (event) => {
  const command = parseCommand(event.data)
  if (!command) return
  if (command.type === "stop") {
    void stop()
    return
  }
  void start(command)
})

async function start(command: StartCommand) {
  try {
    prepareEnv(command)
    useSystemCertificates()
    const binary = process.env.OPENCODE_SERVER_BINARY
    if (!binary) throw new Error("OPENCODE_SERVER_BINARY is not configured")
    const child = spawn(binary, ["serve", "--stdio"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    const url = await waitForUrl(child)
    listener = { url: new URL(url), stop: () => stopChild(child) }
    parentPort.postMessage({ type: "ready", url: listener.url.toString() })
  } catch (error) {
    parentPort.postMessage({ type: "error", error: serializeError(error) })
    setImmediate(() => process.exit(1))
  }
}

function waitForUrl(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, url?: string) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve(url ?? "")
    }
    const lines = createInterface({ input: child.stdout })
    lines.on("line", (line) => {
      const trimmed = line.trim()
      if (!trimmed.startsWith("{")) return
      try {
        const parsed = JSON.parse(trimmed) as { url?: unknown }
        if (typeof parsed.url === "string") finish(undefined, parsed.url)
      } catch {
        // Server logs can be JSON-looking; ignore until the ready line.
      }
    })
    let stderr = ""
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-8000)
    })
    child.on("error", (error) => finish(error))
    child.on("exit", (code) => finish(new Error(`Server exited before it was ready (${code ?? "unknown"}): ${stderr}`)))
  })
}

async function stopChild(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return
  child.stdin.end()
  const exited = once(child, "exit").then(() => undefined)
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000))
  await Promise.race([exited, timeout])
  if (child.exitCode === null) child.kill()
}

async function stop() {
  try {
    await listener?.stop(true)
  } finally {
    listener = undefined
    parentPort.postMessage({ type: "stopped" })
    setImmediate(() => process.exit(0))
  }
}

function prepareEnv(command: StartCommand) {
  Object.assign(process.env, {
    OPENCODE_CLIENT: "opencodex",
    OPENCODE_DISABLE_EMBEDDED_WEB_UI: "true",
    OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
    XDG_CACHE_HOME: join(command.userDataPath, "cache"),
    XDG_CONFIG_HOME: join(command.userDataPath, "config"),
    XDG_DATA_HOME: join(command.userDataPath, "data"),
    XDG_STATE_HOME: join(command.userDataPath, "state"),
    OPENCODE_SECURITY_CONFIG: join(command.userDataPath, "security.json"),
  })

  if (command.password) {
    process.env.OPENCODE_SERVER_USERNAME = "opencode"
    process.env.OPENCODE_SERVER_PASSWORD = command.password
    return
  }

  delete process.env.OPENCODE_SERVER_USERNAME
  delete process.env.OPENCODE_SERVER_PASSWORD
}

function useSystemCertificates() {
  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    console.warn("failed to load system certificates", error)
  }
}

function parseCommand(value: unknown): SidecarCommand | undefined {
  if (!value || typeof value !== "object") return
  const command = value as Partial<StartCommand | StopCommand>
  if (command.type === "stop") return { type: "stop" }
  if (command.type !== "start") return
  if (typeof command.hostname !== "string") return
  if (typeof command.port !== "number") return
  if (command.password !== undefined && typeof command.password !== "string") return
  if (typeof command.userDataPath !== "string") return
  if (!Array.isArray(command.cors) || !command.cors.every((item) => typeof item === "string")) return
  return {
    type: "start",
    hostname: command.hostname,
    port: command.port,
    password: command.password,
    userDataPath: command.userDataPath,
    cors: command.cors,
  }
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function requireParentPort() {
  const port = process.parentPort as ParentPort | undefined
  if (!port) throw new Error("Sidecar parent port unavailable")
  return port
}
