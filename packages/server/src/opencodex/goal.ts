import { Path } from "@opencode/util/global"
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises"
import path from "node:path"

export type GoalStatus = "active" | "paused" | "complete" | "blocked"

export type GoalHistoryEntry = {
  type: "created" | "updated" | "paused" | "resumed" | "completed" | "blocked" | "cleared"
  detail: string
  timestamp: number
}

export type Goal = {
  sessionID: string
  objective: string
  status: GoalStatus
  step: number
  statusMessage: string | null
  createdAt: number
  updatedAt: number
  pausedAt: number | null
  completedAt: number | null
  evidence: string | null
  blocker: string | null
  history: GoalHistoryEntry[]
}

type GoalState = {
  version: 1
  goals: Record<string, Goal>
}

function goalStatePath() {
  return path.join(Path.data, "goal", "goals.json")
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

function emptyState(): GoalState {
  return { version: 1, goals: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function normalizeGoal(sessionID: string, value: unknown): Goal | undefined {
  if (!isRecord(value)) return
  if (typeof value.objective !== "string") return
  if (!["active", "paused", "complete", "blocked"].includes(String(value.status))) return
  const now = nowSeconds()
  return {
    sessionID,
    objective: value.objective,
    status: value.status as GoalStatus,
    step: typeof value.step === "number" && value.step > 0 ? Math.floor(value.step) : 1,
    statusMessage: typeof value.statusMessage === "string" ? value.statusMessage : null,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : now,
    pausedAt: typeof value.pausedAt === "number" ? value.pausedAt : null,
    completedAt: typeof value.completedAt === "number" ? value.completedAt : null,
    evidence: typeof value.evidence === "string" ? value.evidence : null,
    blocker: typeof value.blocker === "string" ? value.blocker : null,
    history: Array.isArray(value.history)
      ? value.history.flatMap((item) => {
          if (!isRecord(item)) return []
          if (typeof item.type !== "string" || typeof item.detail !== "string" || typeof item.timestamp !== "number") return []
          if (!["created", "updated", "paused", "resumed", "completed", "blocked", "cleared"].includes(item.type)) return []
          return [item as GoalHistoryEntry]
        })
      : [],
  }
}

async function readState(): Promise<GoalState> {
  try {
    const parsed = JSON.parse(await readFile(goalStatePath(), "utf8")) as unknown
    if (!isRecord(parsed) || !isRecord(parsed.goals)) return emptyState()
    return {
      version: 1,
      goals: Object.fromEntries(
        Object.entries(parsed.goals).flatMap(([sessionID, value]) => {
          const goal = normalizeGoal(sessionID, value)
          return goal ? [[sessionID, goal]] : []
        }),
      ),
    }
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return emptyState()
    throw error
  }
}

async function writeState(state: GoalState) {
  const file = goalStatePath()
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
  await rename(tmp, file)
  await chmod(file, 0o600).catch(() => undefined)
}

async function mutateGoal<T>(sessionID: string, update: (state: GoalState, now: number) => T | Promise<T>) {
  const state = await readState()
  const result = await update(state, nowSeconds())
  await writeState(state)
  return result
}

function history(type: GoalHistoryEntry["type"], detail: string, timestamp: number): GoalHistoryEntry {
  return { type, detail, timestamp }
}

function snapshot(goal: Goal | null) {
  return goal ? { ...goal, history: [...goal.history] } : null
}

export async function getGoal(sessionID: string) {
  return snapshot((await readState()).goals[sessionID] ?? null)
}

export async function createGoal(sessionID: string, objective: string, options?: { paused?: boolean }) {
  const trimmed = objective.trim()
  if (!trimmed) throw new Error("Goal objective is required")
  return mutateGoal(sessionID, (state, now) => {
    const existing = state.goals[sessionID]
    if (existing && existing.status !== "complete" && existing.status !== "blocked") {
      throw new Error("A goal is already active for this session")
    }
    const goal: Goal = {
      sessionID,
      objective: trimmed,
      status: options?.paused ? "paused" : "active",
      step: 1,
      statusMessage: "目标已创建",
      createdAt: now,
      updatedAt: now,
      pausedAt: options?.paused ? now : null,
      completedAt: null,
      evidence: null,
      blocker: null,
      history: [history("created", trimmed, now)],
    }
    state.goals[sessionID] = goal
    return snapshot(goal)
  })
}

export async function updateGoalProgress(sessionID: string, input: { step?: number; statusMessage?: string }) {
  return mutateGoal(sessionID, (state, now) => {
    const goal = state.goals[sessionID]
    if (!goal) throw new Error("No goal exists for this session")
    if (goal.status !== "active" && goal.status !== "paused") throw new Error("Goal is already closed")
    if (input.step && input.step > goal.step) goal.step = Math.floor(input.step)
    if (input.statusMessage?.trim()) goal.statusMessage = input.statusMessage.trim()
    goal.updatedAt = now
    goal.history.push(history("updated", goal.statusMessage ?? `第 ${goal.step} 步`, now))
    goal.history = goal.history.slice(-50)
    return snapshot(goal)
  })
}

export async function setGoalStatus(sessionID: string, status: "active" | "paused") {
  return mutateGoal(sessionID, (state, now) => {
    const goal = state.goals[sessionID]
    if (!goal) throw new Error("No goal exists for this session")
    if (goal.status !== "active" && goal.status !== "paused") throw new Error("Goal is already closed")
    goal.status = status
    goal.pausedAt = status === "paused" ? now : null
    goal.updatedAt = now
    goal.history.push(history(status === "paused" ? "paused" : "resumed", status, now))
    goal.history = goal.history.slice(-50)
    return snapshot(goal)
  })
}

export async function closeGoal(sessionID: string, input: { status: "complete" | "blocked"; evidence?: string; blocker?: string }) {
  return mutateGoal(sessionID, (state, now) => {
    const goal = state.goals[sessionID]
    if (!goal) throw new Error("No goal exists for this session")
    goal.status = input.status
    goal.completedAt = now
    goal.updatedAt = now
    goal.evidence = input.evidence?.trim() || null
    goal.blocker = input.blocker?.trim() || null
    goal.statusMessage = input.status === "complete" ? "目标已完成" : "目标已阻塞"
    goal.history.push(history(input.status === "complete" ? "completed" : "blocked", goal.statusMessage, now))
    goal.history = goal.history.slice(-50)
    return snapshot(goal)
  })
}

export async function clearGoal(sessionID: string) {
  return mutateGoal(sessionID, (state) => {
    const existed = !!state.goals[sessionID]
    delete state.goals[sessionID]
    return existed
  })
}
