import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  nativeImage,
  Notification,
  protocol,
  session,
  shell,
  systemPreferences,
} from "electron"
import { mkdirSync } from "node:fs"
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { isIP } from "node:net"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import { spawn } from "node:child_process"
import type { ChildProcess, SpawnOptions } from "node:child_process"
import extract from "extract-zip"
import windowState from "electron-window-state"
import { applyEdits, modify, parse as parseJsonc, printParseErrorCode } from "jsonc-parser"
import type { ParseError } from "jsonc-parser"
import { diagnosticLogTail, exportDebugLogs, initLogging, writeLog } from "./logging"
import { createUnresponsiveSampler } from "./unresponsive"
import { sandboxRuntimeRoot, spawnServer } from "./server"
import type { SidecarHandle } from "./server"
import { startRendererServer, type RendererServerHandle } from "./rendererServer"
import { TaskScheduler } from "./scheduler"
import type { ScheduledTask, ScheduledTaskRun } from "./scheduler"
import { getSecureCredential, getServerCredential, listServerCredentialIDs, setSecureCredential } from "./credentials"
import { shouldUseMockKeychain } from "./keychain"
import { ImBridgeService } from "./imBridge"
import { DesktopPreferencesStore } from "./desktopPreferences"
import { SpeechModelService } from "./speechModel"
import { ProjectsStore } from "./projects"
import { SessionListCacheStore } from "./sessionListCache"
import { deepLinkUrlsFromArgv, parseDeepLink } from "./deepLinks"
import { createDesktopDraftStore } from "./draft-store"
import { openExternalURL, openLocalFileURL } from "./external-url"
import { assertBrowserTarget, isLocalPreviewHost } from "./browserNetworkPolicy"
import { registerBrowserIpc } from "./ipc/browser"
import { registerBadgeIpc } from "./ipc/badge"
import { registerCredentialsIpc } from "./ipc/credentials"
import { registerDeepLinkIpc } from "./ipc/deepLinks"
import { registerDesktopIntegrationIpc } from "./ipc/desktopIntegration"
import { registerDialogIpc } from "./ipc/dialog"
import { registerDiagnosticsIpc } from "./ipc/diagnostics"
import { registerDraftsIpc } from "./ipc/drafts"
import { registerDrivesIpc } from "./ipc/drives"
import { registerAgentsIpc } from "./ipc/agents"
import { registerFilesIpc } from "./ipc/files"
import { registerImBridgeIpc } from "./ipc/imBridge"
import { registerMarketplaceIpc } from "./ipc/marketplace"
import { registerNotificationIpc } from "./ipc/notifications"
import { registerNotificationHistoryIpc } from "./ipc/notificationHistory"
import {
  createNotificationDatabase,
  type DesktopNotificationDatabase,
  type StoredNotification,
} from "./notificationDatabase"
import { registerDesktopPreferencesIpc } from "./ipc/preferences"
import { registerProjectsIpc } from "./ipc/projects"
import { registerProviderAuthIpc } from "./ipc/providerAuth"
import { registerQuotaIpc } from "./ipc/quota"
import { registerRendererSettingsIpc } from "./ipc/rendererSettings"
import { registerSecurityIpc } from "./ipc/security"
import { registerServerIpc } from "./ipc/server"
import { registerSkillsIpc } from "./ipc/skills"
import { registerSpeechModelIpc } from "./ipc/speechModel"
import { registerTaskIpc } from "./ipc/tasks"
import { registerUpdaterIpc } from "./ipc/updater"
import { registerWindowIpc } from "./ipc/window"
import { RendererSettingsStore } from "./rendererSettings"
import { createAutoUpdater } from "./updater"
import type { CustomOpenCodeDeepLink } from "../shared/deepLinks"
import { DEFAULT_DESKTOP_PREFERENCES, type DesktopPreferences } from "../shared/desktopPreferences"

let mainWindow: BrowserWindow | undefined
let internalBrowserWindow: BrowserWindow | undefined
const internalBrowserPartition = "persist:opencodex-browser"
let internalBrowserNetworkPolicyConfigured = false
let server: SidecarHandle | undefined
let rendererServer: RendererServerHandle | undefined
let initialServerStartup: Promise<void> | undefined
let serverError: string | undefined
let tray: Tray | undefined
let badgeCount = 0
let isQuitting = false
let isStoppingForQuit = false
let desktopPreferencesStore: DesktopPreferencesStore
let desktopPreferences: DesktopPreferences = { ...DEFAULT_DESKTOP_PREFERENCES }
let speechModelService: SpeechModelService
let projectsStore: ProjectsStore
let sessionListCacheStore: SessionListCacheStore
let speechModelReady: Promise<void> = Promise.resolve()
let resolveFirstWindowReady: (() => void) | undefined
const startupStartedAt = performance.now()
const firstWindowReady = new Promise<void>((resolve) => {
  resolveFirstWindowReady = resolve
})
const activeNotifications = new Set<Notification>()
const consoleLoginWaits = new Map<string, Promise<ConsoleLoginResult>>()
const pluginCompatibilityCache = new Map<string, "supported" | "unsupported">()
const appId = "com.hankun.opencodex"
const imBridgeService = new ImBridgeService(
  (state) => mainWindow?.webContents.send("im-bridge:state", state),
  getServerCredential,
  getSecureCredential,
  setSecureCredential,
)
const taskScheduler = new TaskScheduler(
  async (task) => {
    if (task.serverId === "local" && server) return server.state
    const credential = await getServerCredential(task.serverId)
    return {
      url: task.serverUrl,
      ...(credential ? credential : {}),
    }
  },
  notifyTasksChanged,
  notifyScheduledTaskFinished,
)
let taskSchedulerReady: Promise<void> | undefined
let deepLinkRendererReady = false
let deepLinkWork = Promise.resolve()
const pendingDeepLinks: CustomOpenCodeDeepLink[] = []
const pendingDeepLinkUrls = deepLinkUrlsFromArgv(process.argv)
const spawnProcess = spawn as unknown as (
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
) => ChildProcess

type SecurityConfig = {
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

type PluginInstallTarget = {
  kind: "server" | "tui"
  opts?: Record<string, unknown>
}

type NpmPackageManifest = {
  name?: string
  version?: string
  description?: string
  keywords?: string[]
  exports?: unknown
  main?: string
  "oc-themes"?: unknown
  dist?: { integrity?: string; signatures?: Array<{ keyid?: string; sig?: string }> }
  maintainers?: Array<{ name?: string }>
  dependencies?: Record<string, string>
  scripts?: Record<string, string>
  repository?: string | { url?: string }
}

type NpmSearchPackage = {
  name?: string
  version?: string
  description?: string
  keywords?: string[]
  date?: string
  publisher?: {
    username?: string
  }
  links?: { npm?: string; homepage?: string; repository?: string }
}

type NpmSearchResponse = {
  objects?: Array<{
    package?: NpmSearchPackage
  }>
}

type SkillFileInput = {
  path: string
  content: string
}

type NativeNotificationInput = {
  title?: string
  body?: string
  sessionId?: string
  directory?: string
}

type ConsoleLoginStart = {
  code?: string
  user?: string
  url?: string
  server?: string
  expiresInMs?: number
  intervalMs?: number
}

type ConsoleLoginResult = {
  status: "success" | "pending" | "slow" | "expired" | "denied" | "error"
  email?: string
  message?: string
}

function rendererUrl() {
  if (process.env.ELECTRON_RENDERER_URL) return process.env.ELECTRON_RENDERER_URL
  if (rendererServer?.url) return rendererServer.url
  return `file://${join(__dirname, "../renderer/index.html")}`
}

async function startRendererServerIfNeeded() {
  if (!app.isPackaged) return
  if (rendererServer) return
  rendererServer = await startRendererServer(join(__dirname, "../renderer"))
}

async function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showWindow()
    return
  }

  const url = rendererUrl()
  writeLog("startup", "creating window", { elapsedMs: Math.round(performance.now() - startupStartedAt), url })

  const isMac = process.platform === "darwin"
  const isWin = process.platform === "win32"
  const state = windowState({
    file: "window-state.json",
    defaultWidth: 1180,
    defaultHeight: 760,
  })

  const createdWindow = new BrowserWindow({
    title: "",
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 900,
    minHeight: 580,
    show: false,
    icon: iconPath(isMac ? "icon.icns" : "icon.ico"),
    backgroundColor: isMac ? "#00000000" : "#0f1115",
    transparent: isMac,
    vibrancy: isMac ? "sidebar" : undefined,
    visualEffectState: isMac ? "active" : undefined,
    titleBarStyle: isMac ? "hidden" : isWin ? "hidden" : "default",
    trafficLightPosition: isMac ? { x: 20, y: 18 } : undefined,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true,
    },
  })
  mainWindow = createdWindow
  state.manage(createdWindow)

  const sampler = createUnresponsiveSampler(createdWindow, "main")

  let recoveryDialogShowing = false

  const showRecoveryDialog = async (message: string, detail: string, wait: boolean) => {
    if (recoveryDialogShowing || createdWindow.isDestroyed()) return
    recoveryDialogShowing = true
    try {
      while (!createdWindow.isDestroyed()) {
        const buttons = wait ? ["Relaunch", "Export Logs", "Keep Waiting"] : ["Relaunch", "Export Logs", "Quit"]
        const result = await dialog.showMessageBox(createdWindow, {
          type: "warning",
          buttons,
          defaultId: 0,
          cancelId: 2,
          message,
          detail,
        })
        const button = buttons[result.response]
        if (button === "Export Logs") {
          const wasSampling = sampler.stopAndFlush()
          try {
            exportDebugLogs()
          } catch (error) {
            writeLog("main", "failed to export debug logs", { error, level: "error" })
          }
          if (wait && wasSampling) sampler.start()
          continue
        }
        if (button === "Relaunch") {
          sampler.stopAndFlush()
          isQuitting = true
          app.relaunch()
          app.exit(0)
          return
        }
        if (button === "Quit") {
          sampler.stopAndFlush()
          isQuitting = true
          app.quit()
          return
        }
        if (button === "Keep Waiting") return
        return
      }
    } finally {
      recoveryDialogShowing = false
    }
  }

  createdWindow.on("page-title-updated", (event) => {
    event.preventDefault()
    createdWindow.setTitle("")
  })
  createdWindow.on("maximize", () => {
    createdWindow.webContents.send("window:maximize-change", true)
  })
  createdWindow.on("unmaximize", () => {
    createdWindow.webContents.send("window:maximize-change", false)
  })
  createdWindow.on("close", (event) => {
    if (isQuitting) return
    event.preventDefault()
    createdWindow.hide()
    if (desktopPreferences.hideDockOnClose) app.dock?.hide()
  })
  createdWindow.once("ready-to-show", () => {
    writeLog("startup", "window ready-to-show", { elapsedMs: Math.round(performance.now() - startupStartedAt) })
    markFirstWindowReady()
    showWindow()
  })
  createdWindow.webContents.once("did-finish-load", () => {
    writeLog("startup", "renderer did-finish-load", { elapsedMs: Math.round(performance.now() - startupStartedAt) })
    // 并行启动后服务端可能已在 renderer 注册监听前就绪，补发一次当前状态避免丢失
    if (server) createdWindow.webContents.send("server:updated", currentServerState())
  })
  createdWindow.webContents.on("did-start-loading", () => {
    deepLinkRendererReady = false
  })
  createdWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    writeLog("main", "window did-fail-load", { errorCode, errorDescription, validatedURL })
    markFirstWindowReady()
    showWindow()
  })
  createdWindow.webContents.on("did-fail-provisional-load", (_event, errorCode, errorDescription, validatedURL) => {
    writeLog("main", "window did-fail-provisional-load", { errorCode, errorDescription, validatedURL })
  })
  createdWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level < 2) return
    writeLog("renderer", "console-message", { level, message, line, sourceId })
  })
  createdWindow.webContents.on("render-process-gone", (_event, details) => {
    sampler.stopAndFlush()
    writeLog("renderer", "render-process-gone", { ...details, level: "error" })
    void showRecoveryDialog(
      "OpenCodex window terminated unexpectedly",
      [`Reason: ${details.reason}`, `Code: ${details.exitCode ?? "<unknown>"}`].join("\n"),
      false,
    )
  })
  createdWindow.on("unresponsive", () => {
    writeLog("window", "renderer unresponsive", { level: "error" })
    sampler.start()
    void showRecoveryDialog(
      "OpenCodex is not responding",
      "You can relaunch the app, export the logs, or keep waiting.",
      true,
    )
  })
  createdWindow.on("responsive", () => {
    writeLog("window", "renderer responsive", { level: "error" })
    sampler.stopAndFlush()
  })
  createdWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    void openExternalURL(target).catch((error) => writeLog("security", "blocked window open", { target, error }))
    return { action: "deny" }
  })
  createdWindow.webContents.on("will-navigate", (event, target) => {
    if (target === url) return
    // 放行同源 SPA 路由：切服务器 reload 时 hash 已变更，target 带 hash 但 origin/pathname 与加载 url 一致
    try {
      const targetUrl = new URL(target)
      const loadedUrl = new URL(url)
      if (targetUrl.origin === loadedUrl.origin && targetUrl.pathname === loadedUrl.pathname) return
    } catch {
      if (target.startsWith(url)) return
    }
    event.preventDefault()
    writeLog("security", "blocked renderer navigation", { target })
  })
  setTimeout(() => {
    if (createdWindow.isDestroyed()) return
    markFirstWindowReady()
    if (createdWindow.isVisible()) return
    writeLog("main", "forcing window show after timeout")
    showWindow()
  }, 2_000)

  void createdWindow.loadURL(url).catch((error: unknown) => {
    writeLog("main", "window loadURL failed", error)
    markFirstWindowReady()
    showWindow()
  })
}

