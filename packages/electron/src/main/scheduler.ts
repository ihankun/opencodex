import { app } from "electron"
import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { timingSafeEqual } from "node:crypto"
import { chmod } from "node:fs/promises"
import { Cron } from "croner"
import { migrateScheduledTaskDatabase, verifyScheduledTaskDatabase } from "./schedulerDatabase"

type ExecutionMode = "current" | "worktree"
type WorktreeCleanup = "always" | "on-success" | "never"
type PermissionProfile = "ask" | "writes" | "risk" | "full"
type OverlapPolicy = "skip" | "queue" | "parallel"
type MissedRunPolicy = "skip" | "run-once"
type TriggerType = "schedule" | "task-success" | "task-failure" | "webhook"
type NotificationChannel = "desktop" | "webhook"
type RunStatus = "queued" | "running" | "submitted" | "recovering" | "completed" | "failed" | "timed_out" | "cancelled" | "blocked"

export type ScheduledTask = {
  id: string
  title: string
  prompt: string
  cron: string
  timezone: string
  serverId: string
  serverName: string
  serverUrl: string
  directory: string
  executionMode: ExecutionMode
  worktreeCleanup: WorktreeCleanup
  branch: string
  permissionProfile: PermissionProfile
  retryCount: number
  retryDelaySeconds: number
  completionTimeoutMinutes: number
  overlapPolicy: OverlapPolicy
  maxConcurrentRuns: number
  missedRunPolicy: MissedRunPolicy
  catchUpWindowMinutes: number
  triggerType: TriggerType
  triggerTaskId: string
  dependencyTaskIds: string[]
  notificationChannels: NotificationChannel[]
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

export type ScheduledTaskRun = {
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
  executionMode: ExecutionMode
  worktreeDirectory: string
  branch: string
  permissionProfile: PermissionProfile
  attempt: number
  modelProviderID: string
  modelID: string
  variant: string
  status: RunStatus
  error: string | null
  log: string
  updatedAt: number
  createdAt: number
  completedAt: number | null
}

export type ScheduledTaskRunSummary = Omit<ScheduledTaskRun, "log"> & {
  logPreview: string
}

export type ScheduledTaskRunPage = {
  data: ScheduledTaskRunSummary[]
  total: number
  hasMore: boolean
}

export type ScheduledTaskSettings = {
  maxConcurrency: number
  historyRetentionDays: number
  maxHistory: number
  webhookPort: number
}

type TaskInput = Pick<
  ScheduledTask,
  | "title"
  | "prompt"
  | "cron"
  | "timezone"
  | "serverId"
  | "serverName"
  | "serverUrl"
  | "directory"
  | "executionMode"
  | "worktreeCleanup"
  | "branch"
  | "permissionProfile"
  | "retryCount"
  | "retryDelaySeconds"
  | "completionTimeoutMinutes"
  | "overlapPolicy"
  | "maxConcurrentRuns"
  | "missedRunPolicy"
  | "catchUpWindowMinutes"
  | "triggerType"
  | "triggerTaskId"
  | "dependencyTaskIds"
  | "notificationChannels"
  | "notificationWebhookUrl"
  | "modelProviderID"
  | "modelID"
  | "variant"
  | "enabled"
>

type ServerState = { url: string; username?: string; password?: string }
type AttemptResult = { ok: true; runID: string } | { ok: false; runID: string; message: string; retryable: boolean; cancelled: boolean }

const RUN_PAGE_DEFAULT_LIMIT = 50
const RUN_PAGE_MAX_LIMIT = 100
const RUN_SUMMARY_MAX_LIMIT = 10_000
const RUN_LOG_PREVIEW_LENGTH = 8_000
const RUN_SUMMARY_COLUMNS = [
  "id",
  "task_id",
  "task_title",
  "prompt",
  "session_id",
  "server_id",
  "server_name",
  "server_url",
  "directory",
  "execution_directory",
  "execution_mode",
  "worktree_directory",
  "branch",
  "permission_profile",
  "attempt",
  "model_provider_id",
  "model_id",
  "variant",
  "status",
  "error",
  "updated_at",
  "created_at",
  "completed_at",
].join(", ")

export class TaskScheduler {
  private database?: DatabaseSync
  private jobs = new Map<string, Cron>()
  private running = new Map<string, number>()
  private taskWaiters = new Map<string, Array<() => void>>()
  private cancelledRuns = new Set<string>()
  private capacityWaiters: Array<() => void> = []
  private globalRunning = 0
  private stopping = false
  private activeExecutions = new Set<Promise<void>>()
  private maxConcurrency = 3
  private historyRetentionDays = 90
  private maxHistory = 1000
  private webhookPort = 49832
  private webhookServer?: Server
  private webhookAddress = ""

  constructor(
    private readonly resolveServer: (task: ScheduledTask) => Promise<ServerState | undefined>,
    private readonly onChanged: () => void,
    private readonly onFinished?: (run: ScheduledTaskRun, task: ScheduledTask) => void,
  ) {}

  start() {
    this.stopping = false
    const databasePath = join(app.getPath("userData"), "scheduled-tasks.sqlite")
    this.database = new DatabaseSync(databasePath)
    void chmod(databasePath, 0o600).catch(() => undefined)
    migrateScheduledTaskDatabase(this.database)
    verifyScheduledTaskDatabase(this.database)
    this.loadSettings()
    void this.startWebhookServer()
    this.pruneHistory()
    const tasks = this.list().filter((task) => task.enabled)
    tasks.forEach((task) => this.register(task))
    const recovery = this.recoverInterruptedRuns().then(() => tasks.forEach((task) => this.catchUp(this.get(task.id))))
    this.track(recovery)
    void this.cleanupOrphanedWorktrees()
  }

  async stop() {
    this.stopping = true
    this.jobs.forEach((job) => job.stop())
    this.jobs.clear()
    await this.stopWebhookServer()
    await Promise.race([Promise.allSettled([...this.activeExecutions]), delay(5_000)])
    if (this.activeExecutions.size > 0) return
    this.database?.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    this.database?.close()
    this.database = undefined
  }

  list(): ScheduledTask[] {
    const rows = this.db().prepare("SELECT * FROM scheduled_task ORDER BY created_at DESC").all() as Array<Record<string, unknown>>
    return rows.map((row) => this.read(row))
  }

  settings(): ScheduledTaskSettings {
    return {
      maxConcurrency: this.maxConcurrency,
      historyRetentionDays: this.historyRetentionDays,
      maxHistory: this.maxHistory,
      webhookPort: this.webhookPort,
    }
  }

  updateSettings(input: ScheduledTaskSettings) {
    if (!Number.isInteger(input.maxConcurrency) || input.maxConcurrency < 1 || input.maxConcurrency > 20) throw new Error("Maximum concurrency must be between 1 and 20")
    if (!Number.isInteger(input.historyRetentionDays) || input.historyRetentionDays < 1 || input.historyRetentionDays > 365) throw new Error("History retention must be between 1 and 365 days")
    if (!Number.isInteger(input.maxHistory) || input.maxHistory < 100 || input.maxHistory > 10000) throw new Error("Maximum history must be between 100 and 10000")
    if (!Number.isInteger(input.webhookPort) || input.webhookPort < 1024 || input.webhookPort > 65535) throw new Error("Webhook port must be between 1024 and 65535")
    const previousWebhookPort = this.webhookPort
    const database = this.db()
    database.exec("BEGIN IMMEDIATE")
    try {
      const statement = database.prepare("INSERT INTO scheduled_task_setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      Object.entries(input).forEach(([key, value]) => statement.run(key, String(value)))
      database.exec("COMMIT")
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
    this.loadSettings()
    if (!this.webhookServer || previousWebhookPort !== this.webhookPort) {
      void this.stopWebhookServer().then(() => this.startWebhookServer())
    }
    this.pruneHistory()
    return this.settings()
  }

  listRuns(taskID?: string): ScheduledTaskRun[] {
    const rows = (taskID
      ? this.db().prepare("SELECT * FROM scheduled_task_run WHERE task_id = ? AND archived = 0 ORDER BY created_at DESC").all(taskID)
      : this.db().prepare("SELECT * FROM scheduled_task_run WHERE archived = 0 ORDER BY created_at DESC").all()) as Array<Record<string, unknown>>
    return rows.map((row) => this.readRun(row))
  }

  listRunSummaries(
    taskID?: string,
    limit = RUN_PAGE_DEFAULT_LIMIT,
    offset = 0,
    includePreview = true,
  ): ScheduledTaskRunPage {
    const maxLimit = includePreview ? RUN_PAGE_MAX_LIMIT : RUN_SUMMARY_MAX_LIMIT
    const normalizedLimit = Number.isInteger(limit)
      ? Math.min(maxLimit, Math.max(1, limit))
      : RUN_PAGE_DEFAULT_LIMIT
    const normalizedOffset = Number.isInteger(offset) ? Math.max(0, offset) : 0
    const where = taskID ? "task_id = ? AND archived = 0" : "archived = 0"
    const params = taskID ? [taskID] : []
    const totalRow = this.db().prepare(`SELECT COUNT(*) AS count FROM scheduled_task_run WHERE ${where}`).get(...params) as { count?: number } | undefined
    const preview = includePreview ? `, substr(log, -${RUN_LOG_PREVIEW_LENGTH}) AS log_preview` : ", '' AS log_preview"
    const rows = this.db().prepare(
      `SELECT ${RUN_SUMMARY_COLUMNS}${preview} FROM scheduled_task_run WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(...params, normalizedLimit, normalizedOffset) as Array<Record<string, unknown>>
    const total = Number(totalRow?.count ?? 0)
    return {
      data: rows.map((row) => this.readRunSummary(row)),
      total,
      hasMore: normalizedOffset + rows.length < total,
    }
  }

  getRunLog(id: string) {
    const row = this.db().prepare("SELECT log FROM scheduled_task_run WHERE id = ?").get(id) as { log?: unknown } | undefined
    if (!row) throw new Error("Scheduled task run not found")
    return typeof row.log === "string" ? row.log : ""
  }

  private readRun(row: Record<string, unknown>): ScheduledTaskRun {
    return {
      id: String(row.id),
      taskID: String(row.task_id),
      taskTitle: String(row.task_title),
      prompt: String(row.prompt),
      sessionID: String(row.session_id),
      serverId: String(row.server_id),
      serverName: String(row.server_name),
      serverUrl: String(row.server_url),
      directory: String(row.directory),
      executionDirectory: String(row.execution_directory || row.directory),
      executionMode: normalizeExecutionMode(row.execution_mode),
      worktreeDirectory: String(row.worktree_directory ?? ""),
      branch: String(row.branch),
      permissionProfile: normalizePermissionProfile(row.permission_profile),
      attempt: Number(row.attempt),
      modelProviderID: String(row.model_provider_id),
      modelID: String(row.model_id),
      variant: String(row.variant),
      status: String(row.status) as RunStatus,
      error: typeof row.error === "string" ? row.error : null,
      log: String(row.log ?? ""),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at || row.created_at),
      completedAt: typeof row.completed_at === "number" ? row.completed_at : null,
    }
  }

  private readRunSummary(row: Record<string, unknown>): ScheduledTaskRunSummary {
    const { log: _log, ...summary } = this.readRun(row)
    return {
      ...summary,
      logPreview: typeof row.log_preview === "string" ? row.log_preview : "",
    }
  }

  setRunArchived(sessionID: string, archived: boolean) {
    this.db().prepare("UPDATE scheduled_task_run SET archived = ? WHERE session_id = ?").run(Number(archived), sessionID)
  }

  async cancelRun(id: string) {
    const row = this.db().prepare("SELECT * FROM scheduled_task_run WHERE id = ?").get(id) as Record<string, unknown> | undefined
    if (!row) throw new Error("Scheduled task run not found")
    const status = String(row.status) as RunStatus
    if (!isActiveStatus(status)) return this.readRun(row)
    this.cancelledRuns.add(id)
    const task = this.get(String(row.task_id))
    const server = await this.resolveServer(task)
    const sessionID = String(row.session_id)
    if (server && !sessionID.startsWith("pending:")) {
      const query = row.execution_directory ? `?directory=${encodeURIComponent(String(row.execution_directory))}` : ""
      await this.fetchJson(server, `/api/session/${encodeURIComponent(sessionID)}/interrupt`, { method: "POST" }).catch(() => undefined)
    }
    this.finishRun(id, "cancelled", "Cancelled by user")
    this.announceRun(task, id)
    return this.getRun(id)
  }

  async cancelTask(id: string) {
    const runs = this.listRunSummaries(id, RUN_SUMMARY_MAX_LIMIT, 0, false).data.filter((run) => isActiveStatus(run.status))
    await Promise.all(runs.map((run) => this.cancelRun(run.id)))
    return this.get(id)
  }

  create(input: TaskInput) {
    this.validate(input)
    const now = Date.now()
    const id = crypto.randomUUID()
    this.validateReferences(id, input)
    this.db().prepare(`
      INSERT INTO scheduled_task (
        id, title, prompt, cron, timezone, server_id, server_name, server_url, directory,
        execution_mode, worktree_cleanup, branch, permission_profile, retry_count, retry_delay_seconds,
        completion_timeout_minutes, overlap_policy, max_concurrent_runs, missed_run_policy, catch_up_window_minutes,
        trigger_type, trigger_task_id, dependency_task_ids, notification_channels, notification_webhook_url, webhook_secret,
        model_provider_id, model_id, variant, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.title.trim(), input.prompt.trim(), input.cron.trim(), input.timezone,
      input.serverId, input.serverName.trim(), normalizeServerUrl(input.serverUrl), input.directory.trim(),
      input.executionMode, input.worktreeCleanup, input.branch.trim(), input.permissionProfile, input.retryCount, input.retryDelaySeconds,
      input.completionTimeoutMinutes, input.overlapPolicy, input.maxConcurrentRuns, input.missedRunPolicy, input.catchUpWindowMinutes,
      input.triggerType, input.triggerTaskId, JSON.stringify(input.dependencyTaskIds), JSON.stringify(input.notificationChannels), input.notificationWebhookUrl.trim(), crypto.randomUUID(),
      input.modelProviderID, input.modelID, input.variant, Number(input.enabled), now, now,
    )
    const task = this.get(id)
    if (task.enabled) this.register(task)
    return task
  }

  update(id: string, input: TaskInput) {
    this.validate(input)
    this.require(id)
    this.validateReferences(id, input)
    this.jobs.get(id)?.stop()
    this.jobs.delete(id)
    this.db().prepare(`
      UPDATE scheduled_task SET
        title = ?, prompt = ?, cron = ?, timezone = ?, server_id = ?, server_name = ?, server_url = ?,
        directory = ?, execution_mode = ?, worktree_cleanup = ?, branch = ?, permission_profile = ?, retry_count = ?,
        retry_delay_seconds = ?, completion_timeout_minutes = ?, overlap_policy = ?, max_concurrent_runs = ?,
        missed_run_policy = ?, catch_up_window_minutes = ?, trigger_type = ?, trigger_task_id = ?,
        dependency_task_ids = ?, notification_channels = ?, notification_webhook_url = ?, model_provider_id = ?, model_id = ?,
        variant = ?, enabled = ?, last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(
      input.title.trim(), input.prompt.trim(), input.cron.trim(), input.timezone,
      input.serverId, input.serverName.trim(), normalizeServerUrl(input.serverUrl), input.directory.trim(),
      input.executionMode, input.worktreeCleanup, input.branch.trim(), input.permissionProfile, input.retryCount, input.retryDelaySeconds,
      input.completionTimeoutMinutes, input.overlapPolicy, input.maxConcurrentRuns, input.missedRunPolicy, input.catchUpWindowMinutes,
      input.triggerType, input.triggerTaskId, JSON.stringify(input.dependencyTaskIds), JSON.stringify(input.notificationChannels), input.notificationWebhookUrl.trim(),
      input.modelProviderID, input.modelID, input.variant, Number(input.enabled), Date.now(), id,
    )
    const task = this.get(id)
    if (task.enabled) this.register(task)
    return task
  }

  remove(id: string) {
    this.require(id)
    if ((this.running.get(id) ?? 0) > 0) throw new Error("Stop the running task before deleting it")
    const reference = this.list().find((task) => task.id !== id && (task.triggerTaskId === id || task.dependencyTaskIds.includes(id)))
    if (reference) throw new Error(`Automation is referenced by: ${reference.title}`)
    this.jobs.get(id)?.stop()
    this.jobs.delete(id)
    this.db().prepare("DELETE FROM scheduled_task WHERE id = ?").run(id)
    return true
  }

  async run(id: string) {
    void this.launch(this.get(id))
    return this.get(id)
  }

  private db() {
    if (!this.database) throw new Error("Task scheduler is not started")
    return this.database
  }

  private require(id: string) {
    const row = this.db().prepare("SELECT id FROM scheduled_task WHERE id = ?").get(id)
    if (!row) throw new Error("Scheduled task not found")
  }

  private get(id: string) {
    const row = this.db().prepare("SELECT * FROM scheduled_task WHERE id = ?").get(id) as Record<string, unknown> | undefined
    if (!row) throw new Error("Scheduled task not found")
    return this.read(row)
  }

  private read(row: Record<string, unknown>): ScheduledTask {
    const id = String(row.id)
    const job = this.jobs.get(id)
    return {
      id,
      title: String(row.title),
      prompt: String(row.prompt),
      cron: String(row.cron),
      timezone: String(row.timezone),
      serverId: String(row.server_id),
      serverName: String(row.server_name),
      serverUrl: String(row.server_url),
      directory: String(row.directory),
      executionMode: normalizeExecutionMode(row.execution_mode),
      worktreeCleanup: normalizeWorktreeCleanup(row.worktree_cleanup),
      branch: String(row.branch),
      permissionProfile: normalizePermissionProfile(row.permission_profile),
      retryCount: Number(row.retry_count),
      retryDelaySeconds: Number(row.retry_delay_seconds),
      completionTimeoutMinutes: Number(row.completion_timeout_minutes),
      overlapPolicy: normalizeOverlapPolicy(row.overlap_policy),
      maxConcurrentRuns: Number(row.max_concurrent_runs),
      missedRunPolicy: normalizeMissedRunPolicy(row.missed_run_policy),
      catchUpWindowMinutes: Number(row.catch_up_window_minutes),
      triggerType: normalizeTriggerType(row.trigger_type),
      triggerTaskId: String(row.trigger_task_id ?? ""),
      dependencyTaskIds: stringArray(row.dependency_task_ids),
      notificationChannels: notificationChannels(row.notification_channels),
      notificationWebhookUrl: String(row.notification_webhook_url ?? ""),
      webhookUrl: this.webhookAddress && row.webhook_secret ? `${this.webhookAddress}/automation/${encodeURIComponent(id)}/${encodeURIComponent(String(row.webhook_secret))}` : "",
      modelProviderID: String(row.model_provider_id),
      modelID: String(row.model_id),
      variant: String(row.variant),
      enabled: Boolean(row.enabled),
      status: (this.running.get(id) ?? 0) > 0 ? "running" : row.last_error ? "error" : row.enabled ? "enabled" : "paused",
      lastRunAt: typeof row.last_run_at === "number" ? row.last_run_at : null,
      nextRunAt: job?.nextRun()?.getTime() ?? null,
      lastError: typeof row.last_error === "string" ? row.last_error : null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
  }

  private validate(input: TaskInput) {
    if (!input.title.trim()) throw new Error("Task title is required")
    if (!input.prompt.trim()) throw new Error("Task prompt is required")
    if (!input.timezone) throw new Error("Timezone is required")
    if (!input.serverId || !input.serverName.trim()) throw new Error("Server is required")
    normalizeServerUrl(input.serverUrl)
    if (!input.modelProviderID || !input.modelID) throw new Error("Model is required")
    if (input.executionMode !== "current" && input.executionMode !== "worktree") throw new Error("Invalid execution mode")
    if (input.executionMode === "worktree" && !input.directory.trim()) throw new Error("Worktree tasks require a project directory")
    if (input.worktreeCleanup !== "always" && input.worktreeCleanup !== "on-success" && input.worktreeCleanup !== "never") throw new Error("Invalid worktree cleanup policy")
    if (!["ask", "writes", "risk", "full"].includes(input.permissionProfile)) throw new Error("Invalid permission profile")
    if (!Number.isInteger(input.retryCount) || input.retryCount < 0 || input.retryCount > 10) throw new Error("Retry count must be between 0 and 10")
    if (!Number.isInteger(input.retryDelaySeconds) || input.retryDelaySeconds < 1 || input.retryDelaySeconds > 3600) throw new Error("Retry delay must be between 1 and 3600 seconds")
    if (!Number.isInteger(input.completionTimeoutMinutes) || input.completionTimeoutMinutes < 1 || input.completionTimeoutMinutes > 1440) throw new Error("Completion timeout must be between 1 and 1440 minutes")
    if (!["skip", "queue", "parallel"].includes(input.overlapPolicy)) throw new Error("Invalid overlap policy")
    if (!Number.isInteger(input.maxConcurrentRuns) || input.maxConcurrentRuns < 1 || input.maxConcurrentRuns > 5) throw new Error("Maximum concurrent runs must be between 1 and 5")
    if (!["skip", "run-once"].includes(input.missedRunPolicy)) throw new Error("Invalid missed run policy")
    if (!Number.isInteger(input.catchUpWindowMinutes) || input.catchUpWindowMinutes < 1 || input.catchUpWindowMinutes > 10080) throw new Error("Catch-up window must be between 1 and 10080 minutes")
    if (!["schedule", "task-success", "task-failure", "webhook"].includes(input.triggerType)) throw new Error("Invalid trigger type")
    if ((input.triggerType === "task-success" || input.triggerType === "task-failure") && !input.triggerTaskId) throw new Error("Triggered automations require a source task")
    if (!Array.isArray(input.dependencyTaskIds) || !input.dependencyTaskIds.every(id => typeof id === "string" && id.length > 0) || new Set(input.dependencyTaskIds).size !== input.dependencyTaskIds.length) throw new Error("Invalid task dependencies")
    if (!Array.isArray(input.notificationChannels) || !input.notificationChannels.every(channel => channel === "desktop" || channel === "webhook")) throw new Error("Invalid notification channels")
    if (typeof input.enabled !== "boolean") throw new Error("Invalid enabled state")
    if (input.notificationChannels.includes("webhook")) normalizeWebhookUrl(input.notificationWebhookUrl)
    const job = new Cron(input.cron.trim(), { timezone: input.timezone, paused: true })
    job.stop()
  }

  private validateReferences(id: string, input: TaskInput) {
    const references = [...new Set([
      ...(input.triggerType === "task-success" || input.triggerType === "task-failure" ? [input.triggerTaskId] : []),
      ...input.dependencyTaskIds,
    ].filter(Boolean))]
    const tasks = new Map(this.list().map((task) => [task.id, task]))
    const missing = references.find((reference) => !tasks.has(reference))
    if (missing) throw new Error(`Referenced automation does not exist: ${missing}`)
    const next = new Map(tasks)
    const current = tasks.get(id)
    next.set(id, {
      ...(current ?? this.readInputAsTask(id, input)),
      triggerType: input.triggerType,
      triggerTaskId: input.triggerTaskId,
      dependencyTaskIds: input.dependencyTaskIds,
    })
    const visit = (taskID: string, path: Set<string>): boolean => {
      if (path.has(taskID)) return true
      const task = next.get(taskID)
      if (!task) return false
      const linked = [
        ...(task.triggerType === "task-success" || task.triggerType === "task-failure" ? [task.triggerTaskId] : []),
        ...task.dependencyTaskIds,
      ].filter(Boolean)
      return linked.some((linkedID) => visit(linkedID, new Set(path).add(taskID)))
    }
    if (visit(id, new Set())) throw new Error("Automation dependencies must not contain a cycle")
  }

  private readInputAsTask(id: string, input: TaskInput): ScheduledTask {
    const now = Date.now()
    return {
      id,
      ...input,
      webhookUrl: "",
      status: input.enabled ? "enabled" : "paused",
      lastRunAt: null,
      nextRunAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }
  }

  private register(task: ScheduledTask) {
    if (task.triggerType !== "schedule") return
    const job = new Cron(task.cron, { timezone: task.timezone }, () => this.launch(task))
    this.jobs.set(task.id, job)
  }

  private catchUp(task: ScheduledTask) {
    if (task.triggerType !== "schedule" || task.missedRunPolicy !== "run-once" || !task.lastRunAt) return
    const now = Date.now()
    const windowStart = now - task.catchUpWindowMinutes * 60_000
    const probe = new Cron(task.cron, { timezone: task.timezone, paused: true })
    const missed = probe.nextRun(new Date(Math.max(task.lastRunAt, windowStart) - 1))
    probe.stop()
    if (!missed || missed.getTime() <= task.lastRunAt || missed.getTime() > now) return
    void this.launch(task)
  }

  private launch(task: ScheduledTask, existingRunID?: string) {
    if (this.stopping) return Promise.resolve()
    const execution = this.execute(task, existingRunID)
    this.track(execution)
    return execution
  }

  private track(execution: Promise<void>) {
    this.activeExecutions.add(execution)
    void execution.then(
      () => this.activeExecutions.delete(execution),
      () => this.activeExecutions.delete(execution),
    )
  }

  private async execute(task: ScheduledTask, existingRunID?: string) {
    const skip = task.overlapPolicy === "skip"
    if (skip && !(await this.acquireTaskCapacity(task))) return
    const runID = existingRunID ?? this.createQueuedRun(task)
    if (!skip && !(await this.acquireTaskCapacity(task))) return
    let globalCapacity = false
    this.onChanged()
    try {
      await this.acquireCapacity()
      globalCapacity = true
      this.requireNotCancelled(runID)
      const dependencyError = this.dependencyError(task)
      if (dependencyError) {
        this.finishRun(runID, "blocked", dependencyError)
        this.announceRun(task, runID)
        return
      }
      const outcome = await this.executeWithRetry(task, 1, runID)
      if (!outcome.ok) {
        if (!outcome.cancelled) this.recordFailure(task.id, outcome.message)
        return
      }
      const now = Date.now()
      this.db().prepare("UPDATE scheduled_task SET last_run_at = ?, last_error = NULL, updated_at = ? WHERE id = ?")
        .run(now, now, task.id)
    } catch (error) {
      this.cancelledRuns.delete(runID)
      if (!(error instanceof ScheduledTaskCancelledError) && !(error instanceof ScheduledTaskStoppingError)) throw error
    } finally {
      this.releaseTaskCapacity(task.id)
      if (globalCapacity) this.releaseCapacity()
      this.onChanged()
    }
  }

  private async executeWithRetry(task: ScheduledTask, attempt: number, existingRunID?: string): Promise<AttemptResult> {
    const outcome = await this.executeAttempt(task, attempt, existingRunID)
    if (outcome.ok || !outcome.retryable || attempt > task.retryCount) {
      if (!isActiveStatus(this.getRun(outcome.runID).status)) this.announceRun(task, outcome.runID)
      return outcome
    }
    await delay(task.retryDelaySeconds * 1000)
    return this.executeWithRetry(task, attempt + 1)
  }

  private async executeAttempt(task: ScheduledTask, attempt: number, existingRunID?: string): Promise<AttemptResult> {
    const runID = existingRunID ?? crypto.randomUUID()
    const createdAt = Date.now()
    if (existingRunID) {
      this.db().prepare("UPDATE scheduled_task_run SET status = 'running', attempt = ?, updated_at = ? WHERE id = ?")
        .run(attempt, createdAt, runID)
    }
    if (!existingRunID) {
      this.db().prepare(`
        INSERT INTO scheduled_task_run (
          id, task_id, task_title, prompt, session_id, server_id, server_name, server_url, directory,
          execution_directory, execution_mode, worktree_directory, branch, permission_profile, attempt, model_provider_id,
          model_id, variant, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, 'running', ?)
      `).run(
        runID, task.id, task.title, task.prompt, `pending:${runID}`, task.serverId, task.serverName, task.serverUrl,
        task.directory, task.directory, task.executionMode, task.branch, task.permissionProfile, attempt,
        task.modelProviderID, task.modelID, task.variant, createdAt,
      )
    }
    this.onChanged()
    this.appendRunLog(runID, `Attempt ${attempt} started on ${task.serverName}`)

    let submitted = false
    let hookServer: ServerState | undefined
    try {
      const server = await this.resolveServer(task)
      this.requireNotCancelled(runID)
      if (!server) throw new Error(`Server is unavailable: ${task.serverName}`)
      hookServer = server
      await this.fetchJson(server, "/api/info")
      this.appendRunLog(runID, "Server health check passed")
      await this.runHooks(server, task.directory, "automation.before", runID)
      const execution = await this.prepareExecution(task, server)
      this.requireNotCancelled(runID)
      const query = execution.directory ? `?directory=${encodeURIComponent(execution.directory)}` : ""
      const session = await this.fetchJson<{ id?: string }>(server, `/api/session${query}`, {
        method: "POST",
        body: JSON.stringify({
          title: `[自动化] ${task.title}`,
          model: { id: task.modelID, providerID: task.modelProviderID, ...(task.variant ? { variant: task.variant } : {}) },
          permissions: permissionRules(task.permissionProfile),
          metadata: {
            scheduledTaskID: task.id,
            scheduledTaskRunID: runID,
            serverID: task.serverId,
            sourceDirectory: task.directory,
            executionMode: task.executionMode,
          },
        }),
      })
      if (!session.id) throw new Error("Create session returned no id")
      this.db().prepare("UPDATE scheduled_task_run SET session_id = ?, execution_directory = ?, worktree_directory = ?, branch = ? WHERE id = ?")
        .run(session.id, execution.directory, execution.worktreeDirectory, execution.branch, runID)
      await this.fetchJson(server, `/api/session/${encodeURIComponent(session.id)}/prompt`, {
        method: "POST",
        body: JSON.stringify({ text: task.prompt }),
      })
      submitted = true
      this.db().prepare("UPDATE scheduled_task_run SET status = 'submitted' WHERE id = ?").run(runID)
      this.appendRunLog(runID, `Session ${session.id} submitted`)
      this.onChanged()
      await this.waitForCompletion(server, session.id, execution.directory, task.completionTimeoutMinutes, runID)
      this.finishRun(runID, "completed", null)
      await this.runHooks(server, task.directory, "automation.after", runID)
      await this.runHooks(server, task.directory, "notification", runID)
      if (execution.worktreeDirectory && task.worktreeCleanup !== "never") await this.cleanupWorktree(server, task.directory, execution.worktreeDirectory, runID)
      return { ok: true, runID }
    } catch (error) {
      if (error instanceof ScheduledTaskStoppingError) {
        this.appendRunLog(runID, "Application is stopping; the session will be monitored after restart")
        return { ok: false, runID, message: error.message, retryable: false, cancelled: true }
      }
      const message = error instanceof Error ? error.message : String(error)
      const status: RunStatus = error instanceof ScheduledTaskCancelledError
        ? "cancelled"
        : error instanceof ScheduledTaskTimeoutError ? "timed_out" : "failed"
      this.finishRun(runID, status, message)
      if (hookServer) await this.runHooks(hookServer, task.directory, "automation.after", runID)
      if (hookServer) await this.runHooks(hookServer, task.directory, "notification", runID)
      const worktreeDirectory = this.getRun(runID).worktreeDirectory
      if (worktreeDirectory && task.worktreeCleanup === "always") await this.cleanupWorktree(await this.resolveServer(task), task.directory, worktreeDirectory, runID)
      return { ok: false, runID, message, retryable: !submitted && status !== "cancelled", cancelled: status === "cancelled" }
    } finally {
      this.cancelledRuns.delete(runID)
    }
  }

  private async prepareExecution(task: ScheduledTask, server: ServerState) {
    if (task.executionMode === "worktree") {
      const projectID = await this.projectID(server, task.directory)
      const existing = await this.fetchJson<Array<{ directory?: string }>>(
        server,
        `/api/worktree?projectID=${encodeURIComponent(projectID)}`,
      )
      if (existing.length >= 20) throw new Error("Worktree capacity reached (20). Clean up unused worktrees before running this automation.")
      const worktree = await this.fetchJson<{ directory?: string; branch?: string }>(server, `/api/worktree`, {
        method: "POST",
        body: JSON.stringify({
          projectID,
          name: `automation-${task.id.slice(0, 8)}-${Date.now().toString(36)}`,
          ...(task.branch ? { branch: task.branch } : {}),
        }),
      })
      if (!worktree.directory) throw new Error("Create worktree returned no directory")
      await delay(500)
      await this.fetchJson(server, `/api/vcs?directory=${encodeURIComponent(worktree.directory)}`)
      return { directory: worktree.directory, branch: worktree.branch ?? task.branch, worktreeDirectory: worktree.directory }
    }

    if (task.branch && task.directory) {
      await this.fetchJson(server, `/vcs/branch?directory=${encodeURIComponent(task.directory)}`, {
        method: "POST",
        body: JSON.stringify({ branch: task.branch }),
      })
    }
    return { directory: task.directory, branch: task.branch, worktreeDirectory: "" }
  }

  private async waitForCompletion(server: ServerState, sessionID: string, directory: string, timeoutMinutes: number, runID: string) {
    const deadline = Date.now() + timeoutMinutes * 60_000
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : ""
    let idlePolls = 0
    let pollErrors = 0
    await delay(1_000)
    while (Date.now() < deadline) {
      this.requireNotCancelled(runID)
      try {
        const statuses = await this.fetchJson<Record<string, { type?: string }>>(server, `/api/session/active`)
        pollErrors = 0
        if (statuses[sessionID]) {
          idlePolls = 0
        } else {
          idlePolls++
          if (idlePolls >= 2) {
            await this.requireSuccessfulSession(server, sessionID, query)
            this.appendRunLog(runID, "Session completed successfully")
            return
          }
        }
      } catch (error) {
        pollErrors++
        if (pollErrors >= 3) throw error
      }
      await delay(2_000)
    }
    throw new ScheduledTaskTimeoutError(`Task did not complete within ${timeoutMinutes} minutes`)
  }

  private async requireSuccessfulSession(server: ServerState, sessionID: string, query: string) {
    const messages = await this.fetchJson<Array<{ type?: string; error?: unknown }>>(
      server,
      `/api/session/${encodeURIComponent(sessionID)}/message`,
    )
    const assistant = messages.findLast((message) => message.type === "assistant")
    if (!assistant?.error) return
    const error = assistant.error
    if (typeof error === "object" && error && "message" in error && typeof error.message === "string") {
      throw new Error(error.message)
    }
    throw new Error(`Session failed: ${JSON.stringify(error)}`)
  }

  private async projectID(server: ServerState, directory: string): Promise<string> {
    const location = await this.fetchJson<{ project?: { id?: string } }>(
      server,
      `/api/location?location[directory]=${encodeURIComponent(directory)}`,
    )
    if (!location.project?.id) throw new Error("Location has no project")
    return location.project.id
  }

  private async fetchJson<T = unknown>(server: ServerState, path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers)
    headers.set("Accept", "application/json")
    if (init?.body) headers.set("Content-Type", "application/json")
    if (server.password) {
      headers.set("Authorization", `Basic ${Buffer.from(`${server.username ?? "opencode"}:${server.password}`).toString("base64")}`)
    }
    const response = await fetch(new URL(path, `${server.url.replace(/\/+$/, "")}/`), {
      ...init,
      headers,
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 2_000)
      throw new Error(detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`)
    }
    const body = await response.json() as T | { data: T }
    if (body && typeof body === "object" && "data" in body) return body.data
    return body
  }

  private recordFailure(id: string, message: string) {
    const now = Date.now()
    this.db().prepare("UPDATE scheduled_task SET last_run_at = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(now, message, now, id)
  }

  private createQueuedRun(task: ScheduledTask) {
    const runID = crypto.randomUUID()
    const now = Date.now()
    this.db().prepare(`
      INSERT INTO scheduled_task_run (
        id, task_id, task_title, prompt, session_id, server_id, server_name, server_url, directory,
        execution_directory, execution_mode, worktree_directory, branch, permission_profile, attempt, model_provider_id,
        model_id, variant, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, 1, ?, ?, ?, 'queued', ?, ?)
    `).run(
      runID, task.id, task.title, task.prompt, `pending:${runID}`, task.serverId, task.serverName, task.serverUrl,
      task.directory, task.directory, task.executionMode, task.branch, task.permissionProfile,
      task.modelProviderID, task.modelID, task.variant, now, now,
    )
    this.appendRunLog(runID, "Queued and waiting for scheduler capacity")
    return runID
  }

  private async cleanupWorktree(server: ServerState | undefined, sourceDirectory: string, worktreeDirectory: string, runID: string) {
    if (!server) return
    try {
      const projectID = await this.projectID(server, sourceDirectory)
      await this.fetchJson(server, `/api/worktree`, {
        method: "DELETE",
        body: JSON.stringify({ projectID, directory: worktreeDirectory, force: false }),
      })
      this.appendRunLog(runID, `Removed owned worktree ${worktreeDirectory}`)
      this.db().prepare("UPDATE scheduled_task_run SET worktree_directory = '' WHERE id = ?").run(runID)
    } catch (error) {
      this.appendRunLog(runID, `Worktree cleanup pending: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async runHooks(server: ServerState, directory: string, event: "automation.before" | "automation.after" | "notification", runID: string) {
    if (!directory) return
    const capabilities = await this.fetchJson<{ hooks?: boolean }>(server, `/experimental/capabilities?directory=${encodeURIComponent(directory)}`).catch(() => ({ hooks: false }))
    if (!capabilities.hooks) return
    const runs = await this.fetchJson<Array<{ hookName?: string; status?: string; output?: string }>>(
      server,
      `/experimental/hooks/run?directory=${encodeURIComponent(directory)}`,
      { method: "POST", body: JSON.stringify({ event }) },
    ).catch((error) => [{ hookName: "hooks", status: "failed", output: error instanceof Error ? error.message : String(error) }])
    runs.forEach((run) => this.appendRunLog(runID, `Hook ${run.hookName ?? "unknown"}: ${run.status ?? "unknown"}${run.output ? `\n${run.output}` : ""}`))
  }

  private getRun(id: string) {
    const row = this.db().prepare("SELECT * FROM scheduled_task_run WHERE id = ?").get(id) as Record<string, unknown> | undefined
    if (!row) throw new Error("Scheduled task run not found")
    return this.readRun(row)
  }

  private appendRunLog(id: string, message: string) {
    const timestamp = new Date().toISOString()
    this.db().prepare("UPDATE scheduled_task_run SET log = substr(log || ?, -2000000), updated_at = ? WHERE id = ?")
      .run(`${timestamp} ${message}\n`, Date.now(), id)
    this.onChanged()
  }

  private finishRun(id: string, status: RunStatus, error: string | null) {
    const now = Date.now()
    this.db().prepare("UPDATE scheduled_task_run SET status = ?, error = ?, completed_at = ?, updated_at = ? WHERE id = ?")
      .run(status, error, now, now, id)
    this.appendRunLog(id, error ? `${status}: ${error}` : status)
    this.onChanged()
    this.pruneHistory()
  }

  private announceRun(task: ScheduledTask, runID: string) {
    const run = this.getRun(runID)
    this.onFinished?.(run, task)
    if (task.notificationChannels.includes("webhook")) {
      void this.sendNotificationWebhook(task, run).catch((error) => {
        this.appendRunLog(runID, `Notification webhook failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    const trigger = run.status === "completed" ? "task-success" : run.status === "failed" || run.status === "timed_out" ? "task-failure" : undefined
    if (!trigger) return
    this.list().filter(candidate => candidate.enabled && candidate.triggerType === trigger && candidate.triggerTaskId === task.id)
      .forEach(candidate => void this.launch(candidate))
  }

  private async sendNotificationWebhook(task: ScheduledTask, run: ScheduledTaskRun) {
    const url = normalizeWebhookUrl(task.notificationWebhookUrl)
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "OpenCodex-Automation/1" },
      body: JSON.stringify({ event: "automation.finished", task: { id: task.id, title: task.title }, run: { id: run.id, sessionID: run.sessionID, status: run.status, error: run.error, completedAt: run.completedAt } }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    this.appendRunLog(run.id, "Notification webhook delivered")
  }

  private dependencyError(task: ScheduledTask) {
    const missing = task.dependencyTaskIds.filter(id => {
      const row = this.db().prepare("SELECT status FROM scheduled_task_run WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(id) as { status?: string } | undefined
      return row?.status !== "completed"
    })
    return missing.length ? `Dependencies have not completed successfully: ${missing.join(", ")}` : ""
  }

  private pruneHistory() {
    const database = this.db()
    database.prepare("DELETE FROM scheduled_task_run WHERE archived = 1 AND completed_at < ?")
      .run(Date.now() - this.historyRetentionDays * 24 * 60 * 60 * 1000)
    database.prepare(`
      DELETE FROM scheduled_task_run
      WHERE status NOT IN ('queued', 'running', 'submitted', 'recovering')
        AND id NOT IN (SELECT id FROM scheduled_task_run ORDER BY created_at DESC LIMIT ?)
    `).run(this.maxHistory)
  }

  private loadSettings() {
    const values = Object.fromEntries((this.db().prepare("SELECT key, value FROM scheduled_task_setting").all() as Array<{ key: string; value: string }>).map((item) => [item.key, Number(item.value)]))
    this.maxConcurrency = bounded(values.maxConcurrency, 1, 20, 3)
    this.historyRetentionDays = bounded(values.historyRetentionDays, 1, 365, 90)
    this.maxHistory = bounded(values.maxHistory, 100, 10000, 1000)
    this.webhookPort = bounded(values.webhookPort, 1024, 65535, 49832)
  }

  private startWebhookServer() {
    if (this.webhookServer) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const server = createServer((request, response) => void this.handleWebhookRequest(request, response))
      server.once("error", () => {
        this.webhookAddress = ""
        this.onChanged()
        resolve()
      })
      server.listen(this.webhookPort, "127.0.0.1", () => {
        this.webhookServer = server
        this.webhookAddress = `http://127.0.0.1:${this.webhookPort}`
        this.onChanged()
        resolve()
      })
    })
  }

  private stopWebhookServer() {
    const server = this.webhookServer
    this.webhookServer = undefined
    this.webhookAddress = ""
    if (!server) return Promise.resolve()
    return new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private handleWebhookRequest(request: IncomingMessage, response: ServerResponse) {
    request.resume()
    if (request.method !== "POST" || !request.url) {
      response.writeHead(405).end()
      return
    }
    const parts = new URL(request.url, this.webhookAddress || "http://127.0.0.1").pathname.split("/").filter(Boolean)
    if (parts.length !== 3 || parts[0] !== "automation") {
      response.writeHead(404).end()
      return
    }
    const taskID = parts[1]
    const secret = parts[2]
    const row = this.db().prepare("SELECT webhook_secret FROM scheduled_task WHERE id = ?").get(taskID) as { webhook_secret?: string } | undefined
    const expected = Buffer.from(row?.webhook_secret ?? "")
    const provided = Buffer.from(secret)
    if (!expected.length || expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      response.writeHead(404).end()
      return
    }
    const task = this.get(taskID)
    if (!task.enabled || task.triggerType !== "webhook") {
      response.writeHead(409).end()
      return
    }
    response.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify({ accepted: true, taskID }))
    void this.launch(task)
  }

  private requireNotCancelled(runID: string) {
    if (this.stopping) throw new ScheduledTaskStoppingError("Application is stopping")
    if (this.cancelledRuns.has(runID)) throw new ScheduledTaskCancelledError("Cancelled by user")
  }

  private acquireCapacity() {
    if (this.globalRunning < this.maxConcurrency) {
      this.globalRunning++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => this.capacityWaiters.push(() => {
      this.globalRunning++
      resolve()
    }))
  }

  private releaseCapacity() {
    this.globalRunning = Math.max(0, this.globalRunning - 1)
    this.capacityWaiters.shift()?.()
  }

  private async acquireTaskCapacity(task: ScheduledTask) {
    const limit = task.overlapPolicy === "parallel" ? task.maxConcurrentRuns : 1
    if (task.overlapPolicy === "skip" && (this.running.get(task.id) ?? 0) >= limit) return false
    while ((this.running.get(task.id) ?? 0) >= limit) {
      await new Promise<void>((resolve) => {
        const waiters = this.taskWaiters.get(task.id) ?? []
        waiters.push(resolve)
        this.taskWaiters.set(task.id, waiters)
      })
    }
    this.running.set(task.id, (this.running.get(task.id) ?? 0) + 1)
    return true
  }

  private releaseTaskCapacity(taskID: string) {
    const remaining = (this.running.get(taskID) ?? 1) - 1
    if (remaining > 0) this.running.set(taskID, remaining)
    if (remaining <= 0) this.running.delete(taskID)
    const waiters = this.taskWaiters.get(taskID)
    waiters?.shift()?.()
    if (waiters?.length === 0) this.taskWaiters.delete(taskID)
  }

  private async recoverInterruptedRuns() {
    const runs = this.listRunSummaries(undefined, RUN_SUMMARY_MAX_LIMIT, 0, false).data.filter((run) => isActiveStatus(run.status))
    await Promise.all(runs.map(async (run) => {
      if (run.status === "queued") {
        void this.launch(this.get(run.taskID), run.id)
        return
      }
      if (run.sessionID.startsWith("pending:")) {
        const task = this.get(run.taskID)
        this.finishRun(run.id, "failed", "Application stopped before the session was submitted")
        this.announceRun(task, run.id)
        return
      }
      const task = this.get(run.taskID)
      const server = await this.resolveServer(task)
      if (!server) {
        this.finishRun(run.id, "failed", `Server is unavailable: ${run.serverName}`)
        this.announceRun(task, run.id)
        return
      }
      this.db().prepare("UPDATE scheduled_task_run SET status = 'recovering', updated_at = ? WHERE id = ?").run(Date.now(), run.id)
      this.appendRunLog(run.id, "Recovering session monitoring after application restart")
      try {
        await this.waitForCompletion(server, run.sessionID, run.executionDirectory, task.completionTimeoutMinutes, run.id)
        this.finishRun(run.id, "completed", null)
        const now = Date.now()
        this.db().prepare("UPDATE scheduled_task SET last_run_at = ?, last_error = NULL, updated_at = ? WHERE id = ?")
          .run(now, now, task.id)
        await this.runHooks(server, task.directory, "notification", run.id)
        this.announceRun(task, run.id)
      } catch (error) {
        if (error instanceof ScheduledTaskStoppingError) {
          this.appendRunLog(run.id, "Recovery monitoring paused because the application is stopping")
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        this.finishRun(run.id, error instanceof ScheduledTaskCancelledError ? "cancelled" : error instanceof ScheduledTaskTimeoutError ? "timed_out" : "failed", message)
        this.recordFailure(task.id, message)
        await this.runHooks(server, task.directory, "notification", run.id)
        this.announceRun(task, run.id)
      }
    }))
  }

  private async cleanupOrphanedWorktrees() {
    const rows = this.db().prepare(`
      SELECT scheduled_task_run.id, scheduled_task_run.task_id, scheduled_task_run.directory,
        scheduled_task_run.worktree_directory, scheduled_task_run.status
      FROM scheduled_task_run
      JOIN scheduled_task ON scheduled_task.id = scheduled_task_run.task_id
      WHERE scheduled_task_run.worktree_directory != ''
        AND (scheduled_task_run.status = 'completed' OR scheduled_task.worktree_cleanup = 'always')
    `).all() as Array<Record<string, unknown>>
    await Promise.all(rows.map(async (row) => {
      const task = this.get(String(row.task_id))
      await this.cleanupWorktree(
        await this.resolveServer(task),
        String(row.directory),
        String(row.worktree_directory),
        String(row.id),
      )
    }))
  }
}

class ScheduledTaskTimeoutError extends Error {}
class ScheduledTaskCancelledError extends Error {}
class ScheduledTaskStoppingError extends Error {}

function isActiveStatus(status: RunStatus) {
  return status === "queued" || status === "running" || status === "submitted" || status === "recovering"
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function normalizeExecutionMode(value: unknown): ExecutionMode {
  return value === "worktree" ? "worktree" : "current"
}

function normalizeWorktreeCleanup(value: unknown): WorktreeCleanup {
  if (value === "always" || value === "never") return value
  return "on-success"
}

function normalizePermissionProfile(value: unknown): PermissionProfile {
  if (value === "ask" || value === "writes" || value === "full") return value
  return "risk"
}

function normalizeOverlapPolicy(value: unknown): OverlapPolicy {
  if (value === "queue" || value === "parallel") return value
  return "skip"
}

function normalizeMissedRunPolicy(value: unknown): MissedRunPolicy {
  return value === "run-once" ? "run-once" : "skip"
}

function normalizeTriggerType(value: unknown): TriggerType {
  if (value === "task-success" || value === "task-failure" || value === "webhook") return value
  return "schedule"
}

function stringArray(value: unknown) {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string")
  if (typeof value !== "string") return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

function notificationChannels(value: unknown): NotificationChannel[] {
  const channels = stringArray(value).filter((item): item is NotificationChannel => item === "desktop" || item === "webhook")
  return [...new Set(channels)]
}

function normalizeServerUrl(value: string) {
  const normalized = value.trim().replace(/\/+$/, "")
  if (!URL.canParse(normalized)) throw new Error("Server URL is invalid")
  const url = new URL(normalized)
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Server URL must use HTTP or HTTPS")
  if (url.username || url.password) throw new Error("Server URL must not contain credentials")
  return normalized
}

function normalizeWebhookUrl(value: string) {
  const normalized = value.trim()
  if (!URL.canParse(normalized)) throw new Error("Notification webhook URL is invalid")
  const url = new URL(normalized)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1"))) {
    throw new Error("Notification webhook URL must use HTTPS (HTTP is only allowed for loopback addresses)")
  }
  if (url.username || url.password) throw new Error("Notification webhook URL must not contain credentials")
  return normalized
}

function bounded(value: number, minimum: number, maximum: number, fallback: number) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback
}

function permissionRules(profile: PermissionProfile) {
  if (profile === "full") return [{ action: "*", resource: "*", effect: "allow" }]
  if (profile === "ask") return [{ action: "*", resource: "*", effect: "ask" }]
  if (profile === "writes") {
    return [
      { action: "edit", resource: "*", effect: "ask" },
      { action: "bash", resource: "*", effect: "ask" },
      { action: "sandbox", resource: "*", effect: "ask" },
    ]
  }
  return [{ action: "sandbox", resource: "*", effect: "ask" }]
}
