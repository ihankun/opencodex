import { contextBridge, ipcRenderer } from "electron"
import type { ImBridgeConfig, ImBridgeState } from "../shared/imBridge"
import type { DesktopPreferences } from "../shared/desktopPreferences"
import type {
  OpenCodeGoQuotaConfig,
  OpenCodeGoQuotaConfigUpdate,
  QuotaProviderResult,
  QuotaQueryInput,
} from "../shared/quota"
import type {
  SpeechModelConfig,
  SpeechModelDiscoveryInput,
  SpeechModelOption,
  SpeechModelUpdate,
  SpeechTranscriptionInput,
} from "../shared/speechModel"
import type { ProjectDirectory, ProjectState } from "../shared/projects"
import type { CachedSessionList } from "../shared/sessionListCache"
import type { CustomOpenCodeDeepLink } from "../shared/deepLinks"
import type { UpdaterState } from "../shared/updater"
import type { Session } from "@opencode-ai/sdk/v2/client"

export type { ImBridgeConfig, ImBridgeState } from "../shared/imBridge"
export type { CustomOpenCodeDeepLink } from "../shared/deepLinks"

export type CustomOpenCodeServerState = {
    status: "online"
    server: {
      url: string
      username: string
      password: string
    }
  } | {
    status: "starting"
    error?: string
  }

export type CustomOpenCodePluginSearchResult = {
  name: string
  version: string
  description: string
  keywords: string[]
  publisher: string
  date: string
  source: string
  downloads: number
  url: string
  compatibility: "supported" | "unsupported" | "unknown"
  trustedPublisher: boolean
  signatureStatus: "signed" | "integrity" | "unverified"
}

export type CustomOpenCodePluginMetadata = {
  spec: string
  packageName: string
  configuredVersion: string
  latestVersion: string
  source: 'npm' | 'local'
  url: string
  updateAvailable: boolean
  trustedPublisher: boolean
  signatureStatus: 'signed' | 'integrity' | 'unverified'
  integrity: string
  permissions: string[]
  updateChanges: string[]
}

export type CustomOpenCodeMcpSearchResult = {
  provider: "official" | "netease"
  name: string
  version: string
  description: string
  source: string
  sourceUrl: string
  downloads: number
  publishedAt: string
  requiredEnvironment: string[]
  category: string
  tags: string[]
  config: { type: "local"; command: string[] } | { type: "remote"; url: string }
}

export type CustomOpenCodeMcpSearchPage = {
  data: CustomOpenCodeMcpSearchResult[]
  nextCursor: string | null
  categories: Array<{ id: string; nameZh: string; nameEn: string }>
}

export type CustomOpenCodeMcpSource = {
  kind: "marketplace" | "plugin" | "config" | "runtime"
  detail: string
  provider?: "official" | "netease"
}

export type CustomOpenCodeExpertKit = {
  id: string
  name: string
  description: string
  icon: string
  author: string
  version: string
  downloadCount: number
  tryAsking: string[]
  skills: Array<{ id: string; name: string; description: string }>
  installed: boolean
  updateAvailable: boolean
}

export type CustomOpenCodeExpertKitSkillSource = {
  id: string
  name: string
  skills: string[]
}

export type CustomOpenCodePluginInstallResult = {
  ok: true
  spec: string
  packageName: string
  version: string
  configDir: string
  cacheDir: string
  items: Array<{
    kind: "server" | "tui"
    mode: "add" | "replace"
    file: string
  }>
}

export type CustomOpenCodeSkillWriteResult = {
  ok: true
  root: string
  count: number
}

export type CustomOpenCodeSkillEnsureRootResult = {
  changed: boolean
  file: string
  root: string
}

export type CustomOpenCodeSkillDeleteResult = {
  ok: true
  root: string
}

export type CustomOpenCodeNotificationPermission = "default" | "granted" | "denied"
export type CustomOpenCodeMicrophonePermission = "not-determined" | "granted" | "denied" | "restricted" | "unknown" | "cancelled" | "settings-opened"