function markFirstWindowReady() {
  resolveFirstWindowReady?.()
  resolveFirstWindowReady = undefined
}

function ensureTaskSchedulerStarted() {
  if (taskSchedulerReady) return taskSchedulerReady
  taskSchedulerReady = firstWindowReady.then(() => {
    const startedAt = performance.now()
    taskScheduler.start()
    writeLog("startup", "task scheduler initialized", {
      durationMs: Math.round(performance.now() - startedAt),
      elapsedMs: Math.round(performance.now() - startupStartedAt),
    })
  })
  return taskSchedulerReady
}

function showWindow() {
  showDockIcon()
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow()
    return
  }

  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray() {
  if (tray) return

  const image =
    process.platform === "darwin"
      ? nativeImage.createFromPath(iconPath("generated/opencode-trayTemplate.png"))
      : nativeImage.createFromPath(iconPath("opencode-icon.png"))
  if (process.platform === "darwin") image.setTemplateImage(true)

  tray = new Tray(image)
  tray.setToolTip("OpenCodex")
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开 OpenCodex", click: showWindow },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          isQuitting = true
          app.quit()
        },
      },
    ]),
  )
  tray.on("click", showWindow)
}

function destroyTray() {
  tray?.destroy()
  tray = undefined
}

function iconPath(filename: string) {
  return join(__dirname, "../../assets", filename)
}

function showDockIcon() {
  if (process.platform !== "darwin") return

  try {
    void app.dock?.show()
    const image = nativeImage.createFromPath(iconPath("icon.icns"))
    if (image.isEmpty()) {
      writeLog("main", "dock icon skipped because image is empty", { path: iconPath("icon.icns") })
      return
    }
    app.dock?.setIcon(image)
  } catch (error) {
    writeLog("main", "dock icon failed", error)
  }
}

function applyDesktopPreferences() {
  if (desktopPreferences.showMenuBarIcon) createTray()
  if (!desktopPreferences.showMenuBarIcon) destroyTray()
  if (process.platform !== "darwin") return
  if (desktopPreferences.hideDockOnClose && mainWindow && !mainWindow.isVisible()) {
    app.dock?.hide()
    return
  }
  showDockIcon()
}

function updateBadge(count: number) {
  if (count === badgeCount) return
  badgeCount = count
  if (process.platform !== "darwin") return
  if (count > 0) app.dock?.setBadge(count > 99 ? "99+" : String(count))
  else app.dock?.setBadge("")
}

async function startServer(url: string) {
  const startedAt = performance.now()
  try {
    serverError = undefined
    const testServerUrl = e2eServerUrl()
    if (testServerUrl) {
      server = {
        state: {
          url: testServerUrl,
          username: "opencode",
          password: "",
        },
        stop: () => Promise.resolve(),
      }
      writeLog("startup", "using e2e opencode server", { url: testServerUrl })
      mainWindow?.webContents.send("server:updated", currentServerState())
      return
    }
    server = await spawnServer(app.getPath("userData"), allowedOrigins(url), {
      ...(await secureEnvironment()),
      OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: desktopPreferences.backgroundSubagents ? "true" : "false",
    })
    writeLog("startup", "opencode server online", {
      durationMs: Math.round(performance.now() - startedAt),
      elapsedMs: Math.round(performance.now() - startupStartedAt),
    })
    mainWindow?.webContents.send("server:updated", currentServerState())
    void syncImBridgeServer(server.state.url).catch((error) => writeLog("im-bridge", "automatic start failed", error))
  } catch (error) {
    serverError = error instanceof Error ? error.message : String(error)
    writeLog("main", "failed to start opencode server", error)
    mainWindow?.webContents.send("server:updated", currentServerState())
  }
}

async function syncImBridgeServer(localServerUrl: string) {
  const config = await imBridgeService.config()
  const state = imBridgeService.state()
  if (config.serverId === "local" && (state.status === "running" || state.status === "starting")) {
    await imBridgeService.restart(localServerUrl)
    return
  }
  await imBridgeService.autoStart(localServerUrl)
}

async function stopServer() {
  const current = server
  server = undefined
  await current?.stop()
}

async function restartServer() {
  await initialServerStartup
  writeLog("main", "restarting opencode server")
  serverError = undefined
  await stopServer()
  mainWindow?.webContents.send("server:updated", currentServerState())
  await startServer(rendererUrl())
  return currentServerState()
}

function allowedOrigins(url: string) {
  // "null"：生产 renderer 从 file:// 加载时浏览器 origin 为 null，CORS 必须放行
  const defaults = ["null", "opencodex://renderer", "http://localhost:46237", "http://127.0.0.1:46237"]
  try {
    const origin = new URL(url).origin
    if (origin === "null") return defaults
    return [...new Set([...defaults, origin])]
  } catch {
    return defaults
  }
}

async function secureEnvironment() {
  const ids = (await listServerCredentialIDs()).filter((id) => id.startsWith("environment."))
  const credentials = await Promise.all(ids.map((id) => getSecureCredential(id)))
  return Object.assign({}, ...credentials.filter((item): item is Record<string, string> => Boolean(item)))
}

const usesMockKeychain = shouldUseMockKeychain({ override: process.env.OPENCODE_USE_MOCK_KEYCHAIN })
if (usesMockKeychain) {
  app.commandLine.appendSwitch("use-mock-keychain")
}
app.commandLine.appendSwitch("enable-javascript-call-stack")
app.setName("OpenCodex")
app.setAppUserModelId(appId)
app.setPath("userData", userDataRoot())
mkdirSync(app.getPath("userData"), { recursive: true })
desktopPreferencesStore = new DesktopPreferencesStore(join(app.getPath("userData"), "desktop-preferences.json"))
speechModelService = new SpeechModelService(join(app.getPath("userData"), "speech-model.json"))
projectsStore = new ProjectsStore(join(app.getPath("userData"), "projects.json"))
sessionListCacheStore = new SessionListCacheStore(join(app.getPath("userData"), "session-list-cache.json"))
const rendererSettingsStore = new RendererSettingsStore(join(app.getPath("userData"), "renderer-settings.json"))
const draftsStore = createDesktopDraftStore(join(app.getPath("userData"), "drafts.sqlite"))
initLogging()
writeLog("main", "app boot", { userData: app.getPath("userData"), keychain: usesMockKeychain ? "mock" : "system" })
registerWindowIpc({ assertSender: assertMainWindow, getWindow: () => mainWindow })
registerBadgeIpc({ assertSender: assertMainWindow, updateBadge })
registerCredentialsIpc({
  assertSender: assertMainWindow,
  createPullRequest: createHostedPullRequest,
})
registerDesktopPreferencesIpc({
  assertSender: assertMainWindow,
  current: () => desktopPreferencesStore.current(),
  save: async (value) => {
    const backgroundSubagents = desktopPreferences.backgroundSubagents
    desktopPreferences = await desktopPreferencesStore.save(value)
    applyDesktopPreferences()
    if (backgroundSubagents !== desktopPreferences.backgroundSubagents && server) void restartServer()
    return desktopPreferences
  },
})
registerDeepLinkIpc({
  assertSender: assertMainWindow,
  consumeInitial: () => {
    deepLinkRendererReady = true
    return pendingDeepLinks.splice(0)
  },
})
registerProjectsIpc({
  assertSender: assertMainWindow,
  projects: projectsStore,
  sessionListCache: sessionListCacheStore,
})
registerProviderAuthIpc({
  assertSender: assertMainWindow,
  userDataPath: app.getPath("userData"),
})
registerQuotaIpc({
  assertSender: assertMainWindow,
  userDataPath: app.getPath("userData"),
})
registerRendererSettingsIpc({
  assertSender: assertMainWindow,
  store: rendererSettingsStore,
})
registerImBridgeIpc({
  assertSender: assertMainWindow,
  getServerUrl: () => server?.state.url,
  service: imBridgeService,
})
registerServerIpc({
  assertSender: assertMainWindow,
  current: currentServerState,
  restart: restartServer,
})
registerSecurityIpc({
  assertSender: assertMainWindow,
  audit: readSecurityAudit,
  get: readSecurityConfig,
  installWindowsSandbox,
  set: updateSecurityConfig,
  windowsSandboxStatus,
})
registerMarketplaceIpc({
  assertSender: assertMainWindow,
  expertKitSkillSources,
  inspectPlugins,
  installExpertKit,
  installPlugin,
  mcpSources,
  removeExpertKit,
  searchExpertKits,
  searchMcpServers,
  searchPlugins,
  setMcpMarketplaceSource,
})
registerSkillsIpc({
  assertSender: assertMainWindow,
  deleteSkill,
  ensureRoot: ensureSkillRootConfig,
  writeFiles: writeSkillFiles,
})
registerFilesIpc({
  assertSender: assertMainWindow,
  writeFile: writeProjectFile,
})
registerAgentsIpc({
  assertSender: assertMainWindow,
  removeAgentConfig,
})
registerBrowserIpc({
  assertSender: assertMainWindow,
  openExternal: openExternalURL,
  openInternal: openInternalUrl,
  openLocalFile: openLocalFileURL,
})
registerDraftsIpc({
  assertSender: assertMainWindow,
  drafts: draftsStore,
})
registerDesktopIntegrationIpc({
  assertSender: assertMainWindow,
  capturePreview,
  discoverPreviewPorts,
  listLocationApps: locationApps,
  openLocation,
  waitConsoleLogin,
})
registerNotificationIpc({
  assertSender: assertMainWindow,
  microphonePermission,
  notificationPermission,
  sendNotification: sendNativeNotification,
})

let notificationDatabase: DesktopNotificationDatabase | undefined
function getNotificationDatabase() {
  if (!notificationDatabase) {
    const databasePath = join(app.getPath("userData"), "notifications.sqlite")
    notificationDatabase = createNotificationDatabase(databasePath)
    void chmod(databasePath, 0o600).catch(() => undefined)
  }
  return notificationDatabase
}

registerNotificationHistoryIpc({
  assertSender: assertMainWindow,
  list: () => getNotificationDatabase().list(),
  replaceAll: (notifications) => getNotificationDatabase().replaceAll(notifications as StoredNotification[]),
})
registerDiagnosticsIpc({
  assertSender: assertMainWindow,
  exportLogs: exportDebugLogs,
  getDiagnostics: readDiagnostics,
})
registerTaskIpc({
  assertSender: assertMainWindow,
  scheduler: taskScheduler,
  ensureReady: ensureTaskSchedulerStarted,
  notifyChanged: notifyTasksChanged,
})
registerSpeechModelIpc({
  assertSender: assertMainWindow,
  ready: () => speechModelReady,
  service: speechModelService,
})
registerDrivesIpc({ assertSender: assertMainWindow })
registerDialogIpc({ assertSender: assertMainWindow })
const autoUpdater = createAutoUpdater((state) => {
  BrowserWindow.getAllWindows().forEach((window) => window.webContents.send("updater:state", state))
})
registerUpdaterIpc({ assertSender: assertMainWindow, updater: autoUpdater })
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

process.on("uncaughtException", (error) => {
  writeLog("main", "uncaughtException", error)
})

process.on("unhandledRejection", (error) => {
  writeLog("main", "unhandledRejection", error)
})

