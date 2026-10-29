import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { app, utilityProcess } from "electron"
import type { Details } from "electron"
import { writeLog } from "./logging"

type SidecarMessage =
  | { type: "ready"; url: string }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }

export type ServerState = {
  url: string
  username: string
  password: string
}

export type SidecarHandle = {
  state: ServerState
  stop(): Promise<void>
}

const SIDECAR_SERVICE_NAME = "opencodex server"
const SIDECAR_READY_TIMEOUT = 60_000
const SIDECAR_STOP_TIMEOUT = 6_000
const MODELS_CACHE_URL = "https://models.dev/api.json"
const MODELS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24小时

async function updateModelsCache(runtimeCachePath: string): Promise<void> {
  try {
    if (existsSync(runtimeCachePath)) {
      const stat = statSync(runtimeCachePath)
      const age = Date.now() - stat.mtimeMs
      if (age < MODELS_CACHE_MAX_AGE_MS) {
        writeLog("server", "models cache is fresh, skipping update", { age: Math.round(age / 1000) })
        return
      }
    }

    writeLog("server", "updating models cache from remote")
    const response = await fetch(MODELS_CACHE_URL)
    if (!response.ok) {
      writeLog("server", "failed to fetch models cache", { status: response.status })
      return
    }

    const data = await response.text()
    mkdirSync(dirname(runtimeCachePath), { recursive: true })
    writeFileSync(runtimeCachePath, data)
    writeLog("server", "models cache updated successfully")
  } catch (error) {
    writeLog("server", "error updating models cache", { error: error instanceof Error ? error.message : String(error) })
  }
}

export async function spawnServer(userDataPath: string, cors: string[], secureEnvironment: Record<string, string> = {}): Promise<SidecarHandle> {
  // Port 0 keeps 4096 as the preferred address, then lets the server fall back
  // to an OS-assigned free port when another OpenCodex instance is running.
  const port = 0
  // V2's `serve` generates a random password when none is provided, so pin one
  // here and hand it to both the sidecar and the renderer.
  const password = randomBytes(32).toString("base64url")
  const workspacePath = join(userDataPath, "workspace")
  mkdirSync(workspacePath, { recursive: true })
  
  // 更新模型缓存（如果需要）
  const runtimeCachePath = join(userDataPath, "models-cache", "api.json")
  await updateModelsCache(runtimeCachePath)
  
  writeLog("server", "spawning opencode sidecar", { cors, port, workspacePath })
  const child = utilityProcess.fork(join(dirname(fileURLToPath(import.meta.url)), "sidecar.js"), [], {
    cwd: workspacePath,
    env: createEnv(secureEnvironment, userDataPath),
    serviceName: SIDECAR_SERVICE_NAME,
    stdio: "pipe",
  })
  let exited = false
  const exit = defer<number>()

  const onProcessGone = (_event: unknown, details: Details) => {
    if (details.type !== "Utility" || details.name !== SIDECAR_SERVICE_NAME) return
    writeLog("server", "opencode sidecar gone", { reason: details.reason, exitCode: details.exitCode })
  }

  app.on("child-process-gone", onProcessGone)
  child.once("exit", (code) => {
    exited = true
    app.off("child-process-gone", onProcessGone)
    writeLog("server", "opencode sidecar exited", { code })
    exit.resolve(code)
  })
  child.stdout?.on("data", (chunk: Buffer) => writeLog("server:stdout", chunk.toString("utf8").trimEnd()))
  child.stderr?.on("data", (chunk: Buffer) => writeLog("server:stderr", chunk.toString("utf8").trimEnd()))

  const url = await new Promise<string>((resolve, reject) => {
    let done = false
    const timeout = setTimeout(() => fail(new Error("opencode server did not become ready")), SIDECAR_READY_TIMEOUT)

    const fail = (error: Error) => {
      if (done) return
      done = true
      cleanup()
      reject(error)
    }
    const succeed = (value: string) => {
      if (done) return
      done = true
      cleanup()
      resolve(value)
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.off("message", onMessage)
      child.off("exit", onExit)
    }
    const onMessage = (message: SidecarMessage) => {
      if (message.type === "ready") {
        writeLog("server", "opencode sidecar ready", { url: message.url })
        succeed(message.url)
        return
      }
      if (message.type === "error") fail(Object.assign(new Error(message.error.message), { stack: message.error.stack }))
    }
    const onExit = (code: number) => fail(new Error(`opencode sidecar exited before ready with code ${code}`))

    child.on("message", onMessage)
    child.on("exit", onExit)
    child.postMessage({
      type: "start",
      hostname: "127.0.0.1",
      port,
      password,
      userDataPath,
      cors,
    })
  }).catch((error) => {
    if (!exited) child.kill()
    throw error
  })

  let stopping: Promise<void> | undefined
  return {
    state: {
      url,
      username: "opencode",
      password,
    },
    stop() {
      if (stopping) return stopping
      if (exited) return Promise.resolve()
      child.postMessage({ type: "stop" })
      stopping = Promise.race([
        exit.promise.then(() => undefined),
        delay(SIDECAR_STOP_TIMEOUT).then(() => {
          if (!exited) child.kill()
        }),
      ])
      return stopping
    },
  }
}

function createEnv(secureEnvironment: Record<string, string>, userDataPath: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])),
  )
  delete env.DEBUG
  if (process.platform === "linux") delete env.LD_PRELOAD
  env.OPENCODE_SERVER_BINARY = serverBinaryPath()
  env.OPENCODE_SANDBOX_RUNTIME_ROOT = sandboxRuntimeRoot()

  const bundledModelsPath = app.isPackaged
    ? join(process.resourcesPath, "models", "api.json")
    : join(app.getAppPath(), ".models-cache", "api.json")
  const runtimeModelsPath = join(userDataPath, "models-cache", "api.json")
  env.OPENCODE_MODELS_PATH = existsSync(runtimeModelsPath) ? runtimeModelsPath : bundledModelsPath

  Object.assign(env, secureEnvironment)
  return env
}

export function sandboxRuntimeRoot() {
  if (app.isPackaged) return join(process.resourcesPath, "sandbox-runtime")
  return join(dirname(fileURLToPath(import.meta.url)), "../../../sandbox-runtime")
}

function serverBinaryPath() {
  const binary = process.platform === "win32" ? "opencode-server.exe" : "opencode-server"
  if (app.isPackaged) return join(process.resourcesPath, "server", binary)
  return join(app.getAppPath(), ".server", binary)
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
