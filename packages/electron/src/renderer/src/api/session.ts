// ============================================
// Session API Functions
// 基于 @opencode-ai/sdk: /session 相关接口
// ============================================

import { getSDKClient, unwrap } from './sdk'
import { normalizeTodoItems } from './todo'
import { formatPathForApi } from '../utils/directoryUtils'
import { getSessionMessages } from './message'
import { normalizeFileDiffs } from '../types/api/file'
import type { ApiSession, SessionListParams, FileDiff, ApiMessageWithParts, ApiUserMessage } from './types'
import type { SessionStatusMap } from '../types/api/session'
import type { TodoItem } from '../types/api/event'
import type { Todo as SDKTodo } from '../types/api/legacy-sdk'
import type { SessionPermissionRule } from '../store/autoApproveStore'

const SESSION_LIST_CACHE_DURATION = 250
const BACKGROUND_SESSION_LIST_CACHE_DURATION = 30000
type SessionListRequest = {
  background?: boolean
  expiresAt: number
  value?: ApiSession[]
  promise?: Promise<ApiSession[]>
}
const sessionListRequests = new WeakMap<object, Map<string, SessionListRequest>>()

function normalizeSessionList(value: unknown): ApiSession[] {
  if (Array.isArray(value)) return value as ApiSession[]
  throw new Error('Invalid OpenCode session list response')
}

export function isScheduledTaskSession(session: Pick<ApiSession, 'title'>) {
  return session.title.startsWith('[自动化] ') || session.title.startsWith('[定时任务] ')
}

export function isExternalChannelSession(session: Pick<ApiSession, 'metadata'>) {
  const channels = session.metadata?.['opencodex.externalChannels']
  return Array.isArray(channels) && channels.some(channel => typeof channel === 'string' && channel.length > 0)
}

// ============================================
// Session Status & Diff
// ============================================

/**
 * 获取所有 session 的当前状态
 */
export async function getSessionStatus(directory?: string): Promise<SessionStatusMap> {
  const sdk = getSDKClient()
  return unwrap(await sdk.session.status({ directory: formatPathForApi(directory) }))
}

/**
 * 获取 session 的 diff
 * - 传 messageId：返回该消息的 diff
 * - 不传 messageId：聚合所有用户消息的 diff（session 级别）
 */
export async function getSessionDiff(sessionId: string, directory?: string, messageId?: string): Promise<FileDiff[]> {
  const sdk = getSDKClient()
  if (messageId) {
    return normalizeFileDiffs(
      unwrap(
        await sdk.session.diff({
          sessionID: sessionId,
          directory: formatPathForApi(directory),
          messageID: messageId,
        }),
      ),
    )
  }
  // 无 messageId 时聚合所有用户消息的 diff
  const messages = await getSessionMessages(sessionId, undefined, directory)
  const userMessages = messages.filter(isUserMessage)
  const allDiffs: FileDiff[] = []
  for (const msg of userMessages) {
    const diffs = normalizeFileDiffs(msg.info.summary?.diffs)
    allDiffs.push(...diffs)
  }
  return allDiffs
}

function isUserMessage(message: ApiMessageWithParts): message is ApiMessageWithParts & { info: ApiUserMessage } {
  return message.info.role === 'user'
}

/**
 * 获取当前可见用户消息对应的本轮 diff
 */
export async function getLastTurnDiff(sessionId: string, directory?: string): Promise<FileDiff[]> {
  const [session, messages] = await Promise.all([
    getSession(sessionId, directory),
    getSessionMessages(sessionId, undefined, directory),
  ])

  const userMessages = messages.filter(isUserMessage)
  const revertMessageId = session.revert?.messageID
  const visibleUserMessages = revertMessageId
    ? userMessages.filter(message => message.info.id < revertMessageId)
    : userMessages

  return normalizeFileDiffs(visibleUserMessages.at(-1)?.info.summary?.diffs)
}

// ============================================
// Session CRUD
// ============================================

/**
 * 获取 session 列表
 */
export async function getSessions(params: SessionListParams = {}): Promise<ApiSession[]> {
  const sdk = getSDKClient()
  const { directory, roots, start, search, limit, archived } = params
  const query = {
    directory: formatPathForApi(directory),
    roots,
    start,
    search,
    limit,
    archived,
  }
  const key = JSON.stringify(query)
  const requests = sessionListRequests.get(sdk) ?? new Map<string, SessionListRequest>()
  sessionListRequests.set(sdk, requests)

  const now = Date.now()
  const background = document.visibilityState === 'hidden'
  requests.forEach((request, requestKey) => {
    if (!request.promise && request.expiresAt <= now) requests.delete(requestKey)
  })
  const cached = requests.get(key)
  if (cached?.promise) return cached.promise
  if (cached?.value && cached.expiresAt > now && (background || !cached.background)) return cached.value

  const promise = sdk.session
    .list(query)
    .then(result => normalizeSessionList(unwrap(result)))
    .then(value => {
      requests.set(key, {
        background,
        value,
        expiresAt:
          Date.now() + (background ? BACKGROUND_SESSION_LIST_CACHE_DURATION : SESSION_LIST_CACHE_DURATION),
      })
      return value
    })
    .catch(error => {
      requests.delete(key)
      throw error
    })
  requests.set(key, { promise, expiresAt: 0 })
  return promise
}

