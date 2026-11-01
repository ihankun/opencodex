/**
 * ChatPane — The single chat surface primitive.
 *
 * Single-pane and split-pane both render ChatPane. The only difference is displayMode:
 * single mode uses the full header and app viewport, split mode uses PaneHeader and a
 * compact viewport wrapper.
 */

import { memo, useRef, useEffect, useState, useCallback, useMemo, useDeferredValue } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { ChatArea, Header, InputBox, PermissionDialog, QuestionDialog, type ChatAreaHandle } from '.'
import { FreeLimitDialog } from './FreeLimitDialog'
import { AlertCircleIcon, CheckIcon, CircleIcon, CloseIcon, FileIcon, PatchIcon, PlugIcon, SpinnerIcon } from '../../components/Icons'
import { type ModelSelectorHandle } from './ModelSelector'
import { OutlineIndex, type OutlineIndexHandle } from '../../components/OutlineIndex'
import { PaneHeader } from './PaneHeader'
import { PaneDropOverlay, resolveDropZone, type DropZone, type PaneDropOverlayHandle } from './PaneDropOverlay'
import { useChatSession, useModels, useModelSelection, useSessionStats } from '../../hooks'
import { useServerStore } from '../../hooks/useServerStore'
import { useCancelHint } from '../../hooks/useCancelHint'
import { InlineToolRequestContext, type InlineToolRequestContextValue } from './InlineToolRequestContext'
import { ChatViewportProvider, canUseSplitPane, useChatViewportMaybe, type ChatViewportValue } from './chatViewport'
import { useChatPageViewModel } from './useChatPageViewModel'
import {
  summarizeLatestTurnChanges,
  summarizeSessionChanges,
  summarizeTurnTodoProgress,
  type TurnChangeFile,
} from '../message/autoCollapseExecution'
import type { TurnTodoProgress } from '../message/todoProgress'
import { SessionNavigationContext } from '../../contexts/SessionNavigationContext'
import { paneLayoutStore } from '../../store/paneLayoutStore'
import { autoApproveStore } from '../../store/autoApproveStore'
import { messageStore, paneControllerStore, useHiddenModelKeys } from '../../store'
import { restoreModelSelection } from '../../utils/sessionHelpers'
import { findModelByKey, getModelKey } from '../../utils/modelUtils'
import { useTheme } from '../../hooks/useTheme'
import { getProviders, type Attachment } from '../../api'
import type { MessageError } from '../../types/message'
import { getInternalDragSnapshot, subscribeInternalDrag, subscribeInternalDrop } from '../../lib/internalDragCore'
import { ErrorBoundary } from '../../components/ErrorBoundary'
import { I18nTrans } from '../../components/I18nTrans'
import { selectableAgentsInDisplayOrder } from './agentOrder'
import { insertComposerDraft } from '../../utils/composerDraft'
import { openUrl } from '../../utils/browserOpen'
import { composerDraftStore } from '../../store/composerDraftStore'

const FREE_LIMIT_DONT_SHOW_KEY = 'opencodex.freeLimit.dontShow'
const FREE_LIMIT_LAST_SEEN_KEY = 'opencodex.freeLimit.lastSeen'
const FREE_LIMIT_WINDOW = 24 * 60 * 60 * 1000

interface ChatPaneProps {
  paneId: string
  sessionId: string | null
  isFocused: boolean
  paneCount: number
  displayMode: 'single' | 'split'
  isPaneFullscreen?: boolean
  onOpenSidebar?: () => void
  onToggleRightPanel?: () => void
  onOpenSettings?: () => void
  onOpenProviderSettings?: () => void
  showSidebarButton?: boolean
  onSplitPane?: () => void
  onTogglePaneFullscreen?: () => void
  navigatePaneToSession: (paneId: string, sessionId: string, directory?: string) => void
  navigatePaneHome: (paneId: string, directory?: string | null) => void
}

// ============================================
// Compact viewport value (constant, never changes)
// ============================================
const PANE_VIEWPORT: ChatViewportValue = {
  presentation: {
    surfaceVariant: 'compact',
    isCompact: true,
  },
  interaction: {
    mode: 'pointer',
    touchCapable: false,
    sidebarBehavior: 'overlay',
    rightPanelBehavior: 'overlay',
    bottomPanelBehavior: 'overlay',
    outlineInteraction: 'pointer',
    enableCollapsedInputDock: false,
  },
  layout: {
    viewportWidth: 800,
    viewportHeight: 600,
    surfaceWidth: 800,
    surfaceMinWidth: 380,
    sidebar: {
      railWidth: 0,
      requestedWidth: 0,
      openWidth: 0,
      dockedWidth: 0,
      overlayWidth: 0,
      hardMinWidth: 0,
      preferredMinWidth: 0,
      maxWidth: 0,
      resizeMaxWidth: 0,
    },
    rightPanel: {
      requestedWidth: 0,
      dockedWidth: 0,
      hardMinWidth: 0,
      maxWidth: 0,
      resizeMaxWidth: 0,
    },
    bottomPanel: {
      maxHeight: 0,
    },
  },
  actions: {
    setSidebarRequestedWidth: () => {},
  },
}

let splitSessionNavigationToken = 0

function scheduleSplitSessionNavigation(callback: () => void) {
  const token = ++splitSessionNavigationToken

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (token !== splitSessionNavigationToken) return
      splitSessionNavigationToken = 0
      callback()
    })
  })
}

function cancelPendingSplitSessionNavigation() {
  if (splitSessionNavigationToken !== 0) {
    splitSessionNavigationToken += 1
  }
}