protocol.registerSchemesAsPrivileged([
  {
    scheme: "opencodex",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
])

function currentServerState() {
  if (server) return { status: "online" as const, server: server.state }
  return { status: "starting" as const, error: serverError }
}

function notifyTasksChanged() {
  BrowserWindow.getAllWindows().forEach((window) => window.webContents.send("task:changed"))
}

function notifyScheduledTaskFinished(run: ScheduledTaskRun, task: ScheduledTask) {
  if (!task.notificationChannels.includes("desktop")) return
  const successful = run.status === "completed"
  const chinese = app.getLocale().toLowerCase().startsWith("zh")
  void sendNativeNotification({
    title: chinese
      ? successful
        ? `自动化已完成：${run.taskTitle}`
        : `自动化${run.status === "cancelled" ? "已取消" : run.status === "blocked" ? "已阻止" : "执行失败"}：${run.taskTitle}`
      : successful
        ? `Automation completed: ${run.taskTitle}`
        : `Automation ${run.status === "cancelled" ? "cancelled" : run.status === "blocked" ? "blocked" : "failed"}: ${run.taskTitle}`,
    body: successful ? run.prompt : run.error || run.prompt,
    sessionId: run.sessionID.startsWith("pending:") ? undefined : run.sessionID,
    directory: run.executionDirectory,
  })
}

app.on("before-quit", (event) => {
  if (isStoppingForQuit) return
  event.preventDefault()
  isQuitting = true
  isStoppingForQuit = true
  draftsStore.flush()
  void Promise.all([taskScheduler.stop(), imBridgeService.stop()])
    .then(stopServer)
    .finally(() => {
      draftsStore.close()
      app.exit(0)
    })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") return
})

if (hasSingleInstanceLock) {
  app.on("second-instance", (_event, argv) => {
    acceptDeepLinkUrls(deepLinkUrlsFromArgv(argv))
    if (app.isReady() && mainWindow) showWindow()
  })

  app.on("open-url", (event, url) => {
    event.preventDefault()
    acceptDeepLinkUrls([url])
    if (app.isReady() && mainWindow) showWindow()
  })
}

if (hasSingleInstanceLock)
  void app
    .whenReady()
    .then(async () => {
      writeLog("startup", "app ready", { elapsedMs: Math.round(performance.now() - startupStartedAt) })
      if (app.isPackaged) app.setAsDefaultProtocolClient("opencodex")
      await receiveDeepLinkUrls(pendingDeepLinkUrls.splice(0))
      const speechStartedAt = performance.now()
      speechModelReady = speechModelService.load().then(() => {
        writeLog("startup", "speech model preferences loaded", {
          durationMs: Math.round(performance.now() - speechStartedAt),
          elapsedMs: Math.round(performance.now() - startupStartedAt),
        })
      })
      const securityStartedAt = performance.now()
      const securityReady = ensureSecurityIntegration()
        .then(() => {
          writeLog("startup", "security integration initialized", {
            durationMs: Math.round(performance.now() - securityStartedAt),
            elapsedMs: Math.round(performance.now() - startupStartedAt),
          })
        })
        .catch((error) => writeLog("security", "failed to initialize security plugins", error))
      const preferencesStartedAt = performance.now()
      desktopPreferences = await desktopPreferencesStore.load()
      writeLog("startup", "desktop preferences loaded", {
        durationMs: Math.round(performance.now() - preferencesStartedAt),
        elapsedMs: Math.round(performance.now() - startupStartedAt),
      })
      configureAppPermissionHandlers()
      applyDesktopPreferences()
      // 并行启动窗口和服务端：让 sidecar 就绪耗时被 renderer 加载掩盖
      await startRendererServerIfNeeded()
      const windowCreated = createWindow()
      initialServerStartup = securityReady.then(() => startServer(rendererUrl()))
      void initialServerStartup
      await windowCreated
      void ensureTaskSchedulerStarted().catch((error) => writeLog("scheduler", "failed to initialize", error))
      void autoUpdater.check().catch((error) => writeLog("updater", "startup check failed", error))
    })
    .catch((error: unknown) => {
      writeLog("main", "startup failed", error)
    })

app.on("activate", () => {
  showWindow()
})

function acceptDeepLinkUrls(urls: string[]) {
  if (!urls.length) return
  if (!app.isReady()) {
    pendingDeepLinkUrls.push(...urls)
    return
  }
  void receiveDeepLinkUrls(urls)
}

function receiveDeepLinkUrls(urls: string[]) {
  deepLinkWork = deepLinkWork.then(() =>
    urls.reduce(
      (previous, url) =>
        previous.then(() =>
          receiveDeepLinkUrl(url).catch(() => {
            writeLog("deep-link", "failed to handle deep link")
          }),
        ),
      Promise.resolve(),
    ),
  )
  return deepLinkWork
}

async function receiveDeepLinkUrl(rawUrl: string) {
  const deepLink = parseDeepLink(rawUrl)
  if (!deepLink) {
    writeLog("deep-link", "rejected invalid deep link")
    return
  }

  const directoryExists = await stat(deepLink.directory).then(
    (entry) => entry.isDirectory(),
    () => false,
  )
  if (!directoryExists) {
    writeLog("deep-link", "rejected unavailable directory", { action: deepLink.action })
    const options = {
      type: "warning" as const,
      message: "OpenCodex could not open this project",
      detail: `The directory does not exist or is not a folder:\n${deepLink.directory}`,
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      await dialog.showMessageBox(mainWindow, options)
      return
    }
    await dialog.showMessageBox(options)
    return
  }

  writeLog("deep-link", "accepted", {
    action: deepLink.action,
    hasPrompt: deepLink.action === "new-session" && Boolean(deepLink.prompt),
  })
  if (!deepLinkRendererReady || !mainWindow || mainWindow.isDestroyed()) {
    pendingDeepLinks.push(deepLink)
    return
  }

  mainWindow.webContents.send("deep-link:received", deepLink)
  showWindow()
}

async function searchPlugins(raw: string) {
  const query = raw.trim()

  const url = new URL("https://registry.npmjs.org/-/v1/search")
  url.searchParams.set("text", query ? `${query} opencode plugin` : "opencode plugin")
  url.searchParams.set("size", "20")
  url.searchParams.set("quality", "0.65")
  url.searchParams.set("popularity", "0.2")
  url.searchParams.set("maintenance", "0.15")

  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`npm search failed with ${response.status}`)

  const data = (await response.json()) as NpmSearchResponse
  const exact = query ? await readNpmManifest(query).catch(() => undefined) : undefined
  const results = (data.objects ?? []).flatMap((item) => {
    const pkg = item.package
    if (!pkg?.name) return []
    return [
      {
        name: pkg.name,
        version: pkg.version ?? "",
        description: pkg.description ?? "",
        keywords: Array.isArray(pkg.keywords) ? pkg.keywords.filter((keyword) => typeof keyword === "string") : [],
        publisher: pkg.publisher?.username ?? "",
        date: pkg.date ?? "",
      },
    ]
  })

  const withExact = exact?.name
    ? [
        {
          name: exact.name,
          version: exact.version ?? "",
          description: exact.description ?? "",
          keywords: Array.isArray(exact.keywords) ? exact.keywords : [],
          publisher: "",
          date: "",
        },
        ...results,
      ]
    : results

  const seen = new Set<string>()
  const unique = withExact.filter((item) => {
    if (seen.has(item.name)) return false
    seen.add(item.name)
    return true
  })
  return Promise.all(
    unique.map(async (item) => {
      const [downloads, compatibility, manifest] = await Promise.all([
        npmDownloads(item.name),
        inspectPluginCompatibility(item.name, item.version, exact),
        exact?.name === item.name
          ? Promise.resolve(exact)
          : readNpmManifest(`${item.name}@${item.version || "latest"}`).catch(() => undefined),
      ])
      return {
        ...item,
        source: "npm",
        url: `https://www.npmjs.com/package/${item.name}`,
        downloads,
        compatibility,
        trustedPublisher: isTrustedPluginPublisher(item.name, item.publisher),
        signatureStatus: pluginSignatureStatus(manifest),
      }
    }),
  )
}

async function inspectPluginCompatibility(name: string, version: string, exact?: NpmPackageManifest) {
  const key = `${name}@${version || "latest"}`
  const cached = pluginCompatibilityCache.get(key)
  if (cached) return cached

  const manifest =
    exact?.name === name && exact.version === version ? exact : await readNpmManifest(key).catch(() => undefined)
  if (!manifest) return "unknown" as const

  const compatibility = pluginTargets(manifest).length ? ("supported" as const) : ("unsupported" as const)
  pluginCompatibilityCache.set(key, compatibility)
  return compatibility
}

async function inspectPlugins(value: unknown) {
  const specs = Array.isArray(value) ? value.filter(isString).slice(0, 50) : []
  return Promise.all(
    specs.map(async (spec) => {
      if (isPathPluginSpec(spec)) {
        return {
          spec,
          packageName: spec,
          configuredVersion: "",
          latestVersion: "",
          source: "local" as const,
          url: "",
          updateAvailable: false,
          trustedPublisher: false,
          signatureStatus: "unverified" as const,
          integrity: "",
          permissions: ["code-execution", "filesystem", "environment"],
          updateChanges: [],
        }
      }

      const parsed = parseNpmSpecifier(spec)
      const [latest, configured] = await Promise.all([
        readNpmManifest(parsed.name).catch(() => undefined),
        readNpmManifest(`${parsed.name}@${parsed.version}`).catch(() => undefined),
      ])
      const configuredVersion = parsed.version === "latest" ? "" : parsed.version
      const latestVersion = latest?.version ?? ""
      return {
        spec,
        packageName: parsed.name,
        configuredVersion,
        latestVersion,
        source: "npm" as const,
        url: `https://www.npmjs.com/package/${parsed.name}`,
        updateAvailable: Boolean(configuredVersion && latestVersion && configuredVersion !== latestVersion),
        trustedPublisher: isTrustedPluginPublisher(parsed.name, latest?.maintainers?.[0]?.name ?? ""),
        signatureStatus: pluginSignatureStatus(configured ?? latest),
        integrity: configured?.dist?.integrity ?? latest?.dist?.integrity ?? "",
        permissions: [
          "code-execution",
          "filesystem",
          "environment",
          ...(Object.keys(configured?.dependencies ?? {}).some((name) => /http|fetch|request|socket|ws/i.test(name))
            ? ["network"]
            : []),
        ],
        updateChanges: pluginUpdateChanges(configured, latest),
      }
    }),
  )
}

function pluginSignatureStatus(manifest?: NpmPackageManifest) {
  if (manifest?.dist?.signatures?.some((item) => item.sig && item.keyid)) return "signed" as const
  if (manifest?.dist?.integrity) return "integrity" as const
  return "unverified" as const
}

function isTrustedPluginPublisher(name: string, publisher: string) {
  return (
    name.startsWith("@opencode-ai/") ||
    name.startsWith("@anomalyco/") ||
    publisher === "opencode" ||
    publisher === "anomalyco"
  )
}

function pluginUpdateChanges(configured?: NpmPackageManifest, latest?: NpmPackageManifest) {
  if (!configured || !latest || configured.version === latest.version) return []
  const currentDependencies = new Set(Object.keys(configured.dependencies ?? {}))
  const nextDependencies = new Set(Object.keys(latest.dependencies ?? {}))
  const added = [...nextDependencies].filter((name) => !currentDependencies.has(name))
  const removed = [...currentDependencies].filter((name) => !nextDependencies.has(name))
  return [
    `version ${configured.version ?? "?"} → ${latest.version ?? "?"}`,
    ...(added.length ? [`dependencies added: ${added.join(", ")}`] : []),
    ...(removed.length ? [`dependencies removed: ${removed.join(", ")}`] : []),
    ...(JSON.stringify(configured.scripts ?? {}) !== JSON.stringify(latest.scripts ?? {})
      ? ["lifecycle scripts changed"]
      : []),
  ]
}

async function npmDownloads(name: string) {
  const response = await fetch(
    `https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(name).replace("%2F", "%2f")}`,
  ).catch(() => undefined)
  if (!response?.ok) return 0
  const value = (await response.json()) as { downloads?: number }
  return value.downloads ?? 0
}

async function searchMcpServers(input: unknown) {
  const options = isRecord(input) ? input : {}
  const provider = options.provider === "netease" ? "netease" : "official"
  const query = typeof options.query === "string" ? options.query.trim() : ""
  const category = typeof options.category === "string" ? options.category.trim() : ""
  const cursor = typeof options.cursor === "string" ? options.cursor : ""
  if (provider === "netease") return searchNetEaseMcpServers(query, category, cursor)
  const url = new URL("https://registry.modelcontextprotocol.io/v0.1/servers")
  if (query) url.searchParams.set("search", query)
  url.searchParams.set("version", "latest")
  url.searchParams.set("limit", "30")
  if (cursor) url.searchParams.set("cursor", cursor)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`MCP Registry search failed with ${response.status}`)
  const data = (await response.json()) as {
    servers?: Array<{ server?: Record<string, unknown>; _meta?: Record<string, unknown> }>
    metadata?: { nextCursor?: string }
  }
  const results = await Promise.all(
    (data.servers ?? [])
      .flatMap((entry) => {
        const item = entry.server
        if (!item || typeof item.name !== "string") return []
        const packages = Array.isArray(item.packages) ? item.packages.filter(isRecord) : []
        const npm = packages.find((pkg) => pkg.registryType === "npm" && typeof pkg.identifier === "string")
        const remotes = Array.isArray(item.remotes) ? item.remotes.filter(isRecord) : []
        const remote = remotes.find((value) => typeof value.url === "string")
        const config = npm
          ? {
              type: "local" as const,
              command: ["npx", "-y", `${String(npm.identifier)}@${String(npm.version ?? item.version ?? "latest")}`],
            }
          : remote
            ? { type: "remote" as const, url: String(remote.url) }
            : undefined
        if (!config) return []
        const repository = isRecord(item.repository) ? item.repository : undefined
        const environment =
          npm && Array.isArray(npm.environmentVariables) ? npm.environmentVariables.filter(isRecord) : []
        const official = isRecord(entry._meta?.["io.modelcontextprotocol.registry/official"])
          ? (entry._meta?.["io.modelcontextprotocol.registry/official"] as Record<string, unknown>)
          : undefined
        return [{ item, npm, repository, environment, official, config }]
      })
      .map(async ({ item, npm, repository, environment, official, config }) => ({
        provider: "official" as const,
        name: String(item.name),
        version: String(item.version ?? ""),
        description: typeof item.description === "string" ? item.description : "",
        source: repository?.source ? String(repository.source) : "Official MCP Registry",
        sourceUrl: repository?.url ? String(repository.url) : "https://registry.modelcontextprotocol.io/",
        downloads: npm ? await npmDownloads(String(npm.identifier)) : 0,
        publishedAt: official?.publishedAt ? String(official.publishedAt) : "",
        requiredEnvironment: environment
          .filter((value) => value.isRequired === true && typeof value.name === "string")
          .map((value) => String(value.name)),
        category: "",
        tags: [],
        config,
      })),
  )
  return { data: results, nextCursor: data.metadata?.nextCursor ?? null, categories: [] }
}