/**
 * 获取所有项目的 session。用于展示不应随项目目录分组的外部渠道会话。
 */
export async function getGlobalSessions(params: SessionListParams = {}): Promise<ApiSession[]> {
  const sdk = getSDKClient()
  const { directory, roots, start, search, limit, archived } = params
  return unwrap(
    await sdk.experimental.session.list({
      directory: formatPathForApi(directory),
      roots,
      start,
      search,
      limit,
      archived,
    }),
  )
}

/**
 * 获取单个 session
 */
export async function getSession(sessionId: string, directory?: string): Promise<ApiSession> {
  if (!sessionId?.trim()) throw new Error('Session ID is required')
  const sdk = getSDKClient()
  return unwrap(await sdk.session.get({ sessionID: sessionId, directory: formatPathForApi(directory) }))
}

/**
 * 创建 session
 */
export async function createSession(
  params: {
    directory?: string
    title?: string
    parentID?: string
    serverId?: string
  } = {},
): Promise<ApiSession> {
  const sdk = getSDKClient(params.serverId)
  const { directory, title, parentID } = params
  return unwrap(
    await sdk.session.create({
      directory: formatPathForApi(directory),
      title,
      parentID,
    }),
  )
}

/**
 * 更新 session
 */
export async function updateSession(
  sessionId: string,
  params: { title?: string; permission?: SessionPermissionRule[]; time?: { archived?: number }; unarchive?: boolean },
  directory?: string,
): Promise<ApiSession> {
  const sdk = getSDKClient()
  return unwrap(
    await sdk.session.update({
      sessionID: sessionId,
      directory: formatPathForApi(directory),
      ...params,
    }),
  )
}

export function archiveSession(sessionId: string, directory?: string) {
  return updateSession(sessionId, { time: { archived: Date.now() } }, directory)
}

export function restoreSession(sessionId: string, directory?: string) {
  return updateSession(sessionId, { unarchive: true }, directory)
}

/**
 * 删除 session
 */
export async function deleteSession(sessionId: string, directory?: string): Promise<boolean> {
  const sdk = getSDKClient()
  unwrap(await sdk.session.delete({ sessionID: sessionId, directory: formatPathForApi(directory) }))
  return true
}

// ============================================
// Session Actions
// ============================================

/**
 * 中止 session
 */
export async function abortSession(sessionId: string, directory?: string): Promise<boolean> {
  const sdk = getSDKClient()
  unwrap(await sdk.session.abort({ sessionID: sessionId, directory: formatPathForApi(directory) }))
  return true
}

/**
 * 回退消息
 */
export async function revertMessage(
  sessionId: string,
  messageId: string,
  partId?: string,
  directory?: string,
): Promise<ApiSession> {
  const sdk = getSDKClient()
  return unwrap(
    await sdk.session.revert({
      sessionID: sessionId,
      directory: formatPathForApi(directory),
      messageID: messageId,
      partID: partId,
    }),
  )
}

/**
 * 恢复已回退的消息
 */
export async function unrevertSession(sessionId: string, directory?: string): Promise<ApiSession> {
  const sdk = getSDKClient()
  return unwrap(await sdk.session.unrevert({ sessionID: sessionId, directory: formatPathForApi(directory) }))
}

/**
 * Fork session
 */
export async function forkSession(sessionId: string, messageId?: string, directory?: string): Promise<ApiSession> {
  const sdk = getSDKClient()
  return unwrap(
    await sdk.session.fork({
      sessionID: sessionId,
      directory: formatPathForApi(directory),
      messageID: messageId,
    }),
  )
}

/**
 * 总结 session
 */
export async function summarizeSession(
  sessionId: string,
  params: { providerID: string; modelID: string; auto?: boolean },
  directory?: string,
): Promise<boolean> {
  const sdk = getSDKClient()
  unwrap(
    await sdk.session.summarize({
      sessionID: sessionId,
      directory: formatPathForApi(directory),
      ...params,
    }),
  )
  return true
}

/**
 * 获取子 session
 */
export async function getSessionChildren(sessionId: string, directory?: string): Promise<ApiSession[]> {
  const sdk = getSDKClient()
  return unwrap(await sdk.session.children({ sessionID: sessionId, directory: formatPathForApi(directory) }))
}

/**
 * Session Todo
 */
export type ApiTodo = TodoItem

/**
 * 获取 session 的 todo 列表
 * SDK 的 Todo 没有 id 字段，用 index+content+status 合成
 */
export async function getSessionTodos(sessionId: string, directory?: string): Promise<ApiTodo[]> {
  const sdk = getSDKClient()
  const todos = unwrap<SDKTodo[]>(await sdk.session.todo({ sessionID: sessionId, directory: formatPathForApi(directory) }))
  return normalizeTodoItems(todos)
}
