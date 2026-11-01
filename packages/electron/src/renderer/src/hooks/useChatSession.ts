// ============================================
// useChatSession - 聊天会话管理
// ============================================

import { useState, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import {
  messageStore,
  useSessionFamily,
  useSessionState,
  autoApproveStore,
  childSessionStore,
  useActiveSessionStore,
  type RevertHistoryItem,
} from '../store'
import { approvalPermissionRules } from '../store/autoApproveStore'
import {
  useSessionManager,
  registerSessionConsumer,
  updateConsumerSessionId,
  hasOtherConsumerForSession,
} from '../hooks'
import { usePermissions, usePermissionHandler, useMessageAnimation, useDirectory, useSessionContext } from '../hooks'
import { useNotification } from './useNotification'
import { notificationEventSettingsStore } from '../store/notificationEventSettingsStore'
import { notificationStore } from '../store/notificationStore'
import { questionAutoContinueStore, QUESTION_AUTO_CONTINUE_TIMEOUT_MS } from '../store/questionAutoContinueStore'
import {
  sendMessageAsync,
  getCurrentProject,
  getSessionMessages,
  abortSession,
  getSelectableAgents,
  onAgentsChanged,
  getPendingPermissions,
  getPendingQuestions,
  prefetchCommands,
  prefetchRootDirectory,
  getSessionChildren,
  executeCommand,
  summarizeSession,
  reloadConfig,
  updateSession,
  createWorktree,
  forkSession,
  extractUserMessageContent,
  type ApiPermissionRequest,
  type ApiQuestionRequest,
  type ApiSession,
  type ApiAgent,
  type Attachment,
  type ModelInfo,
  type SessionErrorPayload,
} from '../api'
import { getMessageText, isUserMessage, type AssistantMessageInfo, type Message as UIMessage } from '../types/message'
import { clipboardErrorHandler, copyTextToClipboard, createErrorHandler, isMissingDirectoryError, isSameDirectory } from '../utils'
import { clearSessionRuntimeState } from '../utils/sessionLifecycle'
import { serverStorage } from '../utils/perServerStorage'
import { STORAGE_KEY_SELECTED_AGENT } from '../constants'
import type { ChatAreaHandle } from '../features/chat'
import { followupQueueStore, useFollowupQueue } from '../store/followupQueueStore'
import { themeStore } from '../store/themeStore'
import { pinnedSessionsStore } from '../store/pinnedSessionsStore'
import { createTaskFromCommand } from '../api/task'
import { executionTargetStore } from '../store/executionTargetStore'
import { serverStore } from '../store/serverStore'
import i18n from '../i18n'
import { selectableAgentsInDisplayOrder } from '../features/chat/agentOrder'

const handleError = createErrorHandler('session')

/**
 * Stable empty session state singleton.
 *
 * When routeSessionId is null (e.g. an empty split pane), useChatSession
 * uses this instead of creating a new object on every render.  A fresh
 * literal `{ messages: [], ... }` would give a different reference each
 * time, defeating React.memo on ChatArea and causing pointless re-renders
 * of the entire message tree.
 */
const EMPTY_SESSION_STATE = {
  messages: [] as import('../types/message').Message[],
  isStreaming: false,
  loadState: 'idle' as const,
  loadError: undefined,
  revertState: null,
  canUndo: false,
  canRedo: false,
  redoSteps: 0,
  revertedContent: null,
  hasMoreHistory: false,
  directory: '',
  title: null,
} as const

const COMPLETED_NOTIFICATION_MAX_LENGTH = 180

interface UseChatSessionOptions {
  paneId: string
  chatAreaRef: React.RefObject<ChatAreaHandle | null>
  currentModel: ModelInfo | undefined
  selectedVariant?: string
  refetchModels: () => Promise<void>
  sessionId: string | null
  navigateToSession: (sessionId: string, directory?: string) => void
  navigateHome: (directory?: string | null) => void
}

interface LiveRetryStatus {
  sessionID: string
  attempt: number
  message: string
  next: number
}

interface ModelRecovery {
  failedModel: string
}

function isUnavailableModelError(error: unknown) {
  const data =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
          ? error.message
          : ''
  return /(?:unknown|invalid|unavailable|retired|inactive|disabled|not found|does not exist).{0,80}(?:model|provider)|(?:model|provider).{0,80}(?:unknown|invalid|unavailable|retired|inactive|disabled|not found|does not exist)/i.test(data)
}

function buildCompletedNotificationBody(messages: UIMessage[]) {
  const lastAssistant = [...messages].reverse().find(message => message.info.role === 'assistant')
  const text = lastAssistant ? getMessageText(lastAssistant).replace(/\s+/g, ' ').trim() : ''

  if (!text) return i18n.t('chat:notification.completedBody')
  if (text.length <= COMPLETED_NOTIFICATION_MAX_LENGTH) return text
  return `${text.slice(0, COMPLETED_NOTIFICATION_MAX_LENGTH).trimEnd()}.....`
}

function buildPermissionNotificationBody(request: ApiPermissionRequest) {
  const pattern = request.patterns?.[0]
  if (pattern) return i18n.t('chat:notification.permissionBodyPattern', { permission: request.permission, pattern })
  return i18n.t('chat:notification.permissionBody', { permission: request.permission })
}

function buildQuestionNotificationBody(request: ApiQuestionRequest) {
  return request.questions?.[0]?.header || i18n.t('chat:notification.questionWaiting')
}

// 「提问自动继续」超时后的自动回复：每个问题取第一个选项（模型通常把首选放第一），
// 无选项的问题回一个中性的 continue，让助手继续而非中断
function buildAutoContinueAnswers(request: ApiQuestionRequest): string[][] {
  return request.questions.map(question => {
    const first = question.options[0]?.label
    return first ? [first] : ['continue']
  })
}

function buildErrorNotificationBody(error: SessionErrorPayload) {
  if (typeof error.data === 'string' && error.data.trim()) return error.data.trim()
  if (error.name && error.name !== 'UnknownError') return i18n.t('chat:notification.errorType', { name: error.name })
  return i18n.t('chat:notification.executionError')
}

export function useChatSession({
  paneId,
  chatAreaRef,
  currentModel,
  selectedVariant,
  refetchModels,
  sessionId: routeSessionId,
  navigateToSession,
  navigateHome,
}: UseChatSessionOptions) {
  const { statusMap } = useActiveSessionStore()
  const { queueFollowupMessages } = useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot)

  // Agents
  const [agents, setAgents] = useState<ApiAgent[]>([])
  const [selectedAgent, setSelectedAgentRaw] = useState<string>(
    () => serverStorage.get(`${STORAGE_KEY_SELECTED_AGENT}:${paneId}`) || '',
  )
  const [restoredContent, setRestoredContent] = useState<{ sessionId: string; content: RevertHistoryItem } | null>(null)
  const [modelRecovery, setModelRecovery] = useState<ModelRecovery | null>(null)

  const setSelectedAgent = useCallback(
    (agentName: string) => {
      setSelectedAgentRaw(agentName)
      serverStorage.set(`${STORAGE_KEY_SELECTED_AGENT}:${paneId}`, agentName)
    },
    [paneId],
  )

  // Hooks
  const { resetPermissions } = usePermissions()
  const { currentDirectory, pathInfo } = useDirectory()
  const { createSession, sessions } = useSessionContext()
  const { sendNotification } = useNotification()

  const routeStatus = routeSessionId ? statusMap[routeSessionId] : undefined
  const routeSessionIdRef = useRef(routeSessionId)

  useEffect(() => {
    routeSessionIdRef.current = routeSessionId
  }, [routeSessionId])

  const handleMissingRouteSession = useCallback(
    (missingSessionId: string) => {
      if (routeSessionIdRef.current !== missingSessionId) return
      clearSessionRuntimeState(missingSessionId)
      navigateHome()
    },
    [navigateHome],
  )

  const {
    items: queuedFollowups,
    sendingId: queuedFollowupSendingId,
    failedId: queuedFollowupFailedId,
  } = useFollowupQueue(routeSessionId)

  const perSessionStateRaw = useSessionState(routeSessionId)
  const perSessionState = perSessionStateRaw ?? EMPTY_SESSION_STATE

  const messages = perSessionState.messages
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const isStreaming = perSessionState.isStreaming
  const sessionDirectory = perSessionState.directory
  const canUndo = perSessionState.canUndo
  const canRedo = perSessionState.canRedo
  const redoSteps = perSessionState.redoSteps
  const revertedContent = perSessionState.revertedContent
  const hasMoreHistory = perSessionState.hasMoreHistory
  const loadState = routeSessionId ? perSessionState.loadState : ('idle' as const)
  const loadError = routeSessionId ? perSessionState.loadError : undefined

  // OpenAPI SessionStatus.retry: { attempt, message, next }
  const retryStatus = useMemo<LiveRetryStatus | null>(() => {
    if (!routeSessionId || routeStatus?.type !== 'retry') return null
    return {
      sessionID: routeSessionId,
      attempt: routeStatus.attempt,
      message: routeStatus.message,
      next: routeStatus.next,
    }
  }, [routeSessionId, routeStatus])

  const isSessionBusy = useMemo(() => Boolean(routeStatus) || isStreaming, [routeStatus, isStreaming])

  const getSessionTitle = useCallback(
    (sessionId?: string) => {
      const session = sessions.find(s => s.id === sessionId)
      if (session?.title) return session.title
      if (sessionId) return `Session ${sessionId.slice(0, 6)}`
      return 'OpenCode'
    },
    [sessions],
  )

  const buildNotificationTitle = useCallback(
    (sessionId: string | undefined, label: string) => {
      const base = getSessionTitle(sessionId)
      return `${base} - ${label}`
    },
    [getSessionTitle],
  )

  // Session family for permission polling
  const sessionFamily = useSessionFamily(routeSessionId)

  // Session Manager
  const { loadSession, loadMoreHistory, handleUndo, handleRedo, handleRedoAll, clearRevert } = useSessionManager({
    sessionId: routeSessionId,
    directory: currentDirectory || pathInfo?.directory,
    onSessionMissing: handleMissingRouteSession,
  })

  // Permission handling
  const {
    pendingPermissionRequests,
    pendingQuestionRequests,
    setPendingPermissionRequests,
    setPendingQuestionRequests,
    handlePermissionReply,
    handleQuestionReply,
    handleQuestionReject,
    refreshPendingRequests,
    resetPendingRequests,
    isReplying,
  } = usePermissionHandler()

  // Prevent infinite retry loops when auto-approve API calls fail
  // but the server may have already processed the request (lost response).
  const autoRetriedIdsRef = useRef(new Set<string>())

  // “提问自动继续”计时器：开启后助手提问 5 分钟未作答则自动 reject 让助手继续
  const questionAutoContinueTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const clearQuestionAutoContinueTimer = useCallback((requestId: string) => {
    const timer = questionAutoContinueTimers.current.get(requestId)
    if (timer === undefined) return
    clearTimeout(timer)
    questionAutoContinueTimers.current.delete(requestId)
  }, [])

  // 卸载时清理所有“提问自动继续”计时器，避免对已结束的提问误触发 reject
  useEffect(() => {
    return () => {
      questionAutoContinueTimers.current.forEach(timer => clearTimeout(timer))
      questionAutoContinueTimers.current.clear()
    }
  }, [])

  // Message animations
  const { registerMessage, registerInputBox, animateUndo, animateRedo } = useMessageAnimation()

  // Effective directory (used in multiple places)
  const effectiveDirectory = sessionDirectory || currentDirectory || pathInfo?.directory
  const routeDirectoryForSession = useCallback(
    (directory: string | undefined) => {
      if (!directory) return ''
      if (pathInfo?.directory && isSameDirectory(directory, pathInfo.directory)) return ''
      return directory
    },
    [pathInfo?.directory],
  )

  // 「提问自动继续」布防：以 pending 问题列表为唯一事实来源统一布防。
  // 覆盖两类来源——SSE question.asked 新增的问题，以及应用重启/断线重连后
  // refreshPendingRequests 恢复的挂起问题（此时 SSE 事件不会重放）。
  // 开关状态在布防时读取：提问挂起期间切换开关不影响已布防的计时器。
  useEffect(() => {
    const pendingIds = new Set(pendingQuestionRequests.map(request => request.id))

    // 先清掉已不在 pending 中的计时器（回复/拒绝完成后防残留误触发）
    for (const [requestId, timer] of questionAutoContinueTimers.current) {
      if (!pendingIds.has(requestId)) {
        clearTimeout(timer)
        questionAutoContinueTimers.current.delete(requestId)
      }
    }

    if (!questionAutoContinueStore.enabled) return
    for (const request of pendingQuestionRequests) {
      if (questionAutoContinueTimers.current.has(request.id)) continue
      const timer = setTimeout(() => {
        questionAutoContinueTimers.current.delete(request.id)
        // 超时自动回复（而非 reject）：reject 在服务端会被当作“用户拒绝并中断”，
        // 助手回合直接停止；回复则让回合继续。默认取每个问题的第一个选项——
        // 模型通常把首选放在第一，无选项的问题回一个中性的 continue
        void handleQuestionReply(request.id, buildAutoContinueAnswers(request), effectiveDirectory)
      }, QUESTION_AUTO_CONTINUE_TIMEOUT_MS)
      questionAutoContinueTimers.current.set(request.id, timer)
    }
  }, [pendingQuestionRequests, effectiveDirectory, handleQuestionReply])

  const fullAutoMode = useSyncExternalStore(
    cb => autoApproveStore.onFullAutoChange(cb),
    () => autoApproveStore.getPaneFullAutoMode(paneId),
  )
  const approvePendingOnFullAuto = useSyncExternalStore(
    autoApproveStore.subscribe,
    () => autoApproveStore.approvePendingOnFullAuto,
  )

  const replyPermissionOnceAutomatically = useCallback(
    (request: ApiPermissionRequest) => {
      if (!autoApproveStore.claimAutoReply(request.id)) return

      void handlePermissionReply(request.id, 'once', effectiveDirectory, request.sessionID).then(success => {
        if (!success) {
          autoApproveStore.releaseAutoReply(request.id)
          // Retry once on failure. handlePermissionReply already retries 3× via withRetry,
          // but the server may have processed the request and the response was lost.
          // Force effect re-run by creating a new array reference.
          if (!autoRetriedIdsRef.current.has(request.id)) {
            autoRetriedIdsRef.current.add(request.id)
            setPendingPermissionRequests(prev => [...prev])
          }
        }
      })
    },
    [effectiveDirectory, handlePermissionReply, setPendingPermissionRequests],
  )

  // Clear retry tracking on each auto-approve batch
  useEffect(() => {
    autoRetriedIdsRef.current.clear()
  }, [approvePendingOnFullAuto, fullAutoMode])

  useEffect(() => {
    if (!routeSessionId || !approvePendingOnFullAuto || fullAutoMode !== 'session') return
    void refreshPendingRequests(sessionFamily, effectiveDirectory)
  }, [
    approvePendingOnFullAuto,
    effectiveDirectory,
    fullAutoMode,
    refreshPendingRequests,
    routeSessionId,
    sessionFamily,
  ])

  useEffect(() => {
    if (!approvePendingOnFullAuto || fullAutoMode === 'off' || pendingPermissionRequests.length === 0) return

    for (const request of pendingPermissionRequests) {
      replyPermissionOnceAutomatically(request)
    }
  }, [approvePendingOnFullAuto, fullAutoMode, pendingPermissionRequests, replyPermissionOnceAutomatically])

  // ============================================
  // SSE 事件回调（permission / question / scroll / idle / error / reconnect）
  // 每个 pane 都注册自己的 consumer，由 App 顶层统一建立 SSE 连接
  // ============================================
  const sseCallbacks = useMemo(
    () => ({
      onPermissionAsked: (request: ApiPermissionRequest) => {
        // Full Auto 会话级：当前 session 的 handler 天然只处理当前 session 的请求
        const effectiveFullAutoMode = autoApproveStore.getPaneFullAutoMode(paneId)
        if (effectiveFullAutoMode === 'session') {
          replyPermissionOnceAutomatically(request)
          return
        }

        // 自动批准检查（实验性功能）
        if (
          autoApproveStore.enabled &&
          autoApproveStore.shouldAutoApprove(request.sessionID, request.permission, request.patterns)
        ) {
          // 匹配规则，自动用 once 批准，不弹框
          replyPermissionOnceAutomatically(request)
          return
        }

        setPendingPermissionRequests(prev => {
          if (prev.some(r => r.id === request.id)) return prev
          return [...prev, request]
        })

        // 页面不在前台时通知用户有权限请求等待批准
        if (notificationEventSettingsStore.isSystemEnabled('permission')) {
          sendNotification(
            buildNotificationTitle(request.sessionID, i18n.t('chat:notification.permissionTitle')),
            buildPermissionNotificationBody(request),
            {
              sessionId: request.sessionID,
              directory: effectiveDirectory,
            },
          )
        }
        // 应用内 toast 已在 useGlobalEvents 中统一处理
      },
      onPermissionReplied: (data: { sessionID: string; requestID: string }) => {
        setPendingPermissionRequests(prev =>
          prev.some(r => r.id === data.requestID) ? prev.filter(r => r.id !== data.requestID) : prev,
        )
      },
      onQuestionAsked: (request: ApiQuestionRequest) => {
        setPendingQuestionRequests(prev => {
          if (prev.some(r => r.id === request.id)) return prev
          return [...prev, request]
        })

        // 「提问自动继续」计时器统一由 pendingQuestionRequests 监听 effect 布防，
        // 这样应用重启/重连后经 refreshPendingRequests 恢复的挂起问题同样会被布防

        // 页面不在前台时通知用户有问题等待回答
        if (notificationEventSettingsStore.isSystemEnabled('question')) {
          sendNotification(
            buildNotificationTitle(request.sessionID, i18n.t('chat:notification.questionTitle')),
            buildQuestionNotificationBody(request),
            {
              sessionId: request.sessionID,
              directory: effectiveDirectory,
            },
          )
        }
        // 应用内 toast 已在 useGlobalEvents 中统一处理
      },
      onQuestionReplied: (data: { sessionID: string; requestID: string }) => {
        clearQuestionAutoContinueTimer(data.requestID)
        setPendingQuestionRequests(prev => prev.filter(r => r.id !== data.requestID))
      },
      onQuestionRejected: (data: { sessionID: string; requestID: string }) => {
        clearQuestionAutoContinueTimer(data.requestID)
        setPendingQuestionRequests(prev => prev.filter(r => r.id !== data.requestID))
      },
      onScrollRequest: () => {
        chatAreaRef.current?.scrollToBottomIfAtBottom()
      },
      onSessionIdle: (sessionID: string) => {
        // 页面不在前台时发送浏览器通知
        if (notificationEventSettingsStore.isSystemEnabled('completed')) {
          sendNotification(
            getSessionTitle(sessionID),
            buildCompletedNotificationBody(messageStore.getVisibleMessages(sessionID)),
            {
              sessionId: sessionID,
              directory: effectiveDirectory,
            },
          )
        }
        // 应用内 toast 已在 useGlobalEvents 中统一处理
      },
      onSessionError: (error: SessionErrorPayload) => {
        // 页面不在前台时通知用户 session 出错
        if (notificationEventSettingsStore.isSystemEnabled('error')) {
          sendNotification(
            buildNotificationTitle(error.sessionID, i18n.t('chat:notification.errorTitle')),
            buildErrorNotificationBody(error),
            {
              sessionId: error.sessionID,
              directory: effectiveDirectory,
            },
          )
        }
        // 应用内 toast 已在 useGlobalEvents 中统一处理
      },
      onReconnected: (_reason: 'network' | 'server-switch') => {
        messageStore.markAllSessionsStale()

        // SSE 重连后重新加载当前会话，补齐断连期间可能丢失的消息
        if (routeSessionId) {
          // 使用 force 模式，确保覆盖本地可能不完整的数据
          loadSession(routeSessionId, { force: true })
          // 重连后刷新待处理的权限请求和问题，避免用户错过后台产生的请求
          refreshPendingRequests(sessionFamily, effectiveDirectory)
        }
        refetchModels().catch(() => {})
        // 重新获取 agents 列表（切换后端时 currentDirectory 可能没变，useEffect 不会触发）
        getSelectableAgents(currentDirectory)
          .then(setAgents)
          .catch(() => {})
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs and stable functions
    [
      paneId,
      effectiveDirectory,
      routeSessionId,
      sessionFamily,
      currentDirectory,
      replyPermissionOnceAutomatically,
      setPendingPermissionRequests,
      setPendingQuestionRequests,
      buildNotificationTitle,
      getSessionTitle,
      sendNotification,
      loadSession,
      refreshPendingRequests,
      refetchModels,
      clearQuestionAutoContinueTimer,
    ],
  )

  // 保存 callbacks ref 供 consumer 注册使用（避免频繁重新注册）
  const sseCallbacksRef = useRef(sseCallbacks)
  useEffect(() => {
    sseCallbacksRef.current = sseCallbacks
  }, [sseCallbacks])

  // 注册 pane 级 consumer，SSE 事件按 sessionId 分发到此
  useEffect(() => {
    const unregister = registerSessionConsumer(paneId, routeSessionId, {
      onPermissionAsked: req => sseCallbacksRef.current.onPermissionAsked(req),
      onPermissionReplied: data => sseCallbacksRef.current.onPermissionReplied(data),
      onQuestionAsked: req => sseCallbacksRef.current.onQuestionAsked(req),
      onQuestionReplied: data => sseCallbacksRef.current.onQuestionReplied(data),
      onQuestionRejected: data => sseCallbacksRef.current.onQuestionRejected(data),
      onScrollRequest: () => sseCallbacksRef.current.onScrollRequest(),
      onSessionIdle: sid => sseCallbacksRef.current.onSessionIdle(sid),
      onSessionError: error => sseCallbacksRef.current.onSessionError(error),
      onReconnected: reason => sseCallbacksRef.current.onReconnected(reason),
    })

    return unregister
  }, [paneId, routeSessionId])

  // sessionId 变化时更新 consumer 关注的 session（无需重新注册）
  useEffect(() => {
    updateConsumerSessionId(paneId, routeSessionId)
  }, [paneId, routeSessionId])

  const handleVisibleMessageIdsChange = useCallback((_ids: string[]) => {
    // No-op: parts are always in memory now
  }, [])

  // Load agents
  useEffect(() => {
    const load = () => {
      getSelectableAgents(currentDirectory)
        .then(setAgents)
        .catch(err => handleError('fetch agents', err))
    }
    load()
    return onAgentsChanged(load)
  }, [currentDirectory])

  // Preload @ root directory and / commands for current session directory
  useEffect(() => {
    if (!routeSessionId || !effectiveDirectory) return

    prefetchRootDirectory(effectiveDirectory).catch(() => {})
    prefetchCommands(effectiveDirectory).catch(() => {})
  }, [routeSessionId, effectiveDirectory])

  // agents 列表加载后，校验当前选中的 agent 是否存在于列表中
  useEffect(() => {
    if (agents.length === 0) return
    const primaryAgents = selectableAgentsInDisplayOrder(agents)
    if (primaryAgents.length === 0) return

    // 当前选中的 agent 在列表中存在就不动
    if (selectedAgent && primaryAgents.some(a => a.name === selectedAgent)) return

    // 否则选第一个 primary agent
    const frameId = requestAnimationFrame(() => {
      setSelectedAgent(primaryAgents[0].name)
    })

    return () => cancelAnimationFrame(frameId)
  }, [agents, selectedAgent, setSelectedAgent])

  // Load child sessions and pending permissions on session change
  // 页面刷新时 childSessionStore 是空的，需要先从 API 恢复子 session 关系
  // 然后再加载权限请求（包括子 session 的权限）
  useEffect(() => {
    if (!routeSessionId) {
      resetPendingRequests()
      return
    }

    let cancelled = false

    async function loadChildSessionsAndPermissions() {
      // Step 1: 恢复子 session 关系（如果 store 中还没有）
      const existingChildren = childSessionStore.getChildSessionIds(routeSessionId!)
      if (existingChildren.length === 0) {
        try {
          const children = await getSessionChildren(routeSessionId!, effectiveDirectory)
          if (cancelled) return
          // 注册所有子 session 到 store
          for (const child of children) {
            childSessionStore.registerChildSession(child)
          }
        } catch {
          // 获取子 session 失败不影响主流程
        }
      }

      if (cancelled) return

      // Step 2: 获取完整的 session family（主 session + 所有子孙）
      const family = new Set(childSessionStore.getSessionAndDescendants(routeSessionId!))

      // Step 3: 获取所有待处理请求，然后用 family 过滤
      // GET /permission 和 GET /question 返回全量数据，不传 sessionId 避免 N 次重复请求
      const [allPerms, allQuestions] = await Promise.all([
        getPendingPermissions(undefined, effectiveDirectory).catch(() => []),
        getPendingQuestions(undefined, effectiveDirectory).catch(() => []),
      ])

      if (cancelled) return

      // 只保留属于当前 session family 的请求。
      // OMO background subagents may publish permission.asked over SSE before
      // /permission can list it for this routed instance, so do not drop
      // SSE-known requests just because the snapshot is missing them.
      const nextPerms = allPerms.filter(p => family.has(p.sessionID))
      setPendingPermissionRequests(prev => {
        const merged = new Map(nextPerms.map(p => [p.id, p]))
        for (const request of prev) {
          if (family.has(request.sessionID) && !merged.has(request.id)) merged.set(request.id, request)
        }
        return Array.from(merged.values())
      })
      setPendingQuestionRequests(allQuestions.filter(q => family.has(q.sessionID)))
    }

    loadChildSessionsAndPermissions()

    return () => {
      cancelled = true
    }
  }, [
    routeSessionId,
    effectiveDirectory,
    resetPendingRequests,
    setPendingPermissionRequests,
    setPendingQuestionRequests,
  ])

  const sendMessageNow = useCallback(
    async (input: {
      sessionId?: string | null
      content: string
      attachments: Attachment[]
      directory: string
      model: { providerID: string; modelID: string }
      options?: { agent?: string; variant?: string; delivery?: 'steer' | 'queue' }
      allowCreateSession?: boolean
    }) => {
      let sessionId = input.sessionId ?? routeSessionId
      const serverId = serverStore.getActiveServerId()
      const fallbackTarget = {
        serverId,
        directory: input.directory,
        executionMode: 'current' as const,
      }
      let executionTarget = sessionId
        ? executionTargetStore.getSession(serverId, sessionId) ?? fallbackTarget
        : executionTargetStore.resolveDraft(paneId, fallbackTarget)
      let executionDirectory = executionTarget.directory

      if (sessionId && input.allowCreateSession) {
        const state = messageStore.getSessionState(sessionId)
        if (state?.loadState === 'error' && state.messages.length === 0) {
          clearSessionRuntimeState(sessionId)
          sessionId = null
        }
      }

      let rollbackSnapshot = sessionId ? messageStore.createSendRollbackSnapshot(sessionId) : null
      if (sessionId && !executionTargetStore.getSession(serverId, sessionId)) {
        executionTargetStore.bindSession(sessionId, executionTarget)
      }

      try {
        if (!sessionId && executionTarget.executionMode === 'worktree' && !executionTarget.worktreeId) {
          if (!executionTarget.directory) throw new Error('Choose a Git project before creating an isolated worktree')
          const project = await getCurrentProject(executionTarget.directory)
          if (project.vcs !== 'git' || !project.worktree) {
            throw new Error('Isolated worktrees are only available for Git projects')
          }
          const worktree = await createWorktree({ name: `task-${Date.now().toString(36)}` }, project.worktree)
          if (!worktree.directory) throw new Error('Worktree creation returned no directory')
          executionTarget = {
            ...executionTarget,
            sourceDirectory: executionTarget.sourceDirectory || executionTarget.directory,
            directory: worktree.directory,
            worktreeId: worktree.directory,
            branch: worktree.branch ?? executionTarget.branch,
          }
          executionDirectory = worktree.directory
          executionTargetStore.updateDraft(paneId, executionTarget)
        }

        // 在创建或继续会话前确认目录仍然可被当前 Server 访问。否则 promptAsync 会异步失败，
        // 用户只能看到“没有回复”，而无法知道项目目录已经被删除或移动。
        if (executionDirectory) {
          try {
            await getCurrentProject(executionDirectory)
          } catch (error) {
            const missing = isMissingDirectoryError(error)
            notificationStore.push(
              'error',
              missing ? i18n.t('chat:notification.directoryUnavailableTitle') : i18n.t('chat:notification.directoryAccessTitle'),
              missing
                ? i18n.t('chat:notification.directoryUnavailable', { directory: executionDirectory })
                : error instanceof Error ? error.message : i18n.t('chat:notification.directoryAccessHint'),
              sessionId ?? '',
              executionDirectory,
            )
            return false
          }
        }

        if (!sessionId) {
          if (!input.allowCreateSession) return false
          const newSession = await createSession(undefined, executionTarget)
          sessionId = newSession.id
          executionTargetStore.clearDraft(paneId)
          navigateToSession(sessionId, routeDirectoryForSession(newSession.directory))
        }

        if (rollbackSnapshot) {
          messageStore.truncateAfterRevert(sessionId)
        }

        messageStore.setStreaming(sessionId, true)

        await updateSession(
          sessionId,
          { permission: approvalPermissionRules(autoApproveStore.getApprovalMode(paneId)) },
          executionDirectory,
        )

        // 记录发送前的消息数量，作为判断 SSE 是否推送新消息的基线
        const msgCountBeforeSend = messageStore.getSessionState(sessionId)?.messages.length ?? 0

        await sendMessageAsync({
          sessionId,
          text: input.content,
          attachments: input.attachments,
          model: input.model,
          agent: input.options?.agent,
          variant: input.options?.variant,
          delivery: input.options?.delivery,
          directory: executionDirectory,
        })

        setModelRecovery(null)

        // 兜底：等待短暂时间后检查 SSE 是否已推送用户消息，
        // 若未收到则主动拉取补齐，避免 SSE 断流导致用户消息不显示
        const pullSessionId = sessionId
        const pullDir = executionDirectory
        setTimeout(() => {
          const state = messageStore.getSessionState(pullSessionId)
          if (!state) return
          // 消息数量增加了，说明 SSE 已正常推送
          if (state.messages.length > msgCountBeforeSend) return

          getSessionMessages(pullSessionId, 5, pullDir)
            .then(apiMessages => {
              for (const msg of apiMessages) {
                messageStore.handleMessageUpdated(msg.info)
                if (msg.parts) {
                  for (const part of msg.parts) {
                    messageStore.handlePartUpdated({
                      ...part,
                      sessionID: pullSessionId,
                      messageID: msg.info.id,
                    })
                  }
                }
              }
            })
            .catch(() => {
              // 拉取失败不影响主流程，SSE 重连后仍可补齐
            })
        }, 1500)

        return true
      } catch (error) {
        handleError('send message', error)
        if (isUnavailableModelError(error)) {
          setModelRecovery({ failedModel: `${input.model.providerID}/${input.model.modelID}` })
          notificationStore.push(
            'error',
            i18n.t('chat:notification.modelUnavailableTitle'),
            i18n.t('chat:notification.modelUnavailableBody', { model: `${input.model.providerID}/${input.model.modelID}` }),
            sessionId ?? '',
            input.directory,
          )
          void refetchModels()
        }
        if (sessionId) {
          if (rollbackSnapshot) {
            messageStore.restoreSendRollback(sessionId, rollbackSnapshot)
            rollbackSnapshot = null
          } else {
            messageStore.setStreaming(sessionId, false)
          }
        }

        return false
      }
    },
    [routeSessionId, navigateToSession, createSession, routeDirectoryForSession, paneId, refetchModels],
  )

  // Send message handler
  const handleSend = useCallback(
    async (
      content: string,
      attachments: Attachment[],
      options?: { agent?: string; variant?: string; delivery?: 'steer' | 'queue' },
    ) => {
      if (!currentModel) {
        handleError('send message', new Error('No model selected'))
        return false
      }

      // 如果队列头有失败项，用户重新发送时先清掉失败项（内容已恢复到输入框）
      if (routeSessionId && queuedFollowupFailedId) {
        followupQueueStore.remove(routeSessionId, queuedFollowupFailedId)
      }

      const shouldQueueFollowup =
        !!routeSessionId &&
        options?.delivery !== 'steer' &&
        (queuedFollowups.length > 0 ||
          ((options?.delivery === 'queue' || queueFollowupMessages) && isSessionBusy))

      if (shouldQueueFollowup) {
        followupQueueStore.enqueue({
          sessionId: routeSessionId,
          directory: effectiveDirectory || '',
          text: content,
          attachments,
          model: {
            providerID: currentModel.providerId,
            modelID: currentModel.id,
            variant: options?.variant,
          },
          variant: options?.variant,
          agent: options?.agent,
        })
        return true
      }

      return sendMessageNow({
        sessionId: routeSessionId,
        content,
        attachments,
        model: {
          providerID: currentModel.providerId,
          modelID: currentModel.id,
        },
        options,
        directory: effectiveDirectory || '',
        allowCreateSession: true,
      })
    },
    [
      currentModel,
      routeSessionId,
      queuedFollowups.length,
      queuedFollowupFailedId,
      queueFollowupMessages,
      isSessionBusy,
      effectiveDirectory,
      sendMessageNow,
    ],
  )

  const sendQueuedFollowup = useCallback(
    async (draftId: string, sessionId: string, delivery?: 'steer') => {
      const draft = followupQueueStore.getItem(sessionId, draftId)
      if (!draft) return false
      if (!followupQueueStore.startSending(draft.sessionId, draft.id)) return false

      const ok = await sendMessageNow({
        sessionId: draft.sessionId,
        content: draft.text,
        attachments: draft.attachments,
        model: {
          providerID: draft.model.providerID,
          modelID: draft.model.modelID,
        },
        options: {
          agent: draft.agent,
          variant: draft.variant,
          delivery,
        },
        directory: draft.directory,
      })

      followupQueueStore.finishSending(draft.sessionId, draft.id)

      if (ok) {
        followupQueueStore.remove(draft.sessionId, draft.id)
      } else {
        // 标记失败，阻塞后续队列项
        followupQueueStore.markFailed(draft.sessionId, draft.id)
        setRestoredContent({
          sessionId: draft.sessionId,
          content: {
            messageId: draft.id,
            text: draft.text,
            attachments: draft.attachments,
            model: draft.model,
            variant: draft.variant ?? draft.model.variant,
            agent: draft.agent,
          },
        })
      }

      return ok
    },
    [sendMessageNow],
  )

  const handleQueuedFollowupRemove = useCallback(
    (draftId: string) => {
      if (!routeSessionId) return
      followupQueueStore.remove(routeSessionId, draftId)
    },
    [routeSessionId],
  )

  const handleQueuedFollowupUpdate = useCallback(
    (draftId: string, text: string) => {
      if (!routeSessionId) return false
      return followupQueueStore.update(routeSessionId, draftId, text)
    },
    [routeSessionId],
  )

  const handleQueuedFollowupMove = useCallback(
    (draftId: string, direction: -1 | 1) => {
      if (!routeSessionId) return
      followupQueueStore.move(routeSessionId, draftId, direction)
    },
    [routeSessionId],
  )

  const handleQueuedFollowupSteer = useCallback(
    (draftId: string) => {
      if (!routeSessionId) return Promise.resolve(false)
      return sendQueuedFollowup(draftId, routeSessionId, 'steer')
    },
    [routeSessionId, sendQueuedFollowup],
  )

  useEffect(() => {
    if (!routeSessionId) return

    const nextQueued = queuedFollowups[0]
    if (!nextQueued) return
    if (queuedFollowupSendingId) return
    if (queuedFollowupFailedId) return
    if (isSessionBusy) return

    void sendQueuedFollowup(nextQueued.id, routeSessionId)
  }, [
    routeSessionId,
    queuedFollowups,
    queuedFollowupSendingId,
    queuedFollowupFailedId,
    isSessionBusy,
    sendQueuedFollowup,
  ])

  // New chat handler
  const handleNewChat = useCallback(() => {
    if (routeSessionId) {
      followupQueueStore.clearSession(routeSessionId)
      if (!hasOtherConsumerForSession(routeSessionId, paneId)) {
        messageStore.clearSession(routeSessionId)
      }
    }
    resetPermissions()
    resetPendingRequests()
  }, [routeSessionId, paneId, resetPermissions, resetPendingRequests])

  const handleForkMessage = useCallback(
    async (message: UIMessage, forkMessageId?: string) => {
      const targetMessageId = forkMessageId || message.info.id

      try {
        if (message.info.role === 'assistant') {
          const assistantInfo = message.info as AssistantMessageInfo
          // 后端 fork 语义：messageID 指定的消息**不包含**在新 session 里。
          // 要保留这条 assistant 回复，需要传它之后的下一条用户消息 ID；
          // 如果它已经是最末尾，不传 messageID，fork 整个 session。
          const currentMessages = messagesRef.current
          const idx = currentMessages.findIndex(m => m.info.id === targetMessageId)
          let forkAtMessageId: string | undefined
          if (idx >= 0) {
            for (let i = idx + 1; i < currentMessages.length; i++) {
              if (currentMessages[i].info.role === 'user') {
                forkAtMessageId = currentMessages[i].info.id
                break
              }
            }
          }
          const forkedSession = await forkSession(assistantInfo.sessionID, forkAtMessageId, effectiveDirectory)
          setRestoredContent(null)
          navigateToSession(forkedSession.id, routeDirectoryForSession(forkedSession.directory))
          return
        }

        if (message.info.role !== 'user') return

        if (!isUserMessage(message.info)) return

        const userInfo = message.info
        const content = extractUserMessageContent(message)
        const forkedSession = await forkSession(userInfo.sessionID, targetMessageId, effectiveDirectory)

        setRestoredContent({
          sessionId: forkedSession.id,
          content: {
            messageId: userInfo.id,
            text: content.text,
            attachments: content.attachments,
            model: userInfo.model,
            variant: userInfo.model.variant,
            agent: userInfo.agent,
          },
        })

        navigateToSession(forkedSession.id, routeDirectoryForSession(forkedSession.directory))
      } catch (error) {
        handleError('fork session', error)
      }
    },
    [effectiveDirectory, navigateToSession, routeDirectoryForSession],
  )

  // Abort handler
  const handleAbort = useCallback(async () => {
    if (!routeSessionId) return
    try {
      const directory = sessionDirectory || currentDirectory
      await abortSession(routeSessionId, directory)
      messageStore.handleSessionIdle(routeSessionId)
    } catch (error) {
      handleError('abort session', error)
    }
  }, [routeSessionId, sessionDirectory, currentDirectory])

  // Command handler (slash commands)
  const handleCommand = useCallback(
    async (commandStr: string) => {
      // 解析命令："/help arg1 arg2" => command="help", args="arg1 arg2"
      const trimmed = commandStr.trim()
      const withoutSlash = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed
      const spaceIndex = withoutSlash.indexOf(' ')
      const command = spaceIndex > 0 ? withoutSlash.slice(0, spaceIndex) : withoutSlash
      const args = spaceIndex > 0 ? withoutSlash.slice(spaceIndex + 1) : ''

      if (!command) return false

      if (command === 'new') {
        navigateHome()
        handleNewChat()
        return true
      }

      if (command === 'task') {
        try {
          const task = await createTaskFromCommand(args, effectiveDirectory, currentModel, selectedVariant)
          void window.customOpenCode.sendNotification({ title: i18n.t('chat:notification.taskCreatedTitle'), body: `${task.title} · ${task.cron}` })
          return true
        } catch (err) {
          handleError('create scheduled task', err)
          return false
        }
      }

      if (command === 'reload') {
        try {
          await reloadConfig()
          await refetchModels()
          const reloadedAgents = await getSelectableAgents(effectiveDirectory)
          setAgents(reloadedAgents)
          return true
        } catch (err) {
          handleError('reload configuration', err)
          return false
        }
      }

      let sessionId = routeSessionId

      try {
        if (sessionId) {
          const state = messageStore.getSessionState(sessionId)
          if (state?.loadState === 'error' && state.messages.length === 0) {
            clearSessionRuntimeState(sessionId)
            sessionId = null
          }
        }

        // Create session if needed (like handleSend does)
        if (!sessionId) {
          const executionTarget = executionTargetStore.resolveDraft(paneId, {
            serverId: serverStore.getActiveServerId(),
            directory: effectiveDirectory ?? '',
            executionMode: 'current',
          })
          const newSession = await createSession(undefined, executionTarget)
          sessionId = newSession.id
          executionTargetStore.clearDraft(paneId)
          navigateToSession(sessionId, routeDirectoryForSession(newSession.directory))
        }

        if (command === 'compact') {
          if (!currentModel) {
            handleError('execute command', new Error('No model selected'))
            return false
          }

          // Commands should count as sent once they are accepted for execution.
          // Do not keep the draft alive until the long-running compaction finishes.
          void summarizeSession(
            sessionId,
            { providerID: currentModel.providerId, modelID: currentModel.id },
            effectiveDirectory,
          ).catch(err => {
            handleError('execute command', err)
          })

          return true
        }

        // Keep command submission semantics aligned with normal messages:
        // once the command is dispatched, clear the draft immediately.
        void executeCommand(sessionId, command, args, effectiveDirectory).catch(err => {
          handleError('execute command', err)
        })

        return true
      } catch (err) {
        handleError('execute command', err)
        return false
      }
    },
    [
      routeSessionId,
      effectiveDirectory,
      createSession,
      navigateToSession,
      routeDirectoryForSession,
      currentModel,
      selectedVariant,
      navigateHome,
      handleNewChat,
    ],
  )

  // Undo with animation
  const handleUndoWithAnimation = useCallback(
    async (userMessageId: string) => {
      const currentMessages = messagesRef.current
      const messageIndex = currentMessages.findIndex(m => m.info.id === userMessageId)
      if (messageIndex === -1) return

      const messageIdsToRemove = currentMessages.slice(messageIndex).map(m => m.info.id)

      await animateUndo(messageIdsToRemove)
      await handleUndo(userMessageId)
    },
    [animateUndo, handleUndo],
  )

  // Redo with animation
  const handleRedoWithAnimation = useCallback(async () => {
    await animateRedo()
    await handleRedo()
  }, [animateRedo, handleRedo])

  // Session selection
  const handleSelectSession = useCallback(
    (session: ApiSession) => {
      navigateToSession(session.id, routeDirectoryForSession(session.directory))
    },
    [navigateToSession, routeDirectoryForSession],
  )

  // New session
  const handleNewSession = useCallback(() => {
    navigateHome()
    handleNewChat()
  }, [navigateHome, handleNewChat])

  // Archive current session
  const handleArchiveSession = useCallback(async () => {
    if (!routeSessionId) return
    try {
      await updateSession(routeSessionId, { time: { archived: Date.now() } }, effectiveDirectory)
      if (typeof window.customOpenCode?.setTaskRunArchived === 'function') await window.customOpenCode.setTaskRunArchived(routeSessionId, true)
      pinnedSessionsStore.unpin(routeSessionId)
      executionTargetStore.removeSession(serverStore.getActiveServerId(), routeSessionId)
      navigateHome()
      handleNewChat()
    } catch (error) {
      handleError('archive session', error)
    }
  }, [routeSessionId, effectiveDirectory, navigateHome, handleNewChat])

  // Navigate to previous session
  const handlePreviousSession = useCallback(() => {
    if (!sessions.length) return
    const currentIndex = sessions.findIndex(s => s.id === routeSessionId)
    if (currentIndex > 0) {
      const target = sessions[currentIndex - 1]
      navigateToSession(target.id, routeDirectoryForSession(target.directory))
    } else if (currentIndex === -1 && sessions.length > 0) {
      // Not in any session, go to first
      navigateToSession(sessions[0].id, routeDirectoryForSession(sessions[0].directory))
    }
  }, [sessions, routeSessionId, navigateToSession, routeDirectoryForSession])

  // Navigate to next session
  const handleNextSession = useCallback(() => {
    if (!sessions.length) return
    const currentIndex = sessions.findIndex(s => s.id === routeSessionId)
    if (currentIndex >= 0 && currentIndex < sessions.length - 1) {
      const target = sessions[currentIndex + 1]
      navigateToSession(target.id, routeDirectoryForSession(target.directory))
    }
  }, [sessions, routeSessionId, navigateToSession, routeDirectoryForSession])

  // Toggle agent (cycle through primary agents only, matching toolbar display)
  const handleToggleAgent = useCallback(() => {
    const primaryAgents = selectableAgentsInDisplayOrder(agents)
    if (primaryAgents.length <= 1) return
    const currentIndex = primaryAgents.findIndex(a => a.name === selectedAgent)
    const nextIndex = (currentIndex + 1) % primaryAgents.length
    setSelectedAgent(primaryAgents[nextIndex].name)
  }, [agents, selectedAgent, setSelectedAgent])

  // 从消息中恢复 agent 选择（用于切换 session 时）
  const restoreAgentFromMessage = useCallback(
    (agentName: string | null | undefined) => {
      if (!agentName) return
      // 只有当 agent 存在于列表中时才恢复
      const exists = agents.some(a => a.name === agentName && a.mode !== 'subagent' && !a.hidden)
      if (exists) {
        setSelectedAgent(agentName)
      }
    },
    [agents, setSelectedAgent],
  )

  // Copy last AI response to clipboard
  const handleCopyLastResponse = useCallback(async () => {
    const lastAssistant = [...messages].reverse().find(m => m.info.role === 'assistant')
    if (!lastAssistant) return

    const text = getMessageText(lastAssistant)
    if (text) {
      try {
        await copyTextToClipboard(text)
      } catch (err) {
        clipboardErrorHandler('copy last response', err)
      }
    }
  }, [messages])

  const clearRestoredContent = useCallback(() => {
    setRestoredContent(null)
    clearRevert()
  }, [clearRevert])

  const activeRestoredContent = useMemo(() => {
    if (!restoredContent || restoredContent.sessionId !== routeSessionId) return null
    return restoredContent.content
  }, [restoredContent, routeSessionId])

  return {
    // State
    messages,
    isStreaming,
    sessionDirectory,
    canUndo,
    canRedo,
    redoSteps,
    revertedContent,
    restoredContent: activeRestoredContent,
    loadState,
    loadError,
    hasMoreHistory,
    retryStatus,
    modelRecovery,
    agents,
    selectedAgent,
    setSelectedAgent,
    routeSessionId,
    effectiveDirectory,

    // Permissions
    pendingPermissionRequests,
    pendingQuestionRequests,
    queuedFollowups,
    queuedFollowupSendingId,
    handleQueuedFollowupRemove,
    handleQueuedFollowupUpdate,
    handleQueuedFollowupMove,
    handleQueuedFollowupSteer,
    handlePermissionReply,
    handleQuestionReply,
    handleQuestionReject,
    isReplying,

    // Session management
    loadMoreHistory,
    handleRedoAll,
    clearRevert: clearRestoredContent,
    clearModelRecovery: () => setModelRecovery(null),

    // Animation
    registerMessage,
    registerInputBox,

    // Handlers
    handleSend,
    handleAbort,
    handleCommand,
    handleUndoWithAnimation,
    handleRedoWithAnimation,
    handleForkMessage,
    handleSelectSession,
    handleNewSession,
    handleVisibleMessageIdsChange,
    handleArchiveSession,
    handlePreviousSession,
    handleNextSession,
    handleToggleAgent,
    handleCopyLastResponse,
    restoreAgentFromMessage,
  }
}