export type CustomOpenCodeNotificationSendResult = {
  ok: boolean
  permission: CustomOpenCodeNotificationPermission
  error?: string
}

export type CustomOpenCodeConsoleLoginStart = {
  code: string
  user: string
  url: string
  server: string
  expiresInMs: number
  intervalMs: number
}

export type CustomOpenCodeConsoleLoginResult = {
  status: "success" | "pending" | "slow" | "expired" | "denied" | "error"
  email?: string
  message?: string
}

export type CustomOpenCodeLocationApp = { id: string; name: string; icon?: string }

export type CustomOpenCodeServerCredential = { username: string; password: string }
export type CustomOpenCodeHostingProvider = "github" | "gitlab" | "bitbucket"

export type CustomOpenCodeScheduledTask = {
  id: string
  title: string
  prompt: string
  cron: string
  timezone: string
  serverId: string
  serverName: string
  serverUrl: string
  directory: string
  executionMode: "current" | "worktree"
  worktreeCleanup: "always" | "on-success" | "never"
  branch: string
  permissionProfile: "ask" | "writes" | "risk" | "full"
  retryCount: number
  retryDelaySeconds: number
  completionTimeoutMinutes: number
  overlapPolicy: "skip" | "queue" | "parallel"
  maxConcurrentRuns: number
  missedRunPolicy: "skip" | "run-once"
  catchUpWindowMinutes: number
  triggerType: "schedule" | "task-success" | "task-failure" | "webhook"
  triggerTaskId: string
  dependencyTaskIds: string[]
  notificationChannels: Array<"desktop" | "webhook">
  notificationWebhookUrl: string
  webhookUrl: string
  modelProviderID: string
  modelID: string
  variant: string
  enabled: boolean
  status: "enabled" | "paused" | "running" | "error"
  lastRunAt: number | null
  nextRunAt: number | null
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export type CustomOpenCodeScheduledTaskInput = Pick<CustomOpenCodeScheduledTask, "title" | "prompt" | "cron" | "timezone" | "serverId" | "serverName" | "serverUrl" | "directory" | "executionMode" | "worktreeCleanup" | "branch" | "permissionProfile" | "retryCount" | "retryDelaySeconds" | "completionTimeoutMinutes" | "overlapPolicy" | "maxConcurrentRuns" | "missedRunPolicy" | "catchUpWindowMinutes" | "triggerType" | "triggerTaskId" | "dependencyTaskIds" | "notificationChannels" | "notificationWebhookUrl" | "modelProviderID" | "modelID" | "variant" | "enabled">

export type CustomOpenCodeScheduledTaskRun = {
  id: string
  taskID: string
  taskTitle: string
  prompt: string
  sessionID: string
  serverId: string
  serverName: string
  serverUrl: string
  directory: string
  executionDirectory: string
  executionMode: "current" | "worktree"
  worktreeDirectory: string
  branch: string
  permissionProfile: "ask" | "writes" | "risk" | "full"
  attempt: number
  modelProviderID: string
  modelID: string
  variant: string
  status: "queued" | "running" | "submitted" | "recovering" | "completed" | "failed" | "timed_out" | "cancelled" | "blocked"
  error: string | null
  log: string
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export type CustomOpenCodeScheduledTaskRunSummary = Omit<CustomOpenCodeScheduledTaskRun, "log"> & {
  logPreview: string
}

export type CustomOpenCodeScheduledTaskRunPage = {
  data: CustomOpenCodeScheduledTaskRunSummary[]
  total: number
  hasMore: boolean
}

export type CustomOpenCodeScheduledTaskSettings = { maxConcurrency: number; historyRetentionDays: number; maxHistory: number; webhookPort: number }

export type CustomOpenCodeSecurityConfig = {
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

export type CustomOpenCodeWindowsSandboxStatus = {
  supported: boolean
  available: boolean
  installed: boolean
  cancelled?: boolean
  error?: string
}

export type CustomOpenCodeDiagnostics = {
  generatedAt: string
  application: Record<string, string | number | boolean | undefined>
  localRunner: { status: string; error?: string }
  imBridge: { status: string }
  security: Record<string, unknown>
  recentLogs: string[]
}

export type CustomOpenCodeApi = {
  server(): Promise<CustomOpenCodeServerState>
  restartServer(): Promise<CustomOpenCodeServerState>
  rendererSettings(): Promise<Record<string, string>>
  updateRendererSettings(settings: Record<string, string>): Promise<Record<string, string>>
  consumeInitialDeepLinks(): Promise<CustomOpenCodeDeepLink[]>
  onDeepLink(callback: (deepLink: CustomOpenCodeDeepLink) => void): () => void
  imBridgeConfig(): Promise<ImBridgeConfig>
  updateImBridgeConfig(config: ImBridgeConfig): Promise<ImBridgeConfig>
  imBridgeState(): Promise<ImBridgeState>
  startImBridge(): Promise<ImBridgeState>
  stopImBridge(): Promise<ImBridgeState>
  restartImBridge(): Promise<ImBridgeState>
  onImBridgeStateChanged(callback: (state: ImBridgeState) => void): () => void
  security(): Promise<CustomOpenCodeSecurityConfig>
  updateSecurity(config: CustomOpenCodeSecurityConfig): Promise<CustomOpenCodeSecurityConfig>
  securityAudit(): Promise<Array<{ file: string; line: string }>>
  windowsSandboxStatus(): Promise<CustomOpenCodeWindowsSandboxStatus>
  installWindowsSandbox(): Promise<CustomOpenCodeWindowsSandboxStatus>
  serverCredential(id: string): Promise<CustomOpenCodeServerCredential | undefined>
  setServerCredential(id: string, credential: CustomOpenCodeServerCredential | null): Promise<void>
  setSecureEnvironment(scope: string, values: Record<string, string> | null): Promise<void>
  hostingCredentials(): Promise<Record<CustomOpenCodeHostingProvider, boolean>>
  setHostingCredential(provider: CustomOpenCodeHostingProvider, credential: CustomOpenCodeServerCredential | null): Promise<void>
  createPullRequest(input: { remoteUrl: string; sourceBranch: string; targetBranch: string; title: string; body?: string; draft?: boolean }): Promise<{ url: string; provider: CustomOpenCodeHostingProvider }>
  onServerUpdated(callback: (state: CustomOpenCodeServerState) => void): () => void
  searchPlugins(query: string): Promise<CustomOpenCodePluginSearchResult[]>
  inspectPlugins(specs: string[]): Promise<CustomOpenCodePluginMetadata[]>
  searchMcpServers(input: { provider: "official" | "netease"; query: string; category?: string; cursor?: string }): Promise<CustomOpenCodeMcpSearchPage>
  setMcpMarketplaceSource(input: { directory?: string; name: string; provider: "official" | "netease" | null }): Promise<void>
  mcpSources(input: { directory?: string; names: string[] }): Promise<Record<string, CustomOpenCodeMcpSource>>
  searchExpertKits(query: string): Promise<CustomOpenCodeExpertKit[]>
  expertKitSkillSources(): Promise<CustomOpenCodeExpertKitSkillSource[]>
  installExpertKit(id: string, force?: boolean): Promise<void>
  removeExpertKit(id: string, force?: boolean): Promise<void>
  installPlugin(spec: string): Promise<CustomOpenCodePluginInstallResult>
  listTasks(): Promise<CustomOpenCodeScheduledTask[]>
  listTaskRuns(taskID?: string): Promise<CustomOpenCodeScheduledTaskRunSummary[]>
  listTaskRunPage(input?: { taskID?: string; limit?: number; offset?: number }): Promise<CustomOpenCodeScheduledTaskRunPage>
  taskRunLog(id: string): Promise<string | null>
  taskSettings(): Promise<CustomOpenCodeScheduledTaskSettings>
  updateTaskSettings(input: CustomOpenCodeScheduledTaskSettings): Promise<CustomOpenCodeScheduledTaskSettings>
  setTaskRunArchived(sessionID: string, archived: boolean): Promise<void>
  createTask(input: CustomOpenCodeScheduledTaskInput): Promise<CustomOpenCodeScheduledTask>
  updateTask(id: string, input: CustomOpenCodeScheduledTaskInput): Promise<CustomOpenCodeScheduledTask>
  removeTask(id: string): Promise<boolean>
  runTask(id: string): Promise<CustomOpenCodeScheduledTask>
  cancelTask(id: string): Promise<CustomOpenCodeScheduledTask>
  cancelTaskRun(id: string): Promise<CustomOpenCodeScheduledTaskRun>
  onTasksChanged(callback: () => void): () => void
  writeSkillFiles(root: string, files: Array<{ path: string; content: string }>): Promise<CustomOpenCodeSkillWriteResult>
  ensureSkillRoot(): Promise<CustomOpenCodeSkillEnsureRootResult>
  deleteSkill(location: string): Promise<CustomOpenCodeSkillDeleteResult>
  writeProjectFile(directory: string, path: string, content: string): Promise<{ ok: boolean }>
  removeAgentConfig(input: { scope: "global" | "project"; directory?: string; name: string }): Promise<{ changed: boolean; file: string }>
  notificationHistoryList(): Promise<Array<{ id: string; type: string; title: string; body: string; sessionId: string; directory?: string; requestId?: string; timestamp: number; read: boolean }>>
  notificationHistoryReplaceAll(notifications: Array<{ id: string; type: string; title: string; body: string; sessionId: string; directory?: string; requestId?: string; timestamp: number; read: boolean }>): Promise<boolean>
  openExternalUrl(url: string): Promise<boolean>
  openInternalUrl(url: string): Promise<boolean>
  openLocalFileUrl(url: string): Promise<boolean>
  draftGet(key: string): Promise<string | null>
  draftSet(key: string, value: string): Promise<void>
  draftDelete(key: string): Promise<void>
  draftKeys(): Promise<string[]>
  draftBlobPut(data: ArrayBuffer): Promise<string>
  draftBlobGet(id: string): Promise<ArrayBuffer | null>
  discoverPreviewPorts(host: string): Promise<string[]>
  capturePreview(rect: { x: number; y: number; width: number; height: number }): Promise<{ saved: boolean; file?: string }>
  locationApps(): Promise<CustomOpenCodeLocationApp[]>
  openLocation(input: { path: string; appId: string }): Promise<boolean>
  desktopPreferences(): Promise<DesktopPreferences>
  updateDesktopPreferences(preferences: DesktopPreferences): Promise<DesktopPreferences>
  projectState(serverId: string): Promise<ProjectState>
  updateProjectDirectories(serverId: string, directories: ProjectDirectory[]): Promise<ProjectState>
  updateRecentProjects(serverId: string, recentProjects: Record<string, number>): Promise<ProjectState>
  cachedSessions(serverId: string, directory?: string): Promise<CachedSessionList | undefined>
  updateCachedSessions(serverId: string, directory: string, sessions: Session[]): Promise<CachedSessionList>
  queryQuota(input: QuotaQueryInput): Promise<QuotaProviderResult[]>
  providerAuthKey(providerID: string): Promise<string | undefined>
  openCodeGoQuotaConfig(): Promise<OpenCodeGoQuotaConfig>
  updateOpenCodeGoQuotaConfig(input: OpenCodeGoQuotaConfigUpdate): Promise<OpenCodeGoQuotaConfig>
  waitConsoleLogin(login: CustomOpenCodeConsoleLoginStart): Promise<CustomOpenCodeConsoleLoginResult>
  notificationPermission(): Promise<CustomOpenCodeNotificationPermission>
  sendNotification(input: {
    title: string
    body?: string
    sessionId?: string
    directory?: string
  }): Promise<CustomOpenCodeNotificationSendResult>
  microphonePermission(): Promise<CustomOpenCodeMicrophonePermission>
  speechModelConfig(): Promise<SpeechModelConfig>
  updateSpeechModelConfig(config: SpeechModelUpdate): Promise<SpeechModelConfig>
  speechModels(config: SpeechModelDiscoveryInput): Promise<SpeechModelOption[]>
  transcribeAudio(input: SpeechTranscriptionInput): Promise<{ text: string }>
  onNotificationClicked(callback: (data: { sessionId?: string; directory?: string }) => void): () => void
  exportDebugLogs(): Promise<string>
  diagnostics(): Promise<CustomOpenCodeDiagnostics>
  listDrives(): Promise<string[]>
  selectDirectory(defaultPath?: string): Promise<string | null>
  // Window controls
  windowMinimize(): Promise<void>
  windowMaximize(): Promise<void>
  windowClose(): Promise<void>
  windowIsMaximized(): Promise<boolean>
  windowSetTheme(theme: "system" | "light" | "dark"): Promise<void>
  onWindowMaximizeChange(callback: (isMaximized: boolean) => void): () => void
  setBadgeCount(count: number): Promise<void>
  updaterState(): Promise<UpdaterState>
  updaterCheck(): Promise<void>
  updaterDownload(): Promise<void>
  updaterInstall(): Promise<void>
  onUpdaterStateChanged(callback: (state: UpdaterState) => void): () => void
}

const api: CustomOpenCodeApi = {
  server: () => ipcRenderer.invoke("server:get"),
  restartServer: () => ipcRenderer.invoke("server:restart"),
  rendererSettings: () => ipcRenderer.invoke("renderer-settings:get"),
  updateRendererSettings: (settings) => ipcRenderer.invoke("renderer-settings:set", settings),
  consumeInitialDeepLinks: () => ipcRenderer.invoke("deep-link:consume-initial"),
  onDeepLink(callback) {
    const listener = (_event: unknown, deepLink: CustomOpenCodeDeepLink) => callback(deepLink)
    ipcRenderer.on("deep-link:received", listener)
    return () => ipcRenderer.removeListener("deep-link:received", listener)
  },
  imBridgeConfig: () => ipcRenderer.invoke("im-bridge:config-get"),
  updateImBridgeConfig: (config) => ipcRenderer.invoke("im-bridge:config-set", config),
  imBridgeState: () => ipcRenderer.invoke("im-bridge:state"),
  startImBridge: () => ipcRenderer.invoke("im-bridge:start"),
  stopImBridge: () => ipcRenderer.invoke("im-bridge:stop"),
  restartImBridge: () => ipcRenderer.invoke("im-bridge:restart"),
  onImBridgeStateChanged(callback) {
    const listener = (_event: unknown, state: ImBridgeState) => callback(state)
    ipcRenderer.on("im-bridge:state", listener)
    return () => ipcRenderer.removeListener("im-bridge:state", listener)
  },
  security: () => ipcRenderer.invoke("security:get"),
  updateSecurity: (config) => ipcRenderer.invoke("security:set", config),
  securityAudit: () => ipcRenderer.invoke("security:audit"),
  windowsSandboxStatus: () => ipcRenderer.invoke("security:windows-sandbox-status"),
  installWindowsSandbox: () => ipcRenderer.invoke("security:windows-sandbox-install"),
  serverCredential: (id) => ipcRenderer.invoke("credential:get", id),
  setServerCredential: (id, credential) => ipcRenderer.invoke("credential:set", id, credential),
  setSecureEnvironment: (scope, values) => ipcRenderer.invoke("secure-environment:set", scope, values),
  hostingCredentials: () => ipcRenderer.invoke("hosting:credentials"),
  setHostingCredential: (provider, credential) => ipcRenderer.invoke("hosting:credential-set", provider, credential),
  createPullRequest: (input) => ipcRenderer.invoke("hosting:pr-create", input),
  onServerUpdated(callback) {
    const listener = (_event: unknown, state: CustomOpenCodeServerState) => callback(state)
    ipcRenderer.on("server:updated", listener)
    return () => ipcRenderer.removeListener("server:updated", listener)
  },
  searchPlugins: (query) => ipcRenderer.invoke("plugin:search", query),
  inspectPlugins: (specs) => ipcRenderer.invoke("plugin:inspect", specs),
  searchMcpServers: (input) => ipcRenderer.invoke("mcp:search", input),
  setMcpMarketplaceSource: (input) => ipcRenderer.invoke("mcp:source-set", input),
  mcpSources: (input) => ipcRenderer.invoke("mcp:source-list", input),
  searchExpertKits: (query) => ipcRenderer.invoke("expert-kit:search", query),
  expertKitSkillSources: () => ipcRenderer.invoke("expert-kit:skill-sources"),
  installExpertKit: (id, force) => ipcRenderer.invoke("expert-kit:install", id, force),
  removeExpertKit: (id, force) => ipcRenderer.invoke("expert-kit:remove", id, force),
  installPlugin: (spec) => ipcRenderer.invoke("plugin:install", spec),
  listTasks: () => ipcRenderer.invoke("task:list"),
  listTaskRuns: (taskID) => ipcRenderer.invoke("task:run-list", taskID),
  listTaskRunPage: (input) => ipcRenderer.invoke("task:run-page", input),
  taskRunLog: (id) => ipcRenderer.invoke("task:run-log", id),
  taskSettings: () => ipcRenderer.invoke("task:settings"),
  updateTaskSettings: (input) => ipcRenderer.invoke("task:settings-update", input),
  setTaskRunArchived: (sessionID, archived) => ipcRenderer.invoke("task:run-archive", sessionID, archived),
  createTask: (input) => ipcRenderer.invoke("task:create", input),
  updateTask: (id, input) => ipcRenderer.invoke("task:update", id, input),
  removeTask: (id) => ipcRenderer.invoke("task:remove", id),
  runTask: (id) => ipcRenderer.invoke("task:run", id),
  cancelTask: (id) => ipcRenderer.invoke("task:cancel", id),
  cancelTaskRun: (id) => ipcRenderer.invoke("task:run-cancel", id),
  onTasksChanged(callback) {
    const listener = () => callback()
    ipcRenderer.on("task:changed", listener)
    return () => ipcRenderer.removeListener("task:changed", listener)
  },
  writeSkillFiles: (root, files) => ipcRenderer.invoke("skill:write-files", root, files),
  writeProjectFile: (directory, path, content) => ipcRenderer.invoke("file:write", directory, path, content),
  removeAgentConfig: (input) => ipcRenderer.invoke("agents:remove-config", input),
  notificationHistoryList: () => ipcRenderer.invoke("notification-history:list"),
  notificationHistoryReplaceAll: (notifications) => ipcRenderer.invoke("notification-history:replace-all", notifications),
  ensureSkillRoot: () => ipcRenderer.invoke("skill:ensure-root"),
  deleteSkill: (location) => ipcRenderer.invoke("skill:delete", location),
  openExternalUrl: (url) => ipcRenderer.invoke("browser:open-external", url),
  openInternalUrl: (url) => ipcRenderer.invoke("browser:open-internal", url),
  openLocalFileUrl: (url) => ipcRenderer.invoke("browser:open-local-file", url),
  draftGet: (key) => ipcRenderer.invoke("draft-get", key),
  draftSet: (key, value) => ipcRenderer.invoke("draft-set", key, value),
  draftDelete: (key) => ipcRenderer.invoke("draft-set", key, null),
  draftKeys: () => ipcRenderer.invoke("draft-keys"),
  draftBlobPut: (data) => ipcRenderer.invoke("draft-blob-put", data),
  draftBlobGet: (id) => ipcRenderer.invoke("draft-blob-get", id),
  discoverPreviewPorts: (host) => ipcRenderer.invoke("preview:discover", host),
  capturePreview: (rect) => ipcRenderer.invoke("preview:capture", rect),
  locationApps: () => ipcRenderer.invoke("location:apps"),
  openLocation: (input) => ipcRenderer.invoke("location:open", input),
  desktopPreferences: () => ipcRenderer.invoke("desktop-preferences:get"),
  updateDesktopPreferences: (preferences) => ipcRenderer.invoke("desktop-preferences:set", preferences),
  projectState: (serverId) => ipcRenderer.invoke("projects:get", serverId),
  updateProjectDirectories: (serverId, directories) => ipcRenderer.invoke("projects:directories-set", serverId, directories),
  updateRecentProjects: (serverId, recentProjects) => ipcRenderer.invoke("projects:recent-set", serverId, recentProjects),
  cachedSessions: (serverId, directory) => ipcRenderer.invoke("session-list-cache:get", serverId, directory),
  updateCachedSessions: (serverId, directory, sessions) => ipcRenderer.invoke("session-list-cache:set", serverId, directory, sessions),
  queryQuota: (input) => ipcRenderer.invoke("quota:query", input),
  providerAuthKey: (providerID) => ipcRenderer.invoke("provider-auth:key", providerID),
  openCodeGoQuotaConfig: () => ipcRenderer.invoke("quota:opencode-go-config"),
  updateOpenCodeGoQuotaConfig: (input) => ipcRenderer.invoke("quota:opencode-go-config-set", input),
  waitConsoleLogin: (login) => ipcRenderer.invoke("console:login-wait", login),
  notificationPermission: () => ipcRenderer.invoke("notification:permission"),
  sendNotification: (input) => ipcRenderer.invoke("notification:send", input),
  microphonePermission: () => ipcRenderer.invoke("microphone:permission"),
  speechModelConfig: () => ipcRenderer.invoke("speech-model:config-get"),
  updateSpeechModelConfig: (config) => ipcRenderer.invoke("speech-model:config-set", config),
  speechModels: (config) => ipcRenderer.invoke("speech-model:models", config),
  transcribeAudio: (input) => ipcRenderer.invoke("speech-model:transcribe", input),
  onNotificationClicked(callback) {
    const listener = (_event: unknown, data: { sessionId?: string; directory?: string }) => callback(data)
    ipcRenderer.on("notification:clicked", listener)
    return () => ipcRenderer.removeListener("notification:clicked", listener)
  },
  exportDebugLogs: () => ipcRenderer.invoke("logging:export"),
  diagnostics: () => ipcRenderer.invoke("diagnostics:get"),
  listDrives: () => ipcRenderer.invoke("drives:list"),
  selectDirectory: (defaultPath) => ipcRenderer.invoke("dialog:select-directory", defaultPath),
  // Window controls
  windowMinimize: () => ipcRenderer.invoke("window:minimize"),
  windowMaximize: () => ipcRenderer.invoke("window:maximize"),
  windowClose: () => ipcRenderer.invoke("window:close"),
  windowIsMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  windowSetTheme: (theme) => ipcRenderer.invoke("window:set-theme", theme),
  onWindowMaximizeChange(callback) {
    const listener = (_event: unknown, isMaximized: boolean) => callback(isMaximized)
    ipcRenderer.on("window:maximize-change", listener)
    return () => ipcRenderer.removeListener("window:maximize-change", listener)
  },
  setBadgeCount: (count) => ipcRenderer.invoke("badge:set-count", count),
  updaterState: () => ipcRenderer.invoke("updater:get-state"),
  updaterCheck: () => ipcRenderer.invoke("updater:check"),
  updaterDownload: () => ipcRenderer.invoke("updater:download"),
  updaterInstall: () => ipcRenderer.invoke("updater:install"),
  onUpdaterStateChanged(callback) {
    const listener = (_event: unknown, state: UpdaterState) => callback(state)
    ipcRenderer.on("updater:state", listener)
    return () => ipcRenderer.removeListener("updater:state", listener)
  },
}

contextBridge.exposeInMainWorld("customOpenCode", api)