export const ChatPane = memo(function ChatPane({
  paneId,
  sessionId,
  isFocused,
  paneCount,
  displayMode,
  isPaneFullscreen = false,
  onOpenSidebar,
  onToggleRightPanel,
  onOpenSettings,
  onOpenProviderSettings,
  showSidebarButton = false,
  onSplitPane,
  onTogglePaneFullscreen,
  navigatePaneToSession,
  navigatePaneHome,
}: ChatPaneProps) {
  const { t } = useTranslation(['chat', 'common', 'message'])
  const showCompactShell = displayMode === 'split' && !isPaneFullscreen

  // Read the outer (App-level) viewport BEFORE this component's own Provider shadows it.
  // When fullscreen we pass this through so children keep the real desktop viewport;
  // in normal split mode we use the static PANE_VIEWPORT instead.
  const outerViewport = useChatViewportMaybe()
  const splitPaneEnabled = canUseSplitPane(outerViewport ?? PANE_VIEWPORT)

  // ============================================
  // Refs
  // ============================================
  const chatAreaRef = useRef<ChatAreaHandle>(null)
  const modelSelectorRef = useRef<ModelSelectorHandle>(null)
  const [freeLimit, setFreeLimit] = useState<{ resetAt?: number } | null>(null)
  const freeLimitHandledRef = useRef<string | null>(null)

  // ============================================
  // Models
  // ============================================
  const { models, isLoading: modelsLoading, refetch: refetchModels } = useModels()
  const { activeServer, getHealth } = useServerStore()
  const activeServerHealth = activeServer ? getHealth(activeServer.id) : null
  const hiddenModelKeys = useHiddenModelKeys()
  const visibleModels = useMemo(
    () => models.filter(model => !hiddenModelKeys.includes(getModelKey(model))),
    [models, hiddenModelKeys],
  )
  const [hasConnectedProvider, setHasConnectedProvider] = useState<boolean | null>(null)

  useEffect(() => {
    let disposed = false
    void getProviders()
      .then(result => {
        if (!disposed) setHasConnectedProvider(result.connected.length > 0)
      })
      .catch(() => {
        if (!disposed) setHasConnectedProvider(null)
      })
    return () => {
      disposed = true
    }
  }, [models])
  const {
    selectedModelKey,
    selectedVariant,
    currentModel,
    handleModelChange,
    handleVariantChange,
    restoreFromMessage,
  } = useModelSelection({ models: visibleModels, sessionId })

  // ============================================
  // Full Auto Hint
  // ============================================
  const [fullAutoHint, setFullAutoHint] = useState<string | null>(null)
  const fullAutoHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return autoApproveStore.onFullAutoChange((mode, changePaneId) => {
      // 只响应全局变更（changePaneId 为 undefined）或本 pane 的变更
      if (changePaneId && changePaneId !== paneId) return
      if (fullAutoHintTimerRef.current) clearTimeout(fullAutoHintTimerRef.current)
      const label =
        mode === 'global'
          ? t('chat:hints.autoApproveAll')
          : mode === 'session'
            ? t('chat:hints.autoApproveSession')
            : t('chat:hints.autoApproveOffHint')
      setFullAutoHint(label)
      fullAutoHintTimerRef.current = setTimeout(() => setFullAutoHint(null), 2000)
    })
  }, [t, paneId])

  // ============================================
  // Pane-local navigation
  // ============================================
  const navigateToSession = useCallback(
    (sid: string, directory?: string) => {
      navigatePaneToSession(paneId, sid, directory)
    },
    [paneId, navigatePaneToSession],
  )

  const navigateHome = useCallback(
    (directory?: string | null) => {
      navigatePaneHome(paneId, directory)
    },
    [paneId, navigatePaneHome],
  )

  // ============================================
  // Visible Message IDs (for outline index)
  // ============================================
  const outlineIndexRef = useRef<OutlineIndexHandle>(null)
  const visibleMessageIdsRef = useRef<string[]>([])
  const setVisibleMessageIdsStable = useCallback((ids: string[]) => {
    const prev = visibleMessageIdsRef.current
    if (prev.length === ids.length && prev.every((id, i) => id === ids[i])) return
    visibleMessageIdsRef.current = ids
    outlineIndexRef.current?.setVisibleMessageIds(ids)
  }, [])
  const [isAtBottom, setIsAtBottom] = useState(true)

  const handleOutlineScrollToMessage = useCallback((messageId: string) => {
    chatAreaRef.current?.scrollToMessageId(messageId)
  }, [])

  // ============================================
  // Input Box Height
  // ============================================
  const [inputBoxHeight, setInputBoxHeight] = useState(0)
  const [glassTopOffset, setGlassTopOffset] = useState(0)
  const inputBoxWrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = inputBoxWrapperRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        setInputBoxHeight(entry.contentRect.height)
        // 玻璃顶边到 wrapper 顶边的距离（概览胶囊等在流悬浮条的高度），
        // 用于把模糊底衬精确对齐到输入框玻璃，而不是悬浮条行
        const glass = el.querySelector('[data-input-box]')
        setGlassTopOffset(glass ? Math.max(0, glass.getBoundingClientRect().top - el.getBoundingClientRect().top) : 0)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ============================================
  // Chat Session
  // ============================================
  const {
    messages,
    isStreaming,
    canUndo,
    canRedo,
    redoSteps,
    revertedContent,
    restoredContent,
    agents,
    selectedAgent,
    setSelectedAgent,
    routeSessionId,
    loadState,
    loadError,
    hasMoreHistory,
    retryStatus,
    modelRecovery,
    effectiveDirectory,

    pendingPermissionRequests,
    pendingQuestionRequests,
    queuedFollowups,
    queuedFollowupSendingId,
    handlePermissionReply,
    handleQuestionReply,
    handleQuestionReject,
    handleQueuedFollowupRemove,
    handleQueuedFollowupUpdate,
    handleQueuedFollowupMove,
    handleQueuedFollowupSteer,
    isReplying,

    loadMoreHistory,
    handleRedoAll,
    clearRevert,
    clearModelRecovery,

    registerMessage,
    registerInputBox,

    handleSend,
    handleAbort,
    handleCommand,
    handleUndoWithAnimation,
    handleRedoWithAnimation,
    handleForkMessage,
    handleNewSession,
    handleVisibleMessageIdsChange,
    handleArchiveSession,
    handlePreviousSession,
    handleNextSession,
    handleCopyLastResponse,
    restoreAgentFromMessage,
  } = useChatSession({
    paneId,
    chatAreaRef,
    currentModel,
    selectedVariant,
    refetchModels,
    sessionId,
    navigateToSession,
    navigateHome,
  })

  const messageView = useMemo(() => ({ sessionId: routeSessionId, messages }), [routeSessionId, messages])
  const deferredMessageView = useDeferredValue(messageView)
  const shouldDeferMessages = displayMode === 'split' && !isStreaming && messages.length > 20
  const renderedMessagesView = shouldDeferMessages ? deferredMessageView : messageView
  const renderedMessages = renderedMessagesView.sessionId === routeSessionId ? renderedMessagesView.messages : []
  const isRenderingDeferredMessages = renderedMessages !== messages
  const renderedLoadState = loadState === 'loaded' && isRenderingDeferredMessages ? 'loading' : loadState
  const inputDisabled = !!routeSessionId && loadState === 'error' && messages.length === 0
  const chatPageViewModel = useChatPageViewModel(renderedMessages, true)

  const connectionError = useMemo<MessageError | undefined>(() => {
    if (!activeServer) {
      return {
        name: 'APIError',
        data: {
          message: 'No active OpenCode server is selected',
          isRetryable: false,
        },
      }
    }

    if (!activeServerHealth || activeServerHealth.status === 'checking' || activeServerHealth.status === 'online') {
      return undefined
    }

    const lines = [
      `Server: ${activeServer.name}`,
      `URL: ${activeServer.url}`,
      `Status: ${activeServerHealth.status}`,
      activeServerHealth.error ? `Error: ${activeServerHealth.error}` : '',
      activeServerHealth.status === 'error' || activeServerHealth.status === 'offline'
        ? 'Expected /api/info to return OpenCode server info JSON.'
        : '',
    ].filter(Boolean)

    const responseBody = [lines.join('\n'), activeServerHealth.details ? `Raw diagnostics:\n${activeServerHealth.details}` : '']
      .filter(Boolean)
      .join('\n\n')

    return {
      name: 'APIError',
      data: {
        message: activeServerHealth.error || `Unable to connect to ${activeServer.name}`,
        statusCode: activeServerHealth.status === 'unauthorized' ? 401 : undefined,
        isRetryable: activeServerHealth.status !== 'unauthorized',
        responseBody,
      },
    }
  }, [activeServer, activeServerHealth])

  const navigationCtx = useMemo(
    () => ({ navigateToSession, currentSessionId: routeSessionId, currentDirectory: effectiveDirectory }),
    [navigateToSession, routeSessionId, effectiveDirectory],
  )

  // ============================================
  // Protect session from eviction while this pane is viewing it
  // ============================================
  useEffect(() => {
    if (routeSessionId) {
      messageStore.protectSession(routeSessionId)
    }
    return () => {
      if (routeSessionId) {
        messageStore.unprotectSession(routeSessionId)
      }
    }
  }, [routeSessionId])

  // ============================================
  // Cancel Hint
  // ============================================
  const { showCancelHint, handleCancelMessage } = useCancelHint(isStreaming, handleAbort)

  // ============================================
  // Visible IDs bridge
  // ============================================
  const handleVisibleMessageIdsChangeRef = useRef<((ids: string[]) => void) | null>(null)
  useEffect(() => {
    handleVisibleMessageIdsChangeRef.current = handleVisibleMessageIdsChange
  }, [handleVisibleMessageIdsChange])

  const handleVisibleIdsChange = useCallback(
    (ids: string[]) => {
      handleVisibleMessageIdsChangeRef.current?.(ids)
      setVisibleMessageIdsStable(ids)
    },
    [setVisibleMessageIdsStable],
  )

  // ============================================
  // Agent Change with Model Sync
  // ============================================
  const syncModelForAgent = useCallback(
    (agentName: string) => {
      const agent = agents.find(a => a.name === agentName)
      if (agent?.model) {
        const modelKey = `${agent.model.providerID}:${agent.model.modelID}`
        const model = findModelByKey(visibleModels, modelKey)
        if (model) {
          handleModelChange(modelKey, model)
        }
      }
    },
    [agents, visibleModels, handleModelChange],
  )

  const handleAgentChange = useCallback(
    (agentName: string) => {
      setSelectedAgent(agentName)
      syncModelForAgent(agentName)
    },
    [setSelectedAgent, syncModelForAgent],
  )

  const handleToggleAgentWithSync = useCallback(() => {
    const primaryAgents = selectableAgentsInDisplayOrder(agents)
    if (primaryAgents.length <= 1) return
    const currentIndex = primaryAgents.findIndex(a => a.name === selectedAgent)
    const nextIndex = (currentIndex + 1) % primaryAgents.length
    handleAgentChange(primaryAgents[nextIndex].name)
  }, [agents, selectedAgent, handleAgentChange])

  // ============================================
  // Model Restoration Effect
  // --
  // 只在 session 切换（routeSessionId 变化）或 revert/undo 恢复时执行一次。
  // 流式输出期间 messages 变化不会触发，避免覆盖用户的模型选择。
  // ============================================
  const inputRestoreContent = revertedContent ?? restoredContent

  // revert/undo 恢复：inputRestoreContent 变化时立即恢复
  useEffect(() => {
    if (!inputRestoreContent?.model) return
    const modelSelection = restoreModelSelection(
      inputRestoreContent.model,
      inputRestoreContent.variant ?? null,
      visibleModels,
    )
    if (modelSelection) {
      restoreFromMessage(inputRestoreContent.model, inputRestoreContent.variant)
    }
  }, [inputRestoreContent, visibleModels, restoreFromMessage])

  // session 切换：只在 routeSessionId 变化时，从最后一条 user 消息恢复模型
  const restoredSessionRef = useRef<string | null>(null)
  useEffect(() => {
    // 没有 session、或者这个 session 已经恢复过了 → 跳过
    if (!routeSessionId || restoredSessionRef.current === routeSessionId) return
    // messages 还没加载完 → 等下次
    if (messages.length === 0) return

    restoredSessionRef.current = routeSessionId

    const lastUserMsg = [...messages].reverse().find(m => m.info.role === 'user')
    if (lastUserMsg && 'model' in lastUserMsg.info) {
      const userInfo = lastUserMsg.info as {
        model?: { providerID: string; modelID: string; variant?: string }
        variant?: string
      }
      restoreFromMessage(userInfo.model, userInfo.variant ?? userInfo.model?.variant)
    }
    // 依赖 routeSessionId 和 messages.length（等加载完），不依赖 messages 引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeSessionId, messages.length, visibleModels, restoreFromMessage])

  // ============================================
  // Agent Restoration Effect
  // ============================================
  useEffect(() => {
    if (inputRestoreContent?.agent) {
      restoreAgentFromMessage(inputRestoreContent.agent)
      return
    }
    if (messages.length === 0) return
    const lastUserMsg = [...messages].reverse().find(m => m.info.role === 'user')
    if (lastUserMsg && 'agent' in lastUserMsg.info) {
      restoreAgentFromMessage((lastUserMsg.info as { agent?: string }).agent)
    }
  }, [inputRestoreContent, messages, restoreAgentFromMessage])

  // ============================================
  // Focus handling
  // ============================================
  const handlePaneFocus = useCallback(() => {
    paneLayoutStore.focusPane(paneId)
  }, [paneId])

  // ============================================
  // Drag & Drop — receive a session dragged from the sidebar list
  // Center drop → replace current session; edge drops → split in that direction
  //
  // IMPORTANT: zone state lives in PaneDropOverlay (imperative handle). We do
  // NOT put it in ChatPane state — dragover fires every mouse move, and
  // re-rendering ChatPane on each move is very expensive once several panes
  // exist (ChatArea / messages / hooks). rAF also throttles DOM writes to one
  // per frame for smoothness.
  //
  // Zone resolution has two refs on purpose:
  //   - pendingZoneRef: written synchronously by every dragover (most recent)
  //   - currentZoneRef: what the overlay is actually showing (written by rAF)
  // drop() prefers the pending value so it never loses a last-frame move.
  // ============================================
  const overlayRef = useRef<PaneDropOverlayHandle>(null)
  const paneRootRef = useRef<HTMLDivElement>(null)
  const currentZoneRef = useRef<DropZone | null>(null)
  const pendingZoneRef = useRef<DropZone | null>(null)
  const dropRafRef = useRef<number | null>(null)

  const writeZone = useCallback((zone: DropZone | null) => {
    if (currentZoneRef.current === zone) return
    currentZoneRef.current = zone
    overlayRef.current?.setZone(zone)
  }, [])

  const cancelPendingZone = useCallback(() => {
    if (dropRafRef.current !== null) {
      cancelAnimationFrame(dropRafRef.current)
      dropRafRef.current = null
    }
    pendingZoneRef.current = null
  }, [])

  const resetDropState = useCallback(() => {
    cancelPendingZone()
    writeZone(null)
  }, [cancelPendingZone, writeZone])

  useEffect(() => {
    return () => {
      if (dropRafRef.current !== null) cancelAnimationFrame(dropRafRef.current)
    }
  }, [])

  const updateSessionDropZoneAt = useCallback(
    (clientX: number, clientY: number) => {
      if (!splitPaneEnabled) return null
      const element = paneRootRef.current
      if (!element) return null
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return null
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null

      const xRel = (clientX - rect.left) / rect.width
      const yRel = (clientY - rect.top) / rect.height
      const zone = resolveDropZone({ xRel, yRel })
      pendingZoneRef.current = zone

      if (dropRafRef.current === null) {
        dropRafRef.current = requestAnimationFrame(() => {
          dropRafRef.current = null
          writeZone(pendingZoneRef.current)
        })
      }

      return zone
    },
    [splitPaneEnabled, writeZone],
  )

  const clearSessionDropZoneAt = useCallback(
    (clientX: number, clientY: number) => {
      const element = paneRootRef.current
      if (!element) return resetDropState()
      const rect = element.getBoundingClientRect()
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
        resetDropState()
      }
    },
    [resetDropState],
  )

  const handleSessionDrop = useCallback(
    (payload: { sessionId: string; directory?: string }, zone: DropZone) => {
      resetDropState()
      cancelPendingSplitSessionNavigation()

      if (payload.sessionId === routeSessionId && zone === 'center') return

      if (zone === 'center') {
        navigatePaneToSession(paneId, payload.sessionId, payload.directory)
        return
      }

      const previousFocusedPaneId = paneLayoutStore.getFocusedPaneId()
      const newPaneId = paneLayoutStore.splitPaneToSide(paneId, zone, null)
      if (newPaneId) {
        if (previousFocusedPaneId && paneLayoutStore.findLeaf(previousFocusedPaneId)) {
          paneLayoutStore.focusPane(previousFocusedPaneId)
        }

        scheduleSplitSessionNavigation(() => {
          if (!paneLayoutStore.findLeaf(newPaneId)) return
          navigatePaneToSession(newPaneId, payload.sessionId, payload.directory)
        })
      }
    },
    [paneId, routeSessionId, navigatePaneToSession, resetDropState],
  )

  useEffect(() => {
    return subscribeInternalDrag(() => {
      const active = getInternalDragSnapshot().active
      if (!active || active.payload.kind !== 'session') {
        resetDropState()
        return
      }

      const zone = updateSessionDropZoneAt(active.current.x, active.current.y)
      if (!zone) clearSessionDropZoneAt(active.current.x, active.current.y)
    })
  }, [clearSessionDropZoneAt, resetDropState, updateSessionDropZoneAt])

  useEffect(() => {
    return subscribeInternalDrop(event => {
      if (event.payload.kind !== 'session') return
      const zone = updateSessionDropZoneAt(event.point.x, event.point.y)
      if (!zone) {
        resetDropState()
        return
      }

      handleSessionDrop(
        {
          sessionId: event.payload.sessionId,
          directory: event.payload.directory,
        },
        zone,
      )
    })
  }, [handleSessionDrop, resetDropState, updateSessionDropZoneAt])

  const handleToggleFullAuto = useCallback(() => {
    autoApproveStore.cyclePaneFullAutoMode(paneId)
  }, [paneId])

  const openModelSelector = useCallback(() => {
    modelSelectorRef.current?.openMenu()
  }, [])

  useEffect(() => {
    if (!routeSessionId) return
    const failed = [...messages].reverse().find((message) => {
      if (message.info.role !== 'assistant') return false
      const error = message.info.error
      return error?.name === 'APIError' && error.data.type === 'provider.free-limit'
    })
    if (!failed || failed.info.role !== 'assistant') return
    const error = failed.info.error
    if (!error || error.name !== 'APIError') return
    const key = `${failed.info.id}:${error.data.retryAfterMs ?? 0}`
    if (freeLimitHandledRef.current === key) return
    freeLimitHandledRef.current = key
    if (localStorage.getItem(FREE_LIMIT_DONT_SHOW_KEY) === '1') return
    const lastSeen = Number(localStorage.getItem(FREE_LIMIT_LAST_SEEN_KEY) ?? 0)
    if (Number.isFinite(lastSeen) && lastSeen > 0 && Date.now() - lastSeen < FREE_LIMIT_WINDOW) return

    const draft = composerDraftStore.getDraft(paneId)
    if (!draft?.text?.trim() && !(draft?.attachments.length)) {
      const index = messages.findIndex((message) => message.info.id === failed.info.id)
      const user = [...messages.slice(0, index)]
        .reverse()
        .find((message) => message.info.role === 'user')
      const text = user?.parts
        .flatMap((part) => (part.type === 'text' && !part.synthetic ? [part.text] : []))
        .join('\n')
        .trim()
      if (text) insertComposerDraft({ paneId, sessionId: routeSessionId, text, mode: 'replace' })
    }

    setFreeLimit({
      resetAt: error.data.retryAfterMs ? failed.info.time.created + error.data.retryAfterMs : undefined,
    })
  }, [messages, paneId, routeSessionId])

  const contextLimit = currentModel?.contextLimit
  const contextStats = useSessionStats(contextLimit)

  const controllerActionsRef = useRef({
    newSession: handleNewSession,
    archiveSession: handleArchiveSession,
    previousSession: handlePreviousSession,
    nextSession: handleNextSession,
    toggleAgent: handleToggleAgentWithSync,
    copyLastResponse: handleCopyLastResponse,
    cancelMessage: handleCancelMessage,
    openModelSelector,
    toggleFullAuto: handleToggleFullAuto,
  })

  useEffect(() => {
    controllerActionsRef.current = {
      newSession: handleNewSession,
      archiveSession: handleArchiveSession,
      previousSession: handlePreviousSession,
      nextSession: handleNextSession,
      toggleAgent: handleToggleAgentWithSync,
      copyLastResponse: handleCopyLastResponse,
      cancelMessage: handleCancelMessage,
      openModelSelector,
      toggleFullAuto: handleToggleFullAuto,
    }
  }, [
    handleNewSession,
    handleArchiveSession,
    handlePreviousSession,
    handleNextSession,
    handleToggleAgentWithSync,
    handleCopyLastResponse,
    handleCancelMessage,
    openModelSelector,
    handleToggleFullAuto,
  ])

  const stableControllerActions = useMemo(
    () => ({
      newSession: () => controllerActionsRef.current.newSession(),
      archiveSession: () => controllerActionsRef.current.archiveSession(),
      previousSession: () => controllerActionsRef.current.previousSession(),
      nextSession: () => controllerActionsRef.current.nextSession(),
      toggleAgent: () => controllerActionsRef.current.toggleAgent(),
      copyLastResponse: () => controllerActionsRef.current.copyLastResponse(),
      cancelMessage: () => controllerActionsRef.current.cancelMessage(),
      openModelSelector: () => controllerActionsRef.current.openModelSelector(),
      toggleFullAuto: () => controllerActionsRef.current.toggleFullAuto(),
    }),
    [],
  )

  useEffect(() => {
    return () => {
      paneControllerStore.removeController(paneId)
    }
  }, [paneId])

  useEffect(() => {
    paneControllerStore.setController(paneId, {
      paneId,
      sessionId: routeSessionId,
      effectiveDirectory: effectiveDirectory || '',
      contextLimit,
      newSession: stableControllerActions.newSession,
      archiveSession: stableControllerActions.archiveSession,
      previousSession: stableControllerActions.previousSession,
      nextSession: stableControllerActions.nextSession,
      toggleAgent: stableControllerActions.toggleAgent,
      copyLastResponse: stableControllerActions.copyLastResponse,
      cancelMessage: stableControllerActions.cancelMessage,
      openModelSelector: stableControllerActions.openModelSelector,
      toggleFullAuto: stableControllerActions.toggleFullAuto,
      isStreaming,
    })
  }, [paneId, routeSessionId, effectiveDirectory, contextLimit, stableControllerActions, isStreaming])

  // ============================================
  // Dialog Collapsed State
  // ============================================
  const [permissionCollapsed, setPermissionCollapsed] = useState(false)
  const [questionCollapsed, setQuestionCollapsed] = useState(false)

  const permissionRequestId = pendingPermissionRequests[0]?.id
  const questionRequestId = pendingQuestionRequests[0]?.id
  useEffect(() => {
    if (permissionRequestId) setPermissionCollapsed(false)
  }, [permissionRequestId])
  useEffect(() => {
    if (questionRequestId) setQuestionCollapsed(false)
  }, [questionRequestId])

  const { fileChangeIndicatorScope } = useTheme()
  const latestTurnOverview = useMemo(() => {
    if (renderedMessages.length === 0) return

    const changes =
      fileChangeIndicatorScope === 'session'
        ? summarizeSessionChanges(renderedMessages)
        : summarizeLatestTurnChanges(renderedMessages)
    const userMessageIndex = renderedMessages.findLastIndex(message => message.info.role === 'user')
    let todoProgress: TurnTodoProgress | undefined
    if (userMessageIndex !== -1) {
      const assistantTurn = renderedMessages
        .slice(userMessageIndex + 1)
        .filter(message => message.info.role === 'assistant')
      todoProgress = summarizeTurnTodoProgress(assistantTurn)
    }
    if (changes.files === 0 && !todoProgress) return
    return {
      changes: changes.files > 0 ? changes : undefined,
      todoProgress,
    }
  }, [renderedMessages, fileChangeIndicatorScope])

  const inlineToolRequestCtx = useMemo<InlineToolRequestContextValue>(
    () => ({
      pendingPermissions: pendingPermissionRequests,
      pendingQuestions: pendingQuestionRequests,
      onPermissionReply: (requestId, reply) => {
        const request = pendingPermissionRequests.find(r => r.id === requestId)
        return handlePermissionReply(requestId, reply, effectiveDirectory, request?.sessionID)
      },
      onQuestionReply: (requestId, answers) => handleQuestionReply(requestId, answers, effectiveDirectory),
      onQuestionReject: requestId => handleQuestionReject(requestId, effectiveDirectory),
      isReplying,
    }),
    [
      pendingPermissionRequests,
      pendingQuestionRequests,
      handlePermissionReply,
      handleQuestionReply,
      handleQuestionReject,
      isReplying,
      effectiveDirectory,
    ],
  )

  const revertedMessage = inputRestoreContent
    ? {
        text: inputRestoreContent.text,
        attachments: inputRestoreContent.attachments as Attachment[],
      }
    : undefined
  const homeComposer = !routeSessionId
  const showProviderSetupTip = homeComposer && !modelsLoading && hasConnectedProvider === false && !!onOpenProviderSettings

  // ============================================
  // Render
  // ============================================
  const chatContent = (
    <div className="flex-1 relative overflow-hidden flex flex-col min-h-0">
      {displayMode === 'single' && (
        <div className="absolute top-0 left-0 right-0 z-20 pointer-events-none">
          <div className="pointer-events-auto">
            <Header
              onOpenSidebar={onOpenSidebar}
              onToggleRightPanel={onToggleRightPanel}
              onSplitPane={onSplitPane}
              isPaneFullscreen={isPaneFullscreen}
              onTogglePaneFullscreen={onTogglePaneFullscreen}
              onArchiveSession={handleArchiveSession}
            />
          </div>
        </div>
      )}

      {/* 视口底边深探 40px + ChatArea 底部 spacer 48px：回底时消息块底边（含 hover
          操作栏）停在玻璃顶上方 8px，文字与输入框之间留出约一行的操作空间；
          滚动时消息仍可滑进玻璃区由渐隐带承接淡出 */}
      <div className="absolute top-0 left-0 right-0" style={{ bottom: Math.max(0, (inputBoxHeight || 0) - 40) }}>
        <InlineToolRequestContext.Provider value={inlineToolRequestCtx}>
          <ErrorBoundary onOpenSettings={onOpenSettings}>
            <ChatArea
              ref={chatAreaRef}
              messages={renderedMessages}
              pageRecords={chatPageViewModel.pageRecords}
              visibleMessages={chatPageViewModel.visibleMessages}
              forkTargetIdMap={chatPageViewModel.forkTargetIdMap}
              turnDurationMap={chatPageViewModel.turnDurationMap}
              sessionId={routeSessionId}
              isStreaming={isStreaming}
              allowStreamingLayoutAnimation={isAtBottom}
              loadState={renderedLoadState}
              loadError={loadError}
              connectionError={connectionError}
              onOpenSettings={onOpenSettings}
              hasMoreHistory={hasMoreHistory}
              onLoadMore={loadMoreHistory}
              onUndo={handleUndoWithAnimation}
              onFork={handleForkMessage}
              canUndo={canUndo}
              registerMessage={registerMessage}
              retryStatus={retryStatus}
              bottomPadding={inputBoxHeight}
              onVisibleMessageIdsChange={handleVisibleIdsChange}
              onAtBottomChange={setIsAtBottom}
            />
          </ErrorBoundary>
        </InlineToolRequestContext.Provider>
      </div>

      <OutlineIndex
        ref={outlineIndexRef}
        sourceEntries={chatPageViewModel.outlineSourceEntries}
        ownerByMessageId={chatPageViewModel.outlineOwnerByMessageId}
        currentHighlightEnabled
        onScrollToMessageId={handleOutlineScrollToMessage}
      />

      <div
        ref={inputBoxWrapperRef}
        className={
          homeComposer
            ? 'absolute left-0 right-0 top-1/2 z-10 -translate-y-1/2 pointer-events-none'
            : 'absolute bottom-0 left-0 right-0 z-10 pointer-events-none'
        }
      >
        {/* 输入框上缘的滚动渐隐带：仅当不在底部（内容正滑向输入框）时显示，消息经过
            玻璃顶边前在这里渐隐，玻璃实心/毛玻璃均可见；回到底部时整带隐藏，
            不遮挡最后一条消息。锚定玻璃顶边（glassTopOffset），40px 像素色标
            从带顶过渡到玻璃边，无接缝。zIndex -1 位于本 stacking context 最底。 */}
        <div
          aria-hidden
          className={`pointer-events-none absolute inset-x-0 backdrop-blur-md transition-opacity duration-150 ${
            homeComposer ? 'hidden' : isAtBottom ? 'opacity-0' : 'opacity-100'
          }`}
          style={{
            top: glassTopOffset - 40,
            bottom: glassTopOffset,
            zIndex: -1,
            backgroundImage: 'linear-gradient(to bottom, transparent 0px, hsl(var(--chat-bg) / 0.7) 40px)',
            WebkitMaskImage: 'linear-gradient(to bottom, transparent 0px, black 40px)',
            maskImage: 'linear-gradient(to bottom, transparent 0px, black 40px)',
          }}
        />
        {modelRecovery && (
          <div className="absolute bottom-full inset-x-0 z-20 flex justify-center px-4 pb-3 pointer-events-none">
            <div className="pointer-events-auto flex max-w-md items-center gap-3 rounded-xl border border-warning-100/30 bg-bg-000/95 px-3 py-2.5 shadow-lg backdrop-blur-md">
              <AlertCircleIcon size={18} className="shrink-0 text-warning-100" />
              <div className="min-w-0">
                <div className="text-[length:var(--fs-sm)] font-medium text-text-100">{t('modelRecovery.title')}</div>
                <div className="text-[length:var(--fs-xs)] text-text-400">{t('modelRecovery.description', { model: modelRecovery.failedModel })}</div>
              </div>
              <button
                type="button"
                onClick={() => modelSelectorRef.current?.openMenu()}
                className="shrink-0 rounded-md bg-bg-200 px-2.5 py-1.5 text-[length:var(--fs-xs)] font-medium text-text-200 transition-colors hover:bg-bg-300"
              >
                {t('modelRecovery.action')}
              </button>
              <button
                type="button"
                onClick={clearModelRecovery}
                aria-label={t('common:dismiss')}
                className="shrink-0 text-text-400 transition-colors hover:text-text-200"
              >
                <CloseIcon size={14} />
              </button>
            </div>
          </div>
        )}
        {showProviderSetupTip && (
          <div className="absolute bottom-full inset-x-0 z-20 flex justify-center px-4 pb-3 pointer-events-none">
            <div className="pointer-events-auto flex max-w-md items-center gap-3 rounded-xl border border-accent-main-100/20 bg-bg-000/95 px-3 py-2.5 shadow-lg backdrop-blur-md">
              <PlugIcon size={18} className="shrink-0 text-accent-main-100" />
              <div className="min-w-0">
                <div className="text-[length:var(--fs-sm)] font-medium text-text-100">{t('providerSetup.title')}</div>
                <div className="text-[length:var(--fs-xs)] text-text-400">{t('providerSetup.description')}</div>
              </div>
              <button
                type="button"
                onClick={onOpenProviderSettings}
                className="shrink-0 rounded-md bg-accent-main-100 px-2.5 py-1.5 text-[length:var(--fs-xs)] font-medium text-oncolor-100 transition-colors hover:bg-accent-main-200"
              >
                {t('providerSetup.action')}
              </button>
            </div>
          </div>
        )}
        {(showCancelHint || (fullAutoHint && !showCancelHint)) && (
          <div className="absolute bottom-full inset-x-0 flex justify-center pb-2 pointer-events-none z-20">
            <div className="px-3 py-1.5 glass border border-border-200/60 rounded-lg shadow-lg text-[length:var(--fs-sm)] text-text-300 animate-in fade-in slide-in-from-bottom-2 duration-150">
              {showCancelHint ? (
                <I18nTrans
                  i18nKey="chat:hints.pressEscAgain"
                  components={{
                    1: (
                      <kbd className="mx-0.5 px-1.5 py-0.5 bg-bg-200 border border-border-200 rounded text-[length:var(--fs-xs)] font-mono font-medium text-text-200" />
                    ),
                  }}
                />
              ) : (
                fullAutoHint
              )}
            </div>
          </div>
        )}
        {latestTurnOverview && (
          <div className="relative z-10 mx-auto mb-2 flex max-w-[min(92%,68rem)] justify-center px-4 lg:px-6">
            <div
              className="pointer-events-auto inline-flex cursor-default items-center gap-2 rounded-xl border border-border-200/60 bg-bg-000/95 px-3 py-2 text-[length:var(--fs-sm)] text-text-300 shadow-lg backdrop-blur-md transition-colors hover:border-accent-main-100/35 hover:bg-bg-100/95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-main-100/35"
              tabIndex={latestTurnOverview.todoProgress ? 0 : undefined}
            >
              {latestTurnOverview.todoProgress ? (
                <span className="group/todo relative flex items-center gap-2">
                  <TurnTodoProgressPopover progress={latestTurnOverview.todoProgress} isStreaming={isStreaming} />
                  {isStreaming
                    ? <SpinnerIcon size={15} className="shrink-0 animate-spin text-accent-main-100" />
                    : latestTurnOverview.changes
                      ? <PatchIcon size={15} className="shrink-0 text-text-400" />
                      : <CheckIcon size={15} className="shrink-0 text-success-100" />}
                  <span>
                    {t('message:executionProcess.currentStep', {
                      current: latestTurnOverview.todoProgress.current,
                      total: latestTurnOverview.todoProgress.total,
                    })}
                  </span>
                  {latestTurnOverview.changes && <span aria-hidden="true">·</span>}
                </span>
              ) : (
                <>
                  {isStreaming
                    ? <SpinnerIcon size={15} className="shrink-0 animate-spin text-accent-main-100" />
                    : latestTurnOverview.changes
                      ? <PatchIcon size={15} className="shrink-0 text-text-400" />
                      : <CheckIcon size={15} className="shrink-0 text-success-100" />}
                </>
              )}
              {latestTurnOverview.changes && (
                <span className="group/changes relative flex items-center gap-2">
                  <TurnChangesPopover fileDetails={latestTurnOverview.changes.fileDetails} />
                  <span>{t('message:executionProcess.changedFiles', { count: latestTurnOverview.changes.files })}</span>
                  <span className="font-mono font-medium text-success-100">+{latestTurnOverview.changes.additions}</span>
                  <span className="font-mono font-medium text-danger-100">-{latestTurnOverview.changes.deletions}</span>
                </span>
              )}
            </div>
          </div>
        )}
        <InputBox
          paneId={paneId}
          onSend={handleSend}
          onAbort={handleAbort}
          onCommand={handleCommand}
          onNewChat={handleNewSession}
          disabled={inputDisabled}
          isStreaming={isStreaming}
          agents={agents}
          selectedAgent={selectedAgent}
          onAgentChange={handleAgentChange}
          variants={currentModel?.variants ?? []}
          selectedVariant={selectedVariant}
          onVariantChange={handleVariantChange}
          fileCapabilities={
            currentModel
              ? {
                  image: currentModel.supportsImages,
                  pdf: currentModel.supportsPdf,
                  audio: currentModel.supportsAudio,
                  video: currentModel.supportsVideo,
                }
              : undefined
          }
          models={visibleModels}
          selectedModelKey={selectedModelKey}
          onModelChange={handleModelChange}
          modelsLoading={modelsLoading}
          modelSelectorRef={modelSelectorRef}
          contextStats={contextStats}
          hasMessages={messages.length > 0}
          rootPath={effectiveDirectory}
          sessionId={routeSessionId}
          queuedFollowups={queuedFollowups}
          queuedFollowupSendingId={queuedFollowupSendingId}
          onQueuedFollowupRemove={handleQueuedFollowupRemove}
          onQueuedFollowupUpdate={handleQueuedFollowupUpdate}
          onQueuedFollowupMove={handleQueuedFollowupMove}
          onQueuedFollowupSteer={handleQueuedFollowupSteer}
          revertedText={revertedMessage?.text}
          revertedAttachments={revertedMessage?.attachments}
          canRedo={canRedo}
          revertSteps={redoSteps}
          onRedo={handleRedoWithAnimation}
          onRedoAll={handleRedoAll}
          onClearRevert={clearRevert}
          registerInputBox={registerInputBox}
          isAtBottom={isAtBottom}
          showScrollToBottom={!isAtBottom}
          onScrollToBottom={() => chatAreaRef.current?.scrollToBottom()}
          collapsedPermission={
            pendingPermissionRequests.length > 0 && permissionCollapsed
              ? {
                  label: t('chat:permissionDialog.permission', {
                    permission: pendingPermissionRequests[0].permission,
                  }),
                  queueLength: pendingPermissionRequests.length,
                  onExpand: () => setPermissionCollapsed(false),
                }
              : undefined
          }
          collapsedQuestion={
            pendingPermissionRequests.length === 0 &&
            pendingQuestionRequests.length > 0 &&
            questionCollapsed
              ? {
                  label: t('chat:questionDialog.title'),
                  queueLength: pendingQuestionRequests.length,
                  onExpand: () => setQuestionCollapsed(false),
                }
              : undefined
          }
          homeMode={homeComposer}
        />
      </div>

      <FreeLimitDialog
        isOpen={freeLimit !== null}
        resetAt={freeLimit?.resetAt}
        onClose={() => {
          localStorage.setItem(FREE_LIMIT_LAST_SEEN_KEY, String(Date.now()))
          setFreeLimit(null)
        }}
        onSwitchModel={() => {
          localStorage.setItem(FREE_LIMIT_LAST_SEEN_KEY, String(Date.now()))
          setFreeLimit(null)
          openModelSelector()
        }}
        onSubscribe={() => {
          localStorage.setItem(FREE_LIMIT_LAST_SEEN_KEY, String(Date.now()))
          setFreeLimit(null)
          void openUrl('https://opencode.ai/go')
        }}
        onDontShow={() => {
          localStorage.setItem(FREE_LIMIT_DONT_SHOW_KEY, '1')
          localStorage.setItem(FREE_LIMIT_LAST_SEEN_KEY, String(Date.now()))
          setFreeLimit(null)
        }}
      />

      {pendingPermissionRequests.length > 0 && (
        <PermissionDialog
          request={pendingPermissionRequests[0]}
          onReply={reply =>
            handlePermissionReply(
              pendingPermissionRequests[0].id,
              reply,
              effectiveDirectory,
              pendingPermissionRequests[0].sessionID,
            )
          }
          queueLength={pendingPermissionRequests.length}
          isReplying={isReplying}
          currentSessionId={routeSessionId}
          collapsed={permissionCollapsed}
          onCollapsedChange={setPermissionCollapsed}
        />
      )}

      {pendingPermissionRequests.length === 0 && pendingQuestionRequests.length > 0 && (
        <QuestionDialog
          request={pendingQuestionRequests[0]}
          onReply={answers => handleQuestionReply(pendingQuestionRequests[0].id, answers, effectiveDirectory)}
          onReject={() => handleQuestionReject(pendingQuestionRequests[0].id, effectiveDirectory)}
          queueLength={pendingQuestionRequests.length}
          isReplying={isReplying}
          collapsed={questionCollapsed}
          onCollapsedChange={setQuestionCollapsed}
        />
      )}
    </div>
  )

  const content = (
    <SessionNavigationContext.Provider value={navigationCtx}>
      <div
        ref={paneRootRef}
        data-chat-pane-root="true"
        className={
          showCompactShell
            ? `relative h-full flex flex-col overflow-hidden rounded-lg transition-all duration-200 ${
                isFocused
                  ? 'ring-1 ring-accent-main-100/60 bg-[hsl(var(--chat-bg))]'
                  : 'ring-1 ring-border-200/30 bg-[hsl(var(--chat-bg))] hover:ring-border-200/50'
              }`
            : 'relative h-full flex flex-col overflow-hidden bg-[hsl(var(--chat-bg))]'
        }
        onClick={handlePaneFocus}
      >
        {showCompactShell && (
          <PaneHeader
            paneId={paneId}
            sessionId={routeSessionId}
            isFocused={isFocused}
            paneCount={paneCount}
            showSidebarButton={showSidebarButton}
            onOpenSidebar={onOpenSidebar}
            onToggleRightPanel={onToggleRightPanel}
            canSplitPane={splitPaneEnabled}
            isPaneFullscreen={isPaneFullscreen}
            onTogglePaneFullscreen={onTogglePaneFullscreen}
            onFocus={handlePaneFocus}
          />
        )}
        {chatContent}
        <PaneDropOverlay ref={overlayRef} />
      </div>
    </SessionNavigationContext.Provider>
  )

  // Always wrap with ChatViewportProvider to keep the React tree structure stable
  // across fullscreen toggles. Only the value changes — compact pane vs full viewport.
  const viewportValue = showCompactShell ? PANE_VIEWPORT : (outerViewport ?? PANE_VIEWPORT)

  return <ChatViewportProvider value={viewportValue}>{content}</ChatViewportProvider>
})