let neteaseMcpMarketplaceCache: { expires: number; value: Record<string, unknown> } | undefined

async function searchNetEaseMcpServers(query: string, category: string, cursor: string) {
  const root = await neteaseMcpMarketplaceValue()
  const servers = Array.isArray(root.servers) ? root.servers : []
  const categories = Array.isArray(root.categories)
    ? root.categories.flatMap((entry) => {
        const item = isRecord(entry) ? entry : undefined
        const id = typeof item?.id === "string" ? item.id : ""
        if (!id || id === "all") return []
        return [
          {
            id,
            nameZh: typeof item?.name_zh === "string" ? item.name_zh : id,
            nameEn: typeof item?.name_en === "string" ? item.name_en : id,
          },
        ]
      })
    : []
  const normalized = servers
    .flatMap((server) => {
      const item = isRecord(server) ? server : undefined
      if (!item) return []
      const id = typeof item.id === "string" ? item.id.trim() : ""
      const name = typeof item.name === "string" ? item.name.trim() : id
      const itemCategory = typeof item.category === "string" ? item.category.trim() : ""
      const command = typeof item.command === "string" ? item.command.trim() : ""
      const args = Array.isArray(item.defaultArgs) ? item.defaultArgs.filter(isString) : []
      const remoteUrl = typeof item.url === "string" ? item.url.trim() : ""
      const config = command
        ? { type: "local" as const, command: [command, ...args] }
        : remoteUrl
          ? { type: "remote" as const, url: remoteUrl }
          : undefined
      if (!name || !config) return []
      return [
        {
          provider: "netease" as const,
          name,
          version: typeof item.version === "string" ? item.version : "",
          description:
            localizedMarketplaceText(item.description_zh) ||
            localizedMarketplaceText(item.description) ||
            localizedMarketplaceText(item.description_en),
          source: "NetEase Youdao",
          sourceUrl: "https://github.com/netease-youdao/LobsterAI",
          downloads: typeof item.downloadCount === "number" ? item.downloadCount : 0,
          publishedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
          requiredEnvironment: Array.isArray(item.requiredEnvKeys) ? item.requiredEnvKeys.filter(isString) : [],
          category: itemCategory,
          tags: Array.isArray(item.tags) ? item.tags.filter(isString) : [],
          config,
        },
      ]
    })
    .filter((item) => {
      const keyword = query.toLocaleLowerCase()
      const matchesQuery =
        !keyword ||
        [item.name, item.description, item.category, ...item.tags].some((value) =>
          value.toLocaleLowerCase().includes(keyword),
        )
      return matchesQuery && (!category || item.category === category)
    })
  const offset = Math.max(0, Number.parseInt(cursor || "0", 10) || 0)
  const page = normalized.slice(offset, offset + 30)
  return {
    data: page,
    nextCursor: offset + page.length < normalized.length ? String(offset + page.length) : null,
    categories,
  }
}

async function neteaseMcpMarketplaceValue() {
  if (neteaseMcpMarketplaceCache && neteaseMcpMarketplaceCache.expires > Date.now())
    return neteaseMcpMarketplaceCache.value
  const response = await fetch(
    "https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/mcp-marketplace",
    { signal: AbortSignal.timeout(15_000) },
  )
  if (!response.ok) throw new Error(`NetEase MCP marketplace request failed with ${response.status}`)
  const envelope = await response.json()
  const data = isRecord(envelope) && isRecord(envelope.data) ? envelope.data : undefined
  const raw = data?.value
  const value = typeof raw === "string" ? JSON.parse(raw) : raw
  const root = isRecord(value) ? value : {}
  neteaseMcpMarketplaceCache = { expires: Date.now() + 5 * 60_000, value: root }
  return root
}

function localizedMarketplaceText(value: unknown) {
  if (typeof value === "string") return value.trim()
  if (!isRecord(value)) return ""
  return typeof value.zh === "string" ? value.zh.trim() : typeof value.en === "string" ? value.en.trim() : ""
}

function mcpMarketplaceSourceFile() {
  return join(app.getPath("userData"), "marketplace-sources.json")
}

async function setMcpMarketplaceSource(input: unknown) {
  if (!isRecord(input) || typeof input.name !== "string") throw new Error("MCP server name is required")
  const directory = typeof input.directory === "string" ? input.directory : "global"
  const key = `${directory}\0${input.name}`
  const current = await readFile(mcpMarketplaceSourceFile(), "utf8").then(
    (value) => JSON.parse(value),
    () => ({}),
  )
  const sources = isRecord(current) ? current : {}
  if (input.provider === "official" || input.provider === "netease") sources[key] = input.provider
  else delete sources[key]
  await writeFile(mcpMarketplaceSourceFile(), JSON.stringify(sources, null, 2), "utf8")
}

async function mcpSources(input: unknown) {
  if (!isRecord(input) || !Array.isArray(input.names)) throw new Error("MCP server names are required")
  const names = input.names.filter(isString)
  const sourceDirectory = typeof input.directory === "string" && input.directory ? input.directory : undefined
  const directory = sourceDirectory ? resolve(sourceDirectory) : undefined
  const files = [
    ...["config.json", "opencode.json", "opencode.jsonc"].map((file) => join(pluginConfigDir(), file)),
    ...(directory
      ? [
          join(directory, "opencode.json"),
          join(directory, "opencode.jsonc"),
          join(directory, ".opencode", "opencode.json"),
          join(directory, ".opencode", "opencode.jsonc"),
        ]
      : []),
  ]
  const configured: Record<string, string> = {}
  const plugins: string[] = []

  for (const file of files) {
    const source = await readFile(file, "utf8").catch(() => "")
    if (!source) continue
    const errors: ParseError[] = []
    const value = parseJsonc(source, errors, { allowTrailingComma: true })
    if (errors.length || !isRecord(value)) continue
    if (isRecord(value.mcp)) {
      Object.keys(value.mcp).forEach((name) => {
        configured[name] = file
      })
    }
    if (Array.isArray(value.plugin)) {
      value.plugin.forEach((entry) => {
        const spec =
          typeof entry === "string" ? entry : Array.isArray(entry) && typeof entry[0] === "string" ? entry[0] : ""
        if (spec && !plugins.includes(spec)) plugins.push(spec)
      })
    }
  }

  const stored = await readFile(mcpMarketplaceSourceFile(), "utf8").then(
    (value) => JSON.parse(value),
    () => ({}),
  )
  const marketplace = isRecord(stored) ? stored : {}
  return Object.fromEntries(
    names.map((name) => {
      const provider = marketplace[`${sourceDirectory ?? "global"}\0${name}`]
      if (provider === "official" || provider === "netease") {
        return [name, { kind: "marketplace" as const, detail: provider, provider }]
      }
      if (configured[name]) return [name, { kind: "config" as const, detail: configured[name] }]
      if (plugins.length) return [name, { kind: "plugin" as const, detail: plugins.join(", ") }]
      return [name, { kind: "runtime" as const, detail: "" }]
    }),
  )
}

type NetEaseExpertKit = {
  id: string
  name: string
  description: string
  icon: string
  author: string
  version: string
  downloadCount: number
  tryAsking: string[]
  archive: string
  skills: Array<{ id: string; name: string; description: string }>
}

type ExpertKitState = {
  kits: Record<string, { provider: "netease"; name: string; version: string; installedAt: string; skills: string[] }>
  skills: Record<string, { hash: string; owners: string[] }>
}

let neteaseExpertKitCache: { expires: number; data: NetEaseExpertKit[] } | undefined

