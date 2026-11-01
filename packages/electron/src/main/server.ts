import { existsSync, readFileSync } from "node:fs"
import { mkdir, rename, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { app } from "electron"
import { Service } from "@opencode/client/service"
import { writeLog } from "./logging"

export type ServerState = {
  url: string
  username: string
  password: string
}

export type ServerHandle = {
  state: ServerState
  stop(): Promise<void>
  onExit(listener: (reason: string) => void): void
}

const HEALTH_POLL_INTERVAL = 5_000
const HEALTH_POLL_TIMEOUT = 4_000
const HEALTH_FAILURE_LIMIT = 3
const MODELS_CACHE_URL = "https://models.dev/api.json"
const MODELS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000
const MODELS_CACHE_TIMEOUT = 10_000

// The CLI only registers a managed service under a channel-specific name, and the channel is
// baked into the binary by scripts/build-server.ts. `local` is the channel source-dev builds use
// (the official desktop's `bun dev` does the same); inference gates the free models on this
// identity, and the official release channels are the only ones it accepts.
const SERVICE_CHANNEL = "local"
const SERVICE_FILE = `service-${SERVICE_CHANNEL}.json`

/**
 * Start or adopt the bundled OpenCode background service.
 *
 * The service registration is the single source of truth: `Service.ensure` reuses a compatible
 * running service, replaces an outdated one, and starts a new one with the CLI's own contender
 * handling and readiness polling. Its password lives in the service config, so a restarted
 * renderer or a crashed app reconnects with the same credential.
 */
export async function spawnServer(
  userDataPath: string,
  secureEnvironment: Record<string, string> = {},
): Promise<ServerHandle> {
  const file = join(userDataPath, "state", "opencode", SERVICE_FILE)
  const binary = serverBinaryPath()
  const version = serverVersion()

  writeLog("server", "starting opencode service", { file, binary, version })
  // A stale catalog only means newer models are missing until the next launch; waiting for
  // models.dev here would delay the server by as long as the network takes.
  void refreshModelsCache(join(userDataPath, "models-cache", "api.json")).catch((error) => {
    writeLog("server", "failed to refresh models cache", error)
  })

  const endpoint = await Service.ensure({
    file,
    version,
    command: [binary, "serve", "--service"],
    env: createEnv(secureEnvironment, userDataPath),
    onStart: (reason, previousVersion) => {
      writeLog("server", "starting opencode service process", { reason, previousVersion })
    },
  })

  if (endpoint.auth?.type !== "basic") throw new Error("opencode service did not provide authentication")

  const state: ServerState = {
    url: endpoint.url,
    username: endpoint.auth.username,
    password: endpoint.auth.password,
  }
  writeLog("server", "opencode service ready", { url: state.url })

  return monitor(state, file)
}

function monitor(state: ServerState, file: string) {
  const exitListeners = new Set<(reason: string) => void>()
  let stopping = false
  let reportedReason: string | undefined
  let failures = 0

  const report = (reason: string) => {
    if (stopping || reportedReason) return
    reportedReason = reason
    clearInterval(timer)
    writeLog("server", "opencode service lost", { reason })
    exitListeners.forEach((listener) => listener(reason))
  }

  // The service runs detached, so its owner learns about a crash from the same health endpoint
  // the renderer uses rather than from a child-process event.
  const timer = setInterval(async () => {
    if (stopping) return
    const healthy = await fetch(new URL("/api/info", state.url), {
      headers: { Authorization: `Basic ${Buffer.from(`${state.username}:${state.password}`).toString("base64")}` },
      signal: AbortSignal.timeout(HEALTH_POLL_TIMEOUT),
    })
      .then((response) => response.ok)
      .catch(() => false)
    if (stopping) return
    if (healthy) {
      failures = 0
      return
    }
    failures += 1
    if (failures >= HEALTH_FAILURE_LIMIT) report("opencode service stopped responding")
  }, HEALTH_POLL_INTERVAL)

  let stoppingPromise: Promise<void> | undefined
  return {
    state,
    onExit(listener) {
      if (reportedReason) {
        listener(reportedReason)
        return
      }
      exitListeners.add(listener)
    },
    stop() {
      stoppingPromise ??= (async () => {
        stopping = true
        clearInterval(timer)
        await Service.stop({ file }).catch((error) => {
          writeLog("server", "failed to stop opencode service", error)
        })
      })()
      return stoppingPromise
    },
  } satisfies ServerHandle
}

function createEnv(secureEnvironment: Record<string, string>, userDataPath: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])),
  )
  delete env.DEBUG
  if (process.platform === "linux") delete env.LD_PRELOAD
  // The service owns its port and credential through the registration file; inherited values
  // would point it at another app's data or a credential the renderer does not know about.
  delete env.OPENCODE_SERVER_BINARY
  delete env.OPENCODE_SERVER_USERNAME
  delete env.OPENCODE_SERVER_PASSWORD

  Object.assign(env, {
    // Inference identifies the calling client through `x-opencode-client` and the user agent.
    // The official desktop and this repository's WSL sidecar both identify as "desktop"; the
    // kernel version comes from the binary, so the full identity matches a desktop build.
    OPENCODE_CLIENT: "desktop",
    // Keep the fork's existing database name; the channel change would otherwise open a fresh
    // opencode-local.db and hide every session recorded before it.
    OPENCODE_DB: "opencode-opencodex.db",
    OPENCODE_DISABLE_EMBEDDED_WEB_UI: "true",
    OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
    XDG_CACHE_HOME: join(userDataPath, "cache"),
    XDG_CONFIG_HOME: join(userDataPath, "config"),
    XDG_DATA_HOME: join(userDataPath, "data"),
    XDG_STATE_HOME: join(userDataPath, "state"),
    OPENCODE_SECURITY_CONFIG: join(userDataPath, "security.json"),
    OPENCODE_SANDBOX_RUNTIME_ROOT: sandboxRuntimeRoot(),
  })

  // The bundled snapshot keeps the model list available offline; the runtime copy is refreshed
  // in the background. The server refreshes its catalog on its own schedule too, so startup
  // never waits for models.dev.
  const bundledPath = app.isPackaged
    ? join(process.resourcesPath, "models", "api.json")
    : join(app.getAppPath(), ".models-cache", "api.json")
  const runtimePath = join(userDataPath, "models-cache", "api.json")
  const modelsPath = existsSync(runtimePath) ? runtimePath : bundledPath
  if (existsSync(modelsPath)) env.OPENCODE_MODELS_PATH = modelsPath

  Object.assign(env, secureEnvironment)
  return env
}

async function refreshModelsCache(file: string) {
  const current = await stat(file).catch(() => undefined)
  if (current && Date.now() - current.mtimeMs < MODELS_CACHE_MAX_AGE_MS) return

  const response = await fetch(MODELS_CACHE_URL, { signal: AbortSignal.timeout(MODELS_CACHE_TIMEOUT) })
  if (!response.ok) {
    writeLog("server", "failed to refresh models cache", { status: response.status })
    return
  }

  const temporary = `${file}.tmp`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(temporary, await response.text())
  await rename(temporary, file)
  writeLog("server", "models cache refreshed")
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

// Written next to the binary by scripts/build-server.ts. Without it `ensure` adopts any registered
// service, including one left behind by an older build after a crash.
function serverVersion() {
  const file = app.isPackaged
    ? join(process.resourcesPath, "server", "version")
    : join(app.getAppPath(), ".server", "version")
  try {
    return readFileSync(file, "utf8").trim() || undefined
  } catch {
    return undefined
  }
}