function TurnChangesPopover({ fileDetails }: { fileDetails: TurnChangeFile[] }) {
  const { t } = useTranslation('message')
  const [pathTooltip, setPathTooltip] = useState<{ path: string; x: number; y: number } | null>(null)

  return (
    <div className="invisible pointer-events-none absolute bottom-full left-1/2 z-30 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 pb-2 opacity-0 transition-[opacity,visibility] duration-150 group-hover/changes:visible group-hover/changes:pointer-events-auto group-hover/changes:opacity-100 group-focus-within/changes:visible group-focus-within/changes:pointer-events-auto group-focus-within/changes:opacity-100">
      <div className="overflow-hidden rounded-xl border border-border-200/70 bg-bg-000/98 shadow-xl backdrop-blur-xl">
        <div className="flex items-center justify-between border-b border-border-200/50 px-3.5 py-2.5">
          <span className="font-medium text-text-100">{t('executionProcess.changedFilesTitle')}</span>
          <span className="text-[length:var(--fs-xs)] tabular-nums text-text-400">
            {fileDetails.length}
          </span>
        </div>
        <div className="max-h-64 overflow-y-auto py-1.5">
          {fileDetails.map((file) => {
            const fileName = file.filePath.split('/').pop() || file.filePath
            return (
              <div
                key={file.filePath}
                className="flex items-center gap-2.5 px-3.5 py-2"
                onMouseEnter={event => {
                  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
                  setPathTooltip({ path: file.filePath, x: rect.left, y: rect.top })
                }}
                onMouseLeave={() => setPathTooltip(null)}
              >
                <FileIcon size={14} className="mt-0.5 shrink-0 text-text-500" />
                <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--fs-xs)] text-text-300">
                  {fileName}
                </span>
                <span className="flex shrink-0 gap-2 text-[length:var(--fs-xs)] tabular-nums">
                  {file.additions > 0 && (
                    <span className="font-mono font-medium text-success-100">+{file.additions}</span>
                  )}
                  {file.deletions > 0 && (
                    <span className="font-mono font-medium text-danger-100">-{file.deletions}</span>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      </div>
      {pathTooltip && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="pointer-events-none fixed z-[200] max-w-[80vw] whitespace-pre-wrap break-all rounded-md border border-border-200/70 bg-bg-100/98 px-2.5 py-1 font-mono text-[length:var(--fs-xs)] text-text-200 shadow-lg"
              style={{ left: pathTooltip.x + 10, top: pathTooltip.y - 10, transform: 'translateY(-100%)' }}
            >
              {pathTooltip.path}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

function TurnTodoProgressPopover({ progress, isStreaming }: { progress: TurnTodoProgress; isStreaming: boolean }) {
  const { t } = useTranslation('message')
  return (
    <div className="invisible pointer-events-none absolute bottom-full left-1/2 z-30 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 pb-2 opacity-0 transition-[opacity,visibility] duration-150 group-hover/todo:visible group-hover/todo:pointer-events-auto group-hover/todo:opacity-100 group-focus-within/todo:visible group-focus-within/todo:pointer-events-auto group-focus-within/todo:opacity-100">
      <div className="overflow-hidden rounded-xl border border-border-200/70 bg-bg-000/98 shadow-xl backdrop-blur-xl">
        <div className="flex items-center justify-between border-b border-border-200/50 px-3.5 py-2.5">
          <span className="font-medium text-text-100">{t('executionProcess.taskProgress')}</span>
          <span className="text-[length:var(--fs-xs)] tabular-nums text-text-400">
            {t('executionProcess.currentStep', { current: progress.current, total: progress.total })}
          </span>
        </div>
        <div className="max-h-64 overflow-y-auto py-1.5">
          {progress.items.map((item, index) => {
            const active = item.status === 'in_progress' || (
              isStreaming &&
              item.status === 'pending' &&
              index + 1 === progress.current
            )
            return (
              <div
                key={`${index}:${item.content}`}
                className={`flex items-start gap-2.5 px-3.5 py-2 ${
                  active ? 'bg-accent-main-100/10 text-text-100' : 'text-text-300'
                }`}
              >
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                  {active
                    ? <SpinnerIcon size={14} className="animate-spin text-accent-main-100" />
                    : item.status === 'completed'
                      ? <CheckIcon size={14} className="text-success-100" />
                      : item.status === 'cancelled'
                        ? <CloseIcon size={14} className="text-text-500" />
                        : <CircleIcon size={13} className="text-text-500" />}
                </span>
                <span className={`min-w-0 whitespace-pre-wrap break-words leading-relaxed ${
                  item.status === 'completed' ? 'text-text-400' : ''
                }`}>
                  {item.content}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