async function neteaseExpertKits() {
  if (neteaseExpertKitCache && neteaseExpertKitCache.expires > Date.now()) return neteaseExpertKitCache.data
  const response = await fetch("https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/kit-store", {
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`NetEase expert kit marketplace request failed with ${response.status}`)
  const envelope = await response.json()
  const data = isRecord(envelope) && isRecord(envelope.data) ? envelope.data : undefined
  const raw = data?.value
  const value = typeof raw === "string" ? JSON.parse(raw) : raw
  const root = isRecord(value) ? value : {}
  const kits = Array.isArray(root.kits) ? root.kits : []
  const result = kits.flatMap((entry): NetEaseExpertKit[] => {
    const kit = isRecord(entry) ? entry : undefined
    const skillInfo = isRecord(kit?.skills) ? kit.skills : undefined
    const id = typeof kit?.id === "string" ? kit.id.trim() : ""
    const archive = typeof skillInfo?.bundle === "string" ? skillInfo.bundle.trim() : ""
    if (!id || !archive || !archive.startsWith("https://")) return []
    const list = Array.isArray(skillInfo?.list) ? skillInfo.list : []
    return [
      {
        id,
        name: localizedMarketplaceText(kit?.name) || id,
        description: localizedMarketplaceText(kit?.description),
        icon: typeof kit?.icon === "string" ? kit.icon : "",
        author: typeof kit?.author === "string" ? kit.author : "NetEase Youdao",
        version: typeof kit?.version === "string" ? kit.version : "",
        downloadCount:
          typeof kit?.downloadCount === "number"
            ? kit.downloadCount
            : Number.parseInt(String(kit?.downloadCount ?? "0"), 10) || 0,
        tryAsking: Array.isArray(kit?.tryAsking)
          ? kit.tryAsking.flatMap((item) => {
              const text = localizedMarketplaceText(item)
              return text ? [text] : []
            })
          : [],
        archive,
        skills: list.flatMap((item) => {
          const skill = isRecord(item) ? item : undefined
          const skillID = typeof skill?.id === "string" ? skill.id : ""
          if (!skillID) return []
          return [
            {
              id: skillID,
              name: localizedMarketplaceText(skill?.name) || skillID,
              description: localizedMarketplaceText(skill?.description),
            },
          ]
        }),
      },
    ]
  })
  neteaseExpertKitCache = { expires: Date.now() + 5 * 60_000, data: result }
  return result
}

function expertKitStateFile() {
  return join(app.getPath("userData"), "expert-kits.json")
}

async function readExpertKitState(): Promise<ExpertKitState> {
  const value = await readFile(expertKitStateFile(), "utf8").then(
    (content) => JSON.parse(content),
    () => undefined,
  )
  if (!isRecord(value)) return { kits: {}, skills: {} }
  return {
    kits: isRecord(value.kits) ? (value.kits as ExpertKitState["kits"]) : {},
    skills: isRecord(value.skills) ? (value.skills as ExpertKitState["skills"]) : {},
  }
}

async function searchExpertKits(raw: string) {
  const query = raw.trim().toLocaleLowerCase()
  const [kits, state] = await Promise.all([neteaseExpertKits(), readExpertKitState()])
  return kits
    .filter(
      (kit) =>
        !query ||
        [kit.name, kit.description, kit.author, ...kit.skills.flatMap((skill) => [skill.name, skill.description])].some(
          (value) => value.toLocaleLowerCase().includes(query),
        ),
    )
    .map((kit) => ({
      id: kit.id,
      name: kit.name,
      description: kit.description,
      icon: kit.icon,
      author: kit.author,
      version: kit.version,
      downloadCount: kit.downloadCount,
      tryAsking: kit.tryAsking,
      skills: kit.skills,
      installed: Boolean(state.kits[kit.id]),
      updateAvailable: Boolean(state.kits[kit.id] && state.kits[kit.id].version !== kit.version),
    }))
}

async function expertKitSkillSources() {
  const state = await readExpertKitState()
  return Object.entries(state.kits).map(([id, kit]) => ({
    id,
    name: kit.name,
    skills: kit.skills,
  }))
}

async function installExpertKit(raw: string, force: boolean) {
  const kit = (await neteaseExpertKits()).find((item) => item.id === raw.trim())
  if (!kit) throw new Error("Expert kit was not found in the NetEase marketplace")
  const response = await fetch(kit.archive, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`Unable to download expert kit (${response.status})`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0 || bytes.byteLength > 50 * 1024 * 1024)
    throw new Error("Expert kit archive exceeds the size limit")
  const temporary = await mkdtemp(join(tmpdir(), "opencodex-kit-"))
  const archive = join(temporary, "kit.zip")
  const unpacked = join(temporary, "unpacked")
  await writeFile(archive, bytes)
  await mkdir(unpacked, { recursive: true })
  try {
    let extractedBytes = 0
    await extract(archive, {
      dir: unpacked,
      onEntry: (entry) => {
        extractedBytes += entry.uncompressedSize
        if (entry.uncompressedSize > 5 * 1024 * 1024 || extractedBytes > 50 * 1024 * 1024) {
          throw new Error("Expert kit archive exceeds the extracted size limit")
        }
      },
    })
    const sources = await discoverExpertKitSkills(unpacked)
    if (sources.length === 0) throw new Error("Expert kit does not contain any installable skills")
    const root = join(homedir(), ".opencodex", "skills")
    const state = await readExpertKitState()
    const prepared = await Promise.all(
      sources.map(async (source) => {
        const slug = safeKitSlug(basename(source))
        const target = join(root, slug)
        const nextHash = await expertKitDirectoryHash(source)
        const tracked = state.skills[slug]
        const exists = await stat(target).then(
          () => true,
          () => false,
        )
        const currentHash = exists ? await expertKitDirectoryHash(target) : undefined
        const owned = tracked?.owners.includes(kit.id) === true
        if (exists && currentHash !== nextHash && (!owned || currentHash !== tracked?.hash) && !force) {
          throw new Error(`Skill “${slug}” already exists or has local changes`)
        }
        return { source, slug, target, nextHash, tracked, exists, currentHash }
      }),
    )
    await mkdir(root, { recursive: true })
    await Promise.all(
      prepared.map(async (item) => {
        if (item.exists && item.currentHash === item.nextHash) return
        const staging = `${item.target}.kit-tmp-${crypto.randomUUID()}`
        const backup = `${item.target}.kit-old-${crypto.randomUUID()}`
        await cp(item.source, staging, { recursive: true, errorOnExist: true })
        if (item.exists) await rename(item.target, backup)
        await rename(staging, item.target).catch(async (cause) => {
          if (item.exists) await rename(backup, item.target).catch(() => undefined)
          throw cause
        })
        if (item.exists) await rm(backup, { recursive: true, force: true })
      }),
    )
    const installedSkills = new Set(prepared.map((item) => item.slug))
    const removedSkills = (state.kits[kit.id]?.skills ?? []).filter((slug) => !installedSkills.has(slug))
    await Promise.all(
      removedSkills.map(async (slug) => {
        const tracked = state.skills[slug]
        if (!tracked) return
        const owners = tracked.owners.filter((owner) => owner !== kit.id)
        if (owners.length > 0) {
          state.skills[slug] = { ...tracked, owners }
          return
        }
        const target = join(root, slug)
        const current = await stat(target).then(
          () => expertKitDirectoryHash(target),
          () => undefined,
        )
        if (current === tracked.hash) await rm(target, { recursive: true, force: true })
        delete state.skills[slug]
      }),
    )
    prepared.forEach((item) => {
      state.skills[item.slug] = {
        hash: item.nextHash,
        owners: Array.from(new Set([...(item.tracked?.owners ?? []), kit.id])),
      }
    })
    state.kits[kit.id] = {
      provider: "netease",
      name: kit.name,
      version: kit.version,
      installedAt: state.kits[kit.id]?.installedAt ?? new Date().toISOString(),
      skills: prepared.map((item) => item.slug),
    }
    await writeFile(expertKitStateFile(), JSON.stringify(state, null, 2), "utf8")
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function removeExpertKit(raw: string, force: boolean) {
  const id = raw.trim()
  const state = await readExpertKitState()
  const kit = state.kits[id]
  if (!kit) return
  const root = join(homedir(), ".opencodex", "skills")
  const removable = await Promise.all(
    kit.skills.map(async (slug) => {
      const tracked = state.skills[slug]
      if (!tracked || tracked.owners.some((owner) => owner !== id)) return { slug, remove: false }
      const target = join(root, slug)
      const exists = await stat(target).then(
        () => true,
        () => false,
      )
      if (!exists) return { slug, remove: true }
      const current = await expertKitDirectoryHash(target)
      if (current !== tracked.hash && !force) throw new Error(`Skill “${slug}” has local changes`)
      return { slug, remove: true }
    }),
  )
  await Promise.all(
    removable.filter((item) => item.remove).map((item) => rm(join(root, item.slug), { recursive: true, force: true })),
  )
  kit.skills.forEach((slug) => {
    const tracked = state.skills[slug]
    if (!tracked) return
    const owners = tracked.owners.filter((owner) => owner !== id)
    if (owners.length > 0) state.skills[slug] = { ...tracked, owners }
    else delete state.skills[slug]
  })
  delete state.kits[id]
  await writeFile(expertKitStateFile(), JSON.stringify(state, null, 2), "utf8")
}

async function discoverExpertKitSkills(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const direct = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const directory = join(root, entry.name)
        return stat(join(directory, "SKILL.md")).then(
          (info) => (info.isFile() ? directory : undefined),
          () => undefined,
        )
      }),
  )
  const skills = direct.filter((directory): directory is string => Boolean(directory))
  if (skills.length > 0) return skills
  if (entries.length === 1 && entries[0]?.isDirectory()) return discoverExpertKitSkills(join(root, entries[0].name))
  return []
}

async function expertKitDirectoryHash(root: string) {
  const files: Array<{ path: string; contents: Uint8Array }> = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    await Promise.all(
      entries.map(async (entry) => {
        const file = join(directory, entry.name)
        if (entry.isSymbolicLink()) throw new Error("Expert kit contains a symbolic link")
        if (entry.isDirectory()) return visit(file)
        if (!entry.isFile()) throw new Error("Expert kit contains an unsupported entry")
        const contents = new Uint8Array(await readFile(file))
        if (contents.byteLength > 1024 * 1024) throw new Error("Expert kit contains a file larger than 1 MB")
        files.push({ path: relative(root, file).split("\\").join("/"), contents })
      }),
    )
  }
  await visit(root)
  if (!files.some((file) => file.path === "SKILL.md")) throw new Error("Expert kit skill does not contain SKILL.md")
  if (files.reduce((total, file) => total + file.contents.byteLength, 0) > 5 * 1024 * 1024)
    throw new Error("Expert kit skill exceeds the size limit")
  const digest = createHash("sha256")
  files
    .toSorted((left, right) => left.path.localeCompare(right.path))
    .forEach((file) => {
      digest.update(file.path)
      digest.update("\0")
      digest.update(file.contents)
      digest.update("\0")
    })
  return digest.digest("hex")
}

function safeKitSlug(value: string) {
  const slug = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (!slug || slug === "." || slug === "..") throw new Error("Expert kit contains an invalid skill name")
  return slug
}

async function installPlugin(raw: string) {
  const spec = raw.trim()
  if (!spec) throw new Error("Plugin package name is required")
  if (isPathPluginSpec(spec)) throw new Error("One-click install only supports npm packages")

  const manifest = await readNpmManifest(spec)
  const targets = pluginTargets(manifest)
  if (!targets.length) {
    throw new Error(`${manifest.name ?? spec} does not expose opencode plugin entrypoints`)
  }

  const configDir = pluginConfigDir()
  await mkdir(configDir, { recursive: true })
  await mkdir(pluginCacheDir(), { recursive: true })

  const items = await Promise.all(targets.map((target) => patchPluginConfig(configDir, target, spec)))
  return {
    ok: true,
    spec,
    packageName: manifest.name ?? parseNpmSpecifier(spec).name,
    version: manifest.version ?? "",
    configDir,
    cacheDir: pluginCacheDir(),
    items,
  }
}

function pluginConfigDir() {
  return join(app.getPath("userData"), "config", "opencode")
}

function securityConfigFile() {
  return join(app.getPath("userData"), "security.json")
}

async function windowsSandboxStatus() {
  if (process.platform !== "win32") {
    return { supported: false, available: false, installed: false }
  }
  const executable = windowsSandboxExecutable()
  const available = await access(executable).then(
    () => true,
    () => false,
  )
  if (!available) {
    return { supported: true, available: false, installed: false, error: `srt-win.exe not found: ${executable}` }
  }
  const result = await runWindowsSandbox(["user", "status"])
  if (result.code !== 0) {
    return {
      supported: true,
      available: true,
      installed: false,
      error: result.stderr || result.stdout || `srt-win user status exited ${result.code}`,
    }
  }
  try {
    const value = JSON.parse(result.stdout) as unknown
    const root = isRecord(value) ? value : {}
    const user = isRecord(root.user) ? root.user : {}
    return {
      supported: true,
      available: true,
      installed: user.exists === true && root.cred_present === true,
    }
  } catch (error) {
    return {
      supported: true,
      available: true,
      installed: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function windowsSandboxExecutable() {
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  return join(sandboxRuntimeRoot(), "vendor", "srt-win", arch, "srt-win.exe")
}

function runWindowsSandbox(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawnProcess(windowsSandboxExecutable(), args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.once("error", reject)
    child.once("exit", (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }))
  })
}

function defaultSecurityConfig(): SecurityConfig {
  return {
    sandbox: {
      enabled: true,
      denyRead: [
        "~/.ssh",
        "~/.gnupg",
        "~/.aws/credentials",
        "~/.azure",
        "~/.config/gcloud",
        "~/.config/gh",
        "~/.kube",
        "~/.docker/config.json",
        "~/.npmrc",
        "~/.netrc",
        "~/.env",
      ],
      allowRead: [],
      allowWrite: [],
      denyWrite: [],
      allowedDomains: [
        "registry.npmjs.org",
        "*.npmjs.org",
        "registry.yarnpkg.com",
        "pypi.org",
        "*.pypi.org",
        "crates.io",
        "*.crates.io",
        "github.com",
        "*.github.com",
        "gitlab.com",
        "*.gitlab.com",
        "bitbucket.org",
        "*.bitbucket.org",
        "api.openai.com",
        "api.anthropic.com",
        "generativelanguage.googleapis.com",
        "*.googleapis.com",
      ],
      deniedDomains: [],
      allowedIPs: [],
      deniedIPs: [],
      blockPrivateNetworks: true,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    },
    audit: {
      enabled: false,
      directory: join(app.getPath("userData"), "audit"),
    },
  }
}

async function readSecurityConfig() {
  const value = await readFile(securityConfigFile(), "utf8").then(JSON.parse, () => undefined)
  return normalizeSecurityConfig(value)
}

async function readSecurityAudit() {
  const directory = (await readSecurityConfig()).audit.directory
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const files = entries
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".log")))
    .sort((left, right) => right.name.localeCompare(left.name))
    .slice(0, 10)
  const contents = await Promise.all(
    files.map(async (entry) => ({
      file: entry.name,
      text: await readFile(join(directory, entry.name), "utf8").catch(() => ""),
    })),
  )
  return contents
    .flatMap((item) =>
      item.text
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-200)
        .map((line) => ({ file: item.file, line })),
    )
    .slice(-500)
    .reverse()
}

async function updateSecurityConfig(value: unknown) {
  const config = normalizeSecurityConfig(value)
  await writeSecurityConfig(config)
  await restartServer()
  return config
}

async function installWindowsSandbox() {
  if (process.platform !== "win32") throw new Error("Windows sandbox installation is only available on Windows")
  const result = await runWindowsSandbox(["install", "--force"])
  if (result.code === 10) return { ...(await windowsSandboxStatus()), cancelled: true }
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `srt-win install exited ${result.code}`)
  }
  await restartServer()
  return windowsSandboxStatus()
}

async function readDiagnostics() {
  const security = await readSecurityConfig()
  return {
    generatedAt: new Date().toISOString(),
    application: {
      name: app.getName(),
      version: app.getVersion(),
      packaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      locale: app.getLocale(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      uptimeSeconds: Math.round(process.uptime()),
    },
    localRunner: {
      status: server ? "online" : "starting",
      error: serverError,
    },
    imBridge: {
      status: imBridgeService.state().status,
    },
    security: {
      sandboxEnabled: security.sandbox.enabled,
      blockPrivateNetworks: security.sandbox.blockPrivateNetworks,
      allowedDomainRules: security.sandbox.allowedDomains.length,
      deniedDomainRules: security.sandbox.deniedDomains.length,
      allowedIPRules: security.sandbox.allowedIPs.length,
      deniedIPRules: security.sandbox.deniedIPs.length,
      auditEnabled: security.audit.enabled,
      windowsSandbox: await windowsSandboxStatus(),
    },
    recentLogs: diagnosticLogTail(),
  }
}

function normalizeSecurityConfig(value: unknown): SecurityConfig {
  const defaults = defaultSecurityConfig()
  if (!isRecord(value)) return defaults
  const sandbox = isRecord(value.sandbox) ? value.sandbox : {}
  const audit = isRecord(value.audit) ? value.audit : {}
  const strings = (input: unknown, fallback: string[]) => (Array.isArray(input) ? input.filter(isString) : fallback)
  const ipRules = (input: unknown, fallback: string[], allowAll: boolean) => {
    const values = strings(input, fallback)
    const invalid = values.find((rule) => {
      if (allowAll && rule === "*") return false
      const slash = rule.lastIndexOf("/")
      const address = (slash === -1 ? rule : rule.slice(0, slash)).replace(/^\[|\]$/g, "")
      const family = isIP(address)
      if (!family) return true
      if (slash === -1) return false
      const prefix = rule.slice(slash + 1)
      return !/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)
    })
    if (invalid) throw new Error(`Invalid IP or CIDR rule: ${invalid}`)
    return values
  }
  return {
    sandbox: {
      enabled: typeof sandbox.enabled === "boolean" ? sandbox.enabled : defaults.sandbox.enabled,
      denyRead: strings(sandbox.denyRead, defaults.sandbox.denyRead),
      allowRead: strings(sandbox.allowRead, defaults.sandbox.allowRead),
      allowWrite: strings(sandbox.allowWrite, defaults.sandbox.allowWrite),
      denyWrite: strings(sandbox.denyWrite, defaults.sandbox.denyWrite),
      allowedDomains: strings(sandbox.allowedDomains, defaults.sandbox.allowedDomains),
      deniedDomains: strings(sandbox.deniedDomains, defaults.sandbox.deniedDomains),
      allowedIPs: ipRules(sandbox.allowedIPs, defaults.sandbox.allowedIPs, false),
      deniedIPs: ipRules(sandbox.deniedIPs, defaults.sandbox.deniedIPs, true),
      blockPrivateNetworks:
        typeof sandbox.blockPrivateNetworks === "boolean"
          ? sandbox.blockPrivateNetworks
          : defaults.sandbox.blockPrivateNetworks,
      allowUnixSockets: strings(sandbox.allowUnixSockets, defaults.sandbox.allowUnixSockets),
      allowAllUnixSockets:
        typeof sandbox.allowAllUnixSockets === "boolean"
          ? sandbox.allowAllUnixSockets
          : defaults.sandbox.allowAllUnixSockets,
      allowLocalBinding:
        typeof sandbox.allowLocalBinding === "boolean" ? sandbox.allowLocalBinding : defaults.sandbox.allowLocalBinding,
    },
    audit: {
      enabled: typeof audit.enabled === "boolean" ? audit.enabled : defaults.audit.enabled,
      directory:
        typeof audit.directory === "string" && audit.directory.trim()
          ? resolve(audit.directory)
          : defaults.audit.directory,
    },
  }
}

async function ensureSecurityIntegration() {
  const config = await readSecurityConfig()
  await removeLegacySecurityPlugins()
  await rm(join(pluginConfigDir(), "logger.json"), { force: true })
  await rm(join(app.getPath("userData"), "config", "opencode-sandbox"), { recursive: true, force: true })
  await writeSecurityConfig(config)
}

async function removeLegacySecurityPlugins() {
  const file = await pluginConfigFile(pluginConfigDir(), "server")
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return
    throw error
  })
  if (!text) return
  const errors: ParseError[] = []
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true }) as { plugin?: unknown[] }
  if (errors.length || !Array.isArray(parsed.plugin)) return
  const plugins = parsed.plugin.filter((item) => {
    const spec = pluginEntrySpec(item)
    return spec !== "opencode-sandbox" && spec !== "@frankhommers/opencode-plugin-logger"
  })
  if (plugins.length === parsed.plugin.length) return
  await writeFile(
    file,
    applyEdits(text, modify(text, ["plugin"], plugins, { formattingOptions: { insertSpaces: true, tabSize: 2 } })),
  )
}

async function writeSecurityConfig(config: SecurityConfig) {
  await mkdir(dirname(securityConfigFile()), { recursive: true })
  await writeFile(securityConfigFile(), JSON.stringify(config, null, 2))
}

function pluginCacheDir() {
  return join(app.getPath("userData"), "cache", "opencode", "packages")
}

async function readNpmManifest(spec: string): Promise<NpmPackageManifest> {
  const parsed = parseNpmSpecifier(spec)
  const version = parsed.version || "latest"
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(parsed.name).replace("%2F", "%2f")}/${version}`,
  )
  if (!response.ok) throw new Error(`npm package lookup failed with ${response.status}`)
  return (await response.json()) as NpmPackageManifest
}

function parseNpmSpecifier(spec: string) {
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/")
    const versionAt = slash >= 0 ? spec.indexOf("@", slash) : -1
    if (versionAt > 0) return { name: spec.slice(0, versionAt), version: spec.slice(versionAt + 1) }
    return { name: spec, version: "latest" }
  }

  const versionAt = spec.indexOf("@")
  if (versionAt > 0) return { name: spec.slice(0, versionAt), version: spec.slice(versionAt + 1) }
  return { name: spec, version: "latest" }
}

function isPathPluginSpec(spec: string) {
  return spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("file:")
}

function pluginTargets(pkg: NpmPackageManifest) {
  const targets: PluginInstallTarget[] = []
  const server = exportTarget(pkg.exports, "server")
  if (server) {
    targets.push({ kind: "server", opts: server.opts })
  } else if (typeof pkg.main === "string" && pkg.main.trim()) {
    targets.push({ kind: "server" })
  }

  const tui = exportTarget(pkg.exports, "tui")
  if (tui) targets.push({ kind: "tui", opts: tui.opts })
  if (!targets.some((target) => target.kind === "tui") && hasThemeTargets(pkg["oc-themes"])) {
    targets.push({ kind: "tui" })
  }

  return targets
}

function exportTarget(exports: unknown, kind: "server" | "tui") {
  if (!isRecord(exports)) return
  const value = exports[`./${kind}`]
  if (!exportValue(value)) return
  return {
    opts: exportOptions(value),
  }
}

function exportValue(value: unknown) {
  if (typeof value === "string") return value.trim() || undefined
  if (!isRecord(value)) return
  for (const key of ["import", "default"]) {
    const next = value[key]
    if (typeof next === "string" && next.trim()) return next.trim()
  }
}

function exportOptions(value: unknown) {
  if (!isRecord(value)) return
  const config = value.config
  if (!isRecord(config)) return
  return config
}

function hasThemeTargets(value: unknown) {
  return (
    Array.isArray(value) &&
    value.some((item) => typeof item === "string" && item.trim() && !item.startsWith("/") && !item.startsWith("file:"))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function assertMainWindow(event: Electron.IpcMainInvokeEvent): void {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win !== mainWindow) {
    throw new Error("This operation is restricted to the main window")
  }
}

async function patchPluginConfig(dir: string, target: PluginInstallTarget, spec: string) {
  const file = await pluginConfigFile(dir, target.kind)
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "{}"
    throw error
  })
  const source = text.trim() || "{}"
  const errors: ParseError[] = []
  const config = parseJsonc(source, errors, { allowTrailingComma: true }) as { plugin?: unknown[] }
  if (errors.length) {
    const error = errors[0]
    throw new Error(`Invalid JSON in ${file}: ${printParseErrorCode(error.error)}`)
  }
  const plugins = Array.isArray(config.plugin) ? config.plugin : []
  const entry = target.opts && Object.keys(target.opts).length ? [spec, target.opts] : spec
  const next = upsertPluginEntry(plugins, spec, entry)

  await writeFile(
    file,
    applyEdits(
      source,
      modify(source, ["plugin"], next.plugins, {
        formattingOptions: {
          insertSpaces: true,
          tabSize: 2,
        },
      }),
    ),
  )
  return {
    kind: target.kind,
    mode: next.mode,
    file,
  }
}

async function pluginConfigFile(dir: string, kind: "server" | "tui") {
  const name = kind === "server" ? "opencode" : "tui"
  const json = join(dir, `${name}.json`)
  const jsonc = join(dir, `${name}.jsonc`)
  const existingJsonc = await readFile(jsonc, "utf8").then(
    () => true,
    () => false,
  )
  if (existingJsonc) return jsonc
  return json
}

function upsertPluginEntry(plugins: unknown[], spec: string, entry: unknown) {
  const pkg = parseNpmSpecifier(spec).name
  const index = plugins.findIndex((item) => {
    const current = pluginEntrySpec(item)
    if (!current || current.startsWith("file:")) return false
    return parseNpmSpecifier(current).name === pkg
  })
  if (index < 0) return { mode: "add" as const, plugins: [...plugins, entry] }

  const next = [...plugins]
  next[index] = entry
  return { mode: "replace" as const, plugins: next }
}

function pluginEntrySpec(value: unknown) {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return
  if (typeof value[0] !== "string") return
  return value[0]
}

async function writeSkillFiles(rawRoot: string, rawFiles: unknown) {
  const root = resolve(rawRoot)
  const allowedRoot = resolve(app.getPath("userData"), "skills")
  if (!containsPath(allowedRoot, root)) throw new Error("Skill path must stay inside the OpenCodex skills directory")
  if (!Array.isArray(rawFiles)) throw new Error("Skill files are required")

  const files = rawFiles.flatMap((item): SkillFileInput[] => {
    if (!isRecord(item) || typeof item.path !== "string" || typeof item.content !== "string") return []
    return [{ path: item.path, content: item.content }]
  })
  if (!files.length) throw new Error("Skill files are required")

  await mkdir(root, { recursive: true })
  for (const file of files) {
    const normalized = normalizeSkillRelativePath(file.path)
    const destination = resolve(root, normalized)
    if (!containsPath(root, destination)) throw new Error("Skill file path is outside the skill directory")
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, file.content)
  }

  await ensureSkillRootConfig()
  return { ok: true as const, root, count: files.length }
}

async function writeProjectFile(rawDirectory: string, rawPath: string, content: string) {
  if (!rawDirectory || !rawPath) throw new Error("Directory and file path are required")
  const directory = resolve(rawDirectory)
  const relativePath = rawPath.replace(/\\/g, "/")
  if (!relativePath || relativePath.startsWith("/") || /^[a-zA-Z]:/.test(relativePath)) {
    throw new Error("File path must be relative to the project directory")
  }
  const destination = resolve(directory, relativePath)
  if (!containsPath(directory, destination)) throw new Error("File path is outside the project directory")
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, content, "utf8")
  return { ok: true as const }
}

type RemoveAgentTarget = {
  scope: "global" | "project"
  directory?: string
  name: string
}

async function removeAgentConfig(target: RemoveAgentTarget): Promise<{ changed: boolean; file: string }> {
  const file = await findAgentConfigFile(target)
  if (!file) return { changed: false, file: "" }
  const source = await readFile(file, "utf8")
  const errors: ParseError[] = []
  const parsed = parseJsonc(source, errors, { allowTrailingComma: true })
  if (errors.length) throw new Error(`Invalid JSON in ${file}: ${printParseErrorCode(errors[0]?.error ?? 1)}`)
  if (!isRecord(parsed) || !isRecord(parsed.agent) || !(target.name in parsed.agent)) {
    return { changed: false, file }
  }
  await writeFile(
    file,
    applyEdits(
      source,
      modify(source, ["agent", target.name], undefined, {
        formattingOptions: {
          insertSpaces: true,
          tabSize: 2,
        },
      }),
    ),
    "utf8",
  )
  writeLog("main", "removed agent from config", { file, name: target.name })
  return { changed: true, file }
}

async function findAgentConfigFile(target: RemoveAgentTarget): Promise<string | undefined> {
  const candidates = []
  if (target.scope === "global") {
    const dir = join(app.getPath("userData"), "config", "opencode")
    candidates.push(...["opencode.jsonc", "opencode.json", "config.json"].map((file) => join(dir, file)))
  } else {
    let current = resolve(target.directory ?? "")
    while (current && current.length > 1) {
      candidates.push(
        join(current, "opencode.jsonc"),
        join(current, "opencode.json"),
        join(current, ".opencode", "opencode.jsonc"),
        join(current, ".opencode", "opencode.json"),
      )
      const parent = dirname(current)
      if (parent === current || current === homedir()) break
      current = parent
    }
  }
  for (const file of candidates) {
    if (await hasAgentKey(file, target.name)) return file
  }
  return undefined
}

async function hasAgentKey(file: string, name: string): Promise<boolean> {
  const source = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return ""
    throw error
  })
  if (!source) return false
  const errors: ParseError[] = []
  const parsed = parseJsonc(source, errors, { allowTrailingComma: true })
  if (errors.length) return false
  return isRecord(parsed) && isRecord(parsed.agent) && name in parsed.agent
}

async function ensureSkillRootConfig() {
  const root = resolve(app.getPath("userData"), "skills")
  const configDir = pluginConfigDir()
  await mkdir(configDir, { recursive: true })
  const file = await pluginConfigFile(configDir, "server")
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "{}"
    throw error
  })
  const source = text.trim() || "{}"
  const errors: ParseError[] = []
  const config = parseJsonc(source, errors, { allowTrailingComma: true }) as { skills?: { paths?: unknown } }
  if (errors.length) {
    const error = errors[0]
    throw new Error(`Invalid JSON in ${file}: ${printParseErrorCode(error.error)}`)
  }

  const paths = Array.isArray(config.skills?.paths) ? config.skills.paths.filter(isString) : []
  if (paths.includes("~/.opencodex/skills")) return { changed: false as const, file, root }
  await writeFile(
    file,
    applyEdits(
      source,
      modify(source, ["skills", "paths"], [...paths, "~/.opencodex/skills"], {
        formattingOptions: {
          insertSpaces: true,
          tabSize: 2,
        },
      }),
    ),
  )
  return { changed: true as const, file, root }
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function configureAppPermissionHandlers() {
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details) => {
    if (!webContents || webContents.id !== mainWindow?.webContents.id) return false
    if (permission === "notifications") return true
    return permission === "media" && details.mediaType === "audio"
  })
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (webContents.id !== mainWindow?.webContents.id) {
      callback(false)
      return
    }
    if (permission === "notifications") {
      writeLog("main", "notification permission requested")
      callback(true)
      return
    }
    const mediaTypes = permission === "media" && "mediaTypes" in details ? details.mediaTypes : undefined
    const microphone = mediaTypes?.includes("audio") && !mediaTypes.includes("video")
    writeLog("main", "media permission requested", { permission, mediaTypes, granted: Boolean(microphone) })
    callback(Boolean(microphone))
  })
}

async function deleteSkill(rawLocation: string) {
  const location = resolve(rawLocation)
  const allowedRoot = resolve(app.getPath("userData"), "skills")
  if (!containsPath(allowedRoot, location)) throw new Error("Only user skills can be deleted")
  if (location === allowedRoot) throw new Error("Select a skill to delete")

  const root = location.replace(/\\/g, "/").toLowerCase().endsWith("/skill.md") ? dirname(location) : location
  if (!containsPath(allowedRoot, root) || root === allowedRoot) throw new Error("Only user skills can be deleted")
  await rm(root, { recursive: true, force: true })
  return { ok: true as const, root }
}

async function createHostedPullRequest(rawInput: unknown) {
  if (!isRecord(rawInput)) throw new Error("Pull request input is required")
  const remoteUrl = typeof rawInput.remoteUrl === "string" ? normalizeGitRemoteUrl(rawInput.remoteUrl) : undefined
  const sourceBranch = typeof rawInput.sourceBranch === "string" ? rawInput.sourceBranch.trim() : ""
  const targetBranch = typeof rawInput.targetBranch === "string" ? rawInput.targetBranch.trim() : ""
  const title = typeof rawInput.title === "string" ? rawInput.title.trim() : ""
  const body = typeof rawInput.body === "string" ? rawInput.body : ""
  const draft = rawInput.draft === true
  if (!remoteUrl || remoteUrl.protocol !== "https:") throw new Error("A valid HTTPS Git remote is required")
  const validRef = (value: string) =>
    value.length > 0 && value.length <= 255 && !value.startsWith("-") && !/[\0\r\n]/.test(value)
  if (
    !validRef(sourceBranch) ||
    !validRef(targetBranch) ||
    sourceBranch === targetBranch ||
    !title ||
    title.length > 500 ||
    body.length > 100_000
  ) {
    throw new Error("Valid source branch, target branch, title, and description are required")
  }

  const provider =
    remoteUrl.hostname === "bitbucket.org"
      ? ("bitbucket" as const)
      : remoteUrl.hostname === "gitlab.com"
        ? ("gitlab" as const)
        : remoteUrl.hostname === "github.com"
          ? ("github" as const)
          : undefined
  if (!provider) throw new Error("Only GitHub, GitLab, and Bitbucket repositories are supported")
  const repository = remoteUrl.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "")
  const repositoryParts = repository.split("/").filter(Boolean)
  if (repositoryParts.length < 2 || (provider !== "gitlab" && repositoryParts.length !== 2))
    throw new Error("The Git remote must identify one repository")
  const [owner, name] = repositoryParts
  const credential = await getServerCredential(`hosting.${provider}`)
  if (!credential?.password)
    throw new Error(`Configure a ${provider} access token in Settings before creating a pull request`)

  const request =
    provider === "github"
      ? {
          url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls`,
          headers: { Authorization: `Bearer ${credential.password}`, Accept: "application/vnd.github+json" },
          body: { title, head: sourceBranch, base: targetBranch, body, draft },
        }
      : provider === "gitlab"
        ? {
            url: `https://${remoteUrl.hostname}/api/v4/projects/${encodeURIComponent(repository)}/merge_requests`,
            headers: { "PRIVATE-TOKEN": credential.password },
            body: {
              title: draft ? `Draft: ${title}` : title,
              source_branch: sourceBranch,
              target_branch: targetBranch,
              description: body,
            },
          }
        : {
            url: `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pullrequests`,
            headers: {
              Authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`,
            },
            body: {
              title,
              description: body,
              source: { branch: { name: sourceBranch } },
              destination: { branch: { name: targetBranch } },
            },
          }
  const requestHeaders = new Headers({ "Content-Type": "application/json", "User-Agent": "OpenCodex" })
  Object.entries(request.headers).forEach(([key, value]) => {
    if (value) requestHeaders.set(key, value)
  })
  const response = await fetch(request.url, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await response.text()
  if (!response.ok)
    throw new Error(
      text ? `${provider} HTTP ${response.status}: ${text.slice(0, 2_000)}` : `${provider} HTTP ${response.status}`,
    )
  const result = JSON.parse(text) as unknown
  if (!isRecord(result)) throw new Error(`${provider} returned an invalid response`)
  const url =
    typeof result.html_url === "string"
      ? result.html_url
      : isRecord(result.links) && isRecord(result.links.html) && typeof result.links.html.href === "string"
        ? result.links.html.href
        : typeof result.web_url === "string"
          ? result.web_url
          : undefined
  if (!url) throw new Error(`${provider} did not return the pull request URL`)
  return { url, provider }
}

function normalizeGitRemoteUrl(value: string) {
  const remote = value.trim()
  const scp = remote.includes("://") ? undefined : remote.match(/^(?:[^@\s]+@)?([^/:\s]+):(.+)$/)
  if (scp) return new URL(`https://${scp[1]}/${scp[2]}`)
  const url = new URL(remote)
  if (url.protocol === "http:" || url.protocol === "https:") return url
  if (url.protocol === "ssh:" && url.hostname) return new URL(`https://${url.hostname}${url.pathname}`)
  throw new Error("A valid HTTPS or SSH Git remote is required")
}

async function openInternalUrl(rawUrl: string) {
  const url = await assertBrowserTarget(rawUrl)

  if (!internalBrowserWindow || internalBrowserWindow.isDestroyed()) {
    internalBrowserWindow = new BrowserWindow({
      title: url.hostname,
      width: 1040,
      height: 760,
      minWidth: 640,
      minHeight: 480,
      parent: mainWindow,
      icon: iconPath(process.platform === "darwin" ? "icon.icns" : "icon.ico"),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        safeDialogs: true,
        webSecurity: true,
        partition: internalBrowserPartition,
      },
    })
    configureInternalBrowserNetworkPolicy(internalBrowserWindow.webContents.session)
    internalBrowserWindow.webContents.session.setPermissionCheckHandler(() => false)
    internalBrowserWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    )
    internalBrowserWindow.on("closed", () => {
      internalBrowserWindow = undefined
    })
    internalBrowserWindow.webContents.setWindowOpenHandler(({ url: target }) => {
      void openInternalUrl(target).catch((error) => writeLog("browser", "blocked internal popup", { target, error }))
      return { action: "deny" }
    })
    internalBrowserWindow.webContents.on("will-navigate", (event, target) => {
      try {
        const next = new URL(target)
        if (next.protocol === "http:" || next.protocol === "https:") return
      } catch {
        // Block malformed navigation targets.
      }
      event.preventDefault()
      writeLog("browser", "blocked internal navigation", { target })
    })
  }

  internalBrowserWindow.setTitle(url.hostname)
  await internalBrowserWindow.loadURL(url.toString())
  internalBrowserWindow.show()
  internalBrowserWindow.focus()
  return true
}

function configureInternalBrowserNetworkPolicy(browserSession: Electron.Session) {
  if (internalBrowserNetworkPolicyConfigured) return
  internalBrowserNetworkPolicyConfigured = true
  const localPreviewContents = new Set<number>()
  browserSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
    const webContentsId = details.webContentsId ?? -1
    const isMainFrame = details.resourceType === "mainFrame"
    const allowLocalPreview = isMainFrame || (webContentsId > 0 && localPreviewContents.has(webContentsId))
    void assertBrowserTarget(details.url, allowLocalPreview).then(
      () => {
        if (isMainFrame) {
          const host = new URL(details.url).hostname
          if (webContentsId > 0 && isLocalPreviewHost(host)) {
            localPreviewContents.add(webContentsId)
            while (localPreviewContents.size > 32) {
              const oldest = localPreviewContents.values().next().value
              if (oldest === undefined) break
              localPreviewContents.delete(oldest)
            }
          } else {
            localPreviewContents.delete(webContentsId)
          }
        }
        callback({})
      },
      (error) => {
        writeLog("security", "blocked internal browser request", { url: details.url, error })
        callback({ cancel: true })
      },
    )
  })
}

async function discoverPreviewPorts(rawHost: string) {
  const host = rawHost.trim().replace(/^\[|\]$/g, "")
  if (!host || !/^[a-zA-Z0-9.:-]+$/.test(host)) throw new Error("Invalid preview host")
  if (host.toLowerCase() !== "localhost" && host !== "::1" && !host.startsWith("127.")) {
    throw new Error("Automatic port discovery is limited to the local machine")
  }
  const hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
  const ports = [3000, 3001, 4000, 4173, 5000, 5173, 5174, 8000, 8080]
  const checks = ports.map(async (port) => {
    const url = `http://${hostname}:${port}/`
    const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(900) }).catch(() => undefined)
    return response ? url : undefined
  })
  return (await Promise.all(checks)).filter((url): url is string => !!url)
}

async function capturePreview(rawRect: unknown) {
  if (!mainWindow || mainWindow.isDestroyed() || !isRecord(rawRect)) return { saved: false as const }
  const bounds = mainWindow.getContentBounds()
  const values = [rawRect.x, rawRect.y, rawRect.width, rawRect.height]
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value)))
    throw new Error("Invalid capture rectangle")
  const rect = {
    x: Math.max(0, Math.floor(Number(rawRect.x))),
    y: Math.max(0, Math.floor(Number(rawRect.y))),
    width: Math.max(1, Math.min(bounds.width, Math.floor(Number(rawRect.width)))),
    height: Math.max(1, Math.min(bounds.height, Math.floor(Number(rawRect.height)))),
  }
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Save preview screenshot",
    defaultPath: `opencodex-preview-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
    filters: [{ name: "PNG image", extensions: ["png"] }],
  })
  if (result.canceled || !result.filePath) return { saved: false as const }
  const image = await mainWindow.webContents.capturePage(rect)
  await writeFile(result.filePath, image.toPNG())
  return { saved: true as const, file: result.filePath }
}

type LocationApp = { id: string; name: string; icon?: string; exe?: string; appPath?: string }

function sortLocationApps(apps: LocationApp[]) {
  const priority = ["vscode", "intellij", "cursor", "terminal", "default"]
  return apps.sort((left, right) => {
    const leftIndex = left.id === "default" ? priority.length + 1 : priority.indexOf(left.id)
    const rightIndex = right.id === "default" ? priority.length + 1 : priority.indexOf(right.id)
    return (leftIndex < 0 ? priority.length : leftIndex) - (rightIndex < 0 ? priority.length : rightIndex)
  })
}

async function locationApps(): Promise<LocationApp[]> {
  if (process.platform === "darwin") {
    return locationAppsMac()
  }
  if (process.platform === "win32") {
    return locationAppsWin()
  }
  return [{ id: "default", name: "默认应用" }]
}

async function locationAppsMac(): Promise<LocationApp[]> {
  const candidates = [
    {
      id: "vscode",
      name: "VS Code",
      paths: [
        join("/Applications", "Visual Studio Code.app"),
        join(homedir(), "Applications", "Visual Studio Code.app"),
      ],
    },
    {
      id: "intellij",
      name: "IntelliJ IDEA",
      paths: [
        join("/Applications", "IntelliJ IDEA.app"),
        join("/Applications", "IntelliJ IDEA CE.app"),
        join(homedir(), "Applications", "IntelliJ IDEA.app"),
        join(homedir(), "Applications", "IntelliJ IDEA CE.app"),
      ],
    },
    {
      id: "cursor",
      name: "Cursor",
      paths: [join("/Applications", "Cursor.app"), join(homedir(), "Applications", "Cursor.app")],
    },
    {
      id: "terminal",
      name: "Terminal",
      paths: ["/System/Applications/Utilities/Terminal.app", "/Applications/Utilities/Terminal.app"],
    },
    { id: "default", name: "Finder", paths: ["/System/Library/CoreServices/Finder.app"] },
  ]
  const installed = await Promise.all(
    candidates.map(async ({ id, name, paths }) => {
      try {
        const location = await Promise.any(
          paths.map(async (candidate) => {
            await access(candidate)
            return candidate
          }),
        )
        const icon = (await app.getFileIcon(location, { size: "small" })).toDataURL()
        return { id, name, icon, appPath: location }
      } catch {
        return undefined
      }
    }),
  )
  return sortLocationApps(installed.flatMap((item) => (item ? [item] : [])))
}

async function locationAppsWin(): Promise<LocationApp[]> {
  const { execSync } = await import("node:child_process")
  const { readdir } = await import("node:fs/promises")

  const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")

  // Known editors: match by DisplayName in registry
  const knownApps: Array<{ id: string; name: string; patterns: RegExp[]; exeName: string }> = [
    { id: "vscode", name: "VS Code", patterns: [/Visual Studio Code/i], exeName: "Code.exe" },
    { id: "cursor", name: "Cursor", patterns: [/^Cursor$/i, /Cursor Editor/i], exeName: "Cursor.exe" },
    { id: "intellij", name: "IntelliJ IDEA", patterns: [/IntelliJ IDEA/i], exeName: "idea64.exe" },
    { id: "webstorm", name: "WebStorm", patterns: [/^WebStorm$/i], exeName: "ws64.exe" },
  ]

  const found = new Map<string, { name: string; exe: string }>()

  // Single recursive query per registry root — much faster than per-subkey queries
  const regRoots = [
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ]

  for (const root of regRoots) {
    try {
      const output = execSync(`reg query "${root}" /s 2>nul`, {
        encoding: "utf-8",
        timeout: 8000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      })

      let currentDisplayName = ""
      let currentInstallLocation = ""

      const flush = () => {
        if (currentDisplayName && currentInstallLocation) {
          for (const app of knownApps) {
            if (!found.has(app.id) && app.patterns.some((p) => p.test(currentDisplayName))) {
              const exePath = join(currentInstallLocation, app.exeName)
              found.set(app.id, { name: app.name, exe: exePath })
            }
          }
        }
        currentDisplayName = ""
        currentInstallLocation = ""
      }

      for (const line of output.split("\n")) {
        // New subkey header resets current state
        if (line.match(/^HK/)) {
          flush()
          continue
        }

        const nameMatch = line.match(/DisplayName\s+REG_SZ\s+(.+)/i)
        if (nameMatch) {
          currentDisplayName = nameMatch[1].trim()
          continue
        }

        const locMatch = line.match(/InstallLocation\s+REG_SZ\s+(.+)/i)
        if (locMatch) {
          currentInstallLocation = locMatch[1].trim().replace(/\\+$/, "")
        }
      }
      flush()
    } catch {
      // registry root not available
    }
  }

  // JetBrains Toolbox fallback
  try {
    const toolboxBase = join(localAppData, "JetBrains", "Toolbox", "apps")
    const toolboxApps = [
      { id: "intellij", name: "IntelliJ IDEA", pattern: /IDEA/i, exe: "idea64.exe" },
      { id: "webstorm", name: "WebStorm", pattern: /WebStorm/i, exe: "ws64.exe" },
    ]
    const categories = await readdir(toolboxBase)
    for (const category of categories) {
      try {
        const apps = await readdir(join(toolboxBase, category))
        for (const appDir of apps) {
          for (const tb of toolboxApps) {
            if (!found.has(tb.id) && tb.pattern.test(appDir)) {
              const exePath = join(toolboxBase, category, appDir, "current", "bin", tb.exe)
              try {
                await access(exePath)
                found.set(tb.id, { name: tb.name, exe: exePath })
              } catch {}
            }
          }
        }
      } catch {}
    }
  } catch {}

  // Build result
  const result: LocationApp[] = []
  for (const [id, { name, exe }] of found) {
    try {
      await access(exe)
      const icon = (await app.getFileIcon(exe, { size: "small" })).toDataURL()
      result.push({ id, name, icon, exe })
    } catch {}
  }

  result.push({ id: "default", name: "文件管理器" })
  writeLog("main", "locationAppsWin: result", { count: result.length, ids: result.map((r) => r.id) })
  return sortLocationApps(result)
}

async function openLocation(input: unknown) {
  if (!input || typeof input !== "object") throw new Error("Invalid location request")
  const value = input as { path?: unknown; appId?: unknown }
  if (typeof value.path !== "string" || !value.path) throw new Error("A location is required")
  const location = value.path
  const appId = typeof value.appId === "string" ? value.appId : "default"
  if (appId === "default") {
    await shell.openPath(location)
    return true
  }

  if (process.platform === "win32") {
    // Windows: use the exe path directly
    const apps = await locationAppsWin()
    const app = apps.find((item) => item.id === appId)
    if (!app?.exe) throw new Error("Selected application is not installed")
    const executable = app.exe
    await new Promise<void>((resolveOpen, rejectOpen) => {
      const child = spawnProcess(executable, [location], { detached: true, stdio: "ignore" })
      child.unref()
      child.once("error", rejectOpen)
      child.once("exit", (code) => (code === 0 ? resolveOpen() : rejectOpen(new Error("Failed to open location"))))
    })
    return true
  }

  // macOS
  const apps = await locationAppsMac()
  const app = apps.find((item) => item.id === appId)
  if (!app?.appPath) throw new Error("Selected application is not installed")
  const application = app.appPath
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const child = spawnProcess("open", [application, location])
    child.once("error", rejectOpen)
    child.once("exit", (code) => (code === 0 ? resolveOpen() : rejectOpen(new Error("Failed to open location"))))
  })
  return true
}

async function waitConsoleLogin(rawLogin: unknown): Promise<ConsoleLoginResult> {
  const current = server?.state
  if (!current) throw new Error("OpenCodex server is not ready")

  const login = normalizeConsoleLogin(rawLogin)
  const key = `${login.server}:${login.code}`
  const existing = consoleLoginWaits.get(key)
  if (existing) return existing

  const waiting = performConsoleLoginWait(current, login).finally(() => {
    consoleLoginWaits.delete(key)
  })
  consoleLoginWaits.set(key, waiting)
  return waiting
}

async function performConsoleLoginWait(
  current: SidecarHandle["state"],
  login: ReturnType<typeof normalizeConsoleLogin>,
) {
  writeLog("main", "console login wait started", {
    server: login.server,
    intervalMs: login.intervalMs,
    expiresInMs: login.expiresInMs,
  })

  const response = await fetch(new URL("/experimental/console/login/wait", current.url), {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Basic ${Buffer.from(`${current.username}:${current.password}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(login),
  })
  const text = await response.text()
  if (!response.ok) {
    writeLog("main", "console login wait failed", { status: response.status, body: text })
    throw new Error(text ? `HTTP ${response.status}: ${text}` : `HTTP ${response.status}`)
  }

  const result = parseConsoleLoginResult(text)
  writeLog("main", "console login wait result", result)
  return result
}

async function notificationPermission() {
  const supported = Notification.isSupported()
  writeLog("main", "notification permission checked", { supported })
  if (!supported) return "denied" as const
  return "granted" as const
}

async function microphonePermission() {
  const owner = mainWindow
  if (!owner) return "unknown" as const
  const current = systemPreferences.getMediaAccessStatus("microphone")
  writeLog("main", "microphone permission checked", { status: current })
  if (process.platform !== "darwin" || current === "granted" || current === "restricted") return current
  const chinese = app.getLocale().toLowerCase().startsWith("zh")
  if (current === "denied") {
    const result = await dialog.showMessageBox(owner, {
      type: "warning",
      title: chinese ? "需要麦克风权限" : "Microphone Access Required",
      message: chinese ? "OpenCodex 的麦克风权限已关闭" : "Microphone access for OpenCodex is turned off",
      detail: chinese
        ? "请在“系统设置 → 隐私与安全性 → 麦克风”中允许 OpenCodex。修改后需要重启应用。"
        : "Allow OpenCodex under System Settings → Privacy & Security → Microphone, then restart the app.",
      buttons: chinese ? ["打开系统设置", "取消"] : ["Open System Settings", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    })
    if (result.response !== 0) return "cancelled" as const
    await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
    return "settings-opened" as const
  }
  const result = await dialog.showMessageBox(owner, {
    type: "info",
    title: chinese ? "允许语音输入" : "Enable Voice Input",
    message: chinese ? "OpenCodex 需要使用麦克风" : "OpenCodex needs microphone access",
    detail: chinese
      ? "麦克风仅用于将语音转换成输入框文字，不会自动发送。继续后 macOS 会显示系统授权窗口。"
      : "The microphone is only used to convert speech into text in the composer and will not send anything automatically. macOS will ask for permission next.",
    buttons: chinese ? ["继续", "取消"] : ["Continue", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  })
  if (result.response !== 0) return "cancelled" as const
  const granted = await systemPreferences.askForMediaAccess("microphone")
  const status = granted ? ("granted" as const) : ("denied" as const)
  writeLog("main", "microphone permission requested", { status })
  return status
}

async function sendNativeNotification(input: unknown) {
  if (!Notification.isSupported()) {
    writeLog("main", "native notification unsupported")
    return { ok: false as const, permission: "denied" as const }
  }
  const notificationInput = normalizeNativeNotification(input)
  writeLog("main", "showing native notification", {
    title: notificationInput.title,
    hasBody: Boolean(notificationInput.body),
    hasSessionId: Boolean(notificationInput.sessionId),
  })
  const notification = new Notification({
    title: notificationInput.title,
    body: notificationInput.body,
  })
  activeNotifications.add(notification)
  notification.once("show", () => writeLog("main", "native notification shown"))
  notification.once("failed", (_event, error) => {
    writeLog("main", "native notification failed", { error })
  })
  notification.once("close", () => {
    activeNotifications.delete(notification)
    writeLog("main", "native notification closed")
  })
  notification.on("click", () => {
    showWindow()
    if (!notificationInput.sessionId) return
    mainWindow?.webContents.send("notification:clicked", {
      sessionId: notificationInput.sessionId,
      directory: notificationInput.directory,
    })
  })
  const resultPromise = new Promise<{ ok: true } | { ok: false; error: string }>((resolveResult) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      resolveResult({ ok: true })
    }, 1_500)
    notification.once("show", () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolveResult({ ok: true })
    })
    notification.once("failed", (_event, error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolveResult({ ok: false, error })
    })
  })
  notification.show()
  const result = await resultPromise
  return { ...result, permission: await notificationPermission() }
}

function normalizeNativeNotification(
  input: unknown,
): Required<Pick<NativeNotificationInput, "title" | "body">> &
  Pick<NativeNotificationInput, "sessionId" | "directory"> {
  if (!isRecord(input)) return { title: "OpenCodex", body: "" }
  return {
    title: typeof input.title === "string" && input.title.trim() ? input.title : "OpenCodex",
    body: typeof input.body === "string" ? input.body : "",
    sessionId: typeof input.sessionId === "string" ? input.sessionId : undefined,
    directory: typeof input.directory === "string" ? input.directory : undefined,
  }
}

function normalizeSkillRelativePath(value: string) {
  const file = value.replace(/\\/g, "/").replace(/^\/+/, "")
  if (!file || file.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Skill file path is invalid")
  }
  return file
}

function userDataRoot() {
  const override = process.env.NODE_ENV === "test" ? process.env.OPENCODE_E2E_USER_DATA_DIR : undefined
  if (override) return resolve(override)
  return join(homedir(), ".opencodex")
}

function e2eServerUrl() {
  const value = process.env.NODE_ENV === "test" ? process.env.OPENCODE_E2E_SERVER_URL : undefined
  if (!value) return
  const url = new URL(value)
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) {
    throw new Error("OPENCODE_E2E_SERVER_URL must use a loopback HTTP URL")
  }
  return url.origin
}

function normalizeConsoleLogin(rawLogin: unknown) {
  if (!rawLogin || typeof rawLogin !== "object") throw new Error("Invalid console login payload")
  const login = rawLogin as ConsoleLoginStart
  if (!login.code || !login.user || !login.url || !login.server) throw new Error("Invalid console login payload")
  return {
    code: login.code,
    user: login.user,
    url: login.url,
    server: login.server,
    expiresInMs: Math.max(0, Number(login.expiresInMs ?? 0)),
    intervalMs: Math.max(0, Number(login.intervalMs ?? 0)),
  }
}

function parseConsoleLoginResult(text: string): ConsoleLoginResult {
  const result = JSON.parse(text) as ConsoleLoginResult
  if (
    result.status !== "success" &&
    result.status !== "pending" &&
    result.status !== "slow" &&
    result.status !== "expired" &&
    result.status !== "denied" &&
    result.status !== "error"
  ) {
    throw new Error("Invalid console login result")
  }
  return result
}

function containsPath(parent: string, child: string) {
  const next = relative(parent, child)
  return next === "" || (!next.startsWith("..") && !next.startsWith("/") && !/^[A-Za-z]:/.test(next))
}
