import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Sidebar } from './features/chat'
import { ChatPane } from './features/chat/ChatPane'
import { SplitContainer } from './features/chat/SplitContainer'
import type { CommandItem } from './components/CommandPalette'
import { ToastContainer } from './components/ToastContainer'
import { DesktopTitlebar } from './components/DesktopTitlebar'
import { ElectronWindowsTitlebar } from './components/ElectronWindowsTitlebar'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  LayersIcon,
  PlugIcon,
  PuzzleIcon,
  SearchIcon,
  SidebarIcon,
  TeachIcon,
} from './components/Icons'
import { NotificationCenterDialog } from './components/NotificationCenter'
import { useDirectory, useGlobalEvents, useGlobalKeybindings, useRouter } from './hooks'
import { useViewportHeight } from './hooks/useViewportHeight'
import { useWakeLock } from './hooks/useWakeLock'
import type { KeybindingHandlers } from './hooks/useKeybindings'
import { keybindingStore } from './store/keybindingStore'
import { useUnreadNotificationCount } from './store/notificationStore'
import {
  composerDraftStore,
  layoutStore,
  paneLayoutStore,
  updateStore,
  useLayoutStore,
  usePaneController,
  usePaneControllers,
  usePaneLayout,
} from './store'
import { initNavigation, pushNavigation, goBack as navGoBack, goForward as navGoForward, canGoBack, canGoForward, subscribe } from './store/navigationHistoryStore'
import { setSettingsTab } from './store/settingsStore'
import {
  ChatViewportProvider,
  CHAT_SURFACE_MIN_WIDTH,
  canUseSplitPane,
  useChatViewportController,
} from './features/chat/chatViewport'
import { uiErrorHandler, isSameDirectory, collectActiveDirectories } from './utils'
import { initNotificationSound } from './utils/notificationSoundBridge'
import { createPtySession } from './api/pty'
import type { TerminalTab } from './store/layoutStore'
import { SettingsPage, type SettingsTab } from './features/settings/SettingsDialog'
import { isElectron, getDesktopPlatform } from './utils/platform'
import { InternalDragLayer } from './components/InternalDragLayer'
import { completeOnboarding, resetOnboarding, shouldShowOnboarding } from './store/onboardingStore'
import { insertComposerDraft } from './utils/composerDraft'
import type { CustomOpenCodeDeepLink } from '../../shared/deepLinks'

const CommandPalette = lazy(() =>
  import('./components/CommandPalette').then(module => ({ default: module.CommandPalette })),
)
const SkillPanel = lazy(() =>
  import('./components/SkillPanel').then(module => ({ default: module.SkillPanel })),
)
const McpPanel = lazy(() =>
  import('./components/McpPanel').then(module => ({ default: module.McpPanel })),
)
const ExpertKitPanel = lazy(() =>
  import('./components/ExpertKitPanel').then(module => ({ default: module.ExpertKitPanel })),
)
const PluginPanel = lazy(() =>
  import('./components/PluginPanel').then(module => ({ default: module.PluginPanel })),
)
const TaskPanel = lazy(() =>
  import('./components/TaskPanel').then(module => ({ default: module.TaskPanel })),
)
const RightPanel = lazy(() =>
  import('./components/RightPanel').then(module => ({ default: module.RightPanel })),
)
const BottomPanel = lazy(() =>
  import('./components/BottomPanel').then(module => ({ default: module.BottomPanel })),
)
const SessionSearchDialog = lazy(() =>
  import('./features/chat/sidebar/SessionSearchDialog').then(module => ({ default: module.SessionSearchDialog })),
)
const OnboardingDialog = lazy(() =>
  import('./components/OnboardingDialog').then(module => ({ default: module.OnboardingDialog })),
)

const MOBILE_PAGER_SCROLL_END_MS = 120
const MOBILE_RIGHT_PANEL_UNMOUNT_MS = 420
const SIDEBAR_TRANSITION_MS = 300

type MobilePagerPage = 'left' | 'chat' | 'right'
type MainUtilityPage = 'plugins' | 'tasks' | 'settings'
type ExtensionPageTab = 'skills' | 'plugins' | 'mcp' | 'kits'

function ElectronSidebarToggle({
  expanded,
  title,
  onToggle,
  onPreviewOpen,
  onPreviewClose,
}: {
  expanded: boolean
  title: string
  onToggle: () => void
  onPreviewOpen: () => void
  onPreviewClose: () => void
}) {
  return createPortal(
    <button
      type="button"
      onPointerEnter={onPreviewOpen}
      onPointerLeave={onPreviewClose}
      onPointerDownCapture={event => event.stopPropagation()}
      onMouseDownCapture={event => event.stopPropagation()}
      onClickCapture={event => {
        event.stopPropagation()
        onToggle()
      }}
      aria-label={title}
      aria-pressed={expanded}
      title={title}
      className="electron-sidebar-toggle window-no-drag"
    >
      <SidebarIcon size={16} />
    </button>,
    document.body,
  )
}

function ElectronSidebarSearch({ title, onOpen }: { title: string; onOpen: () => void }) {
  return createPortal(
    <button type="button" onClick={onOpen} aria-label={title} title={title} className="electron-sidebar-search window-no-drag">
      <SearchIcon size={16} />
    </button>,
    document.body,
  )
}

interface ElectronHistoryNavigationProps {
  backTitle: string
  forwardTitle: string
  onGoBack: () => void
  onGoForward: () => void
}

function ElectronHistoryNavigation({ backTitle, forwardTitle, onGoBack, onGoForward }: ElectronHistoryNavigationProps) {
  const [navState, setNavState] = useState(() => ({ back: canGoBack(), forward: canGoForward() }))
  useEffect(() => subscribe(() => setNavState({ back: canGoBack(), forward: canGoForward() })), [])
  return createPortal(
    <div className="electron-history-navigation window-no-drag">
      <button
        type="button"
        disabled={!navState.back}
        onClick={onGoBack}
        aria-label={backTitle}
        title={backTitle}
      >
        <ChevronLeftIcon size={18} />
      </button>
      <button
        type="button"
        disabled={!navState.forward}
        onClick={onGoForward}
        aria-label={forwardTitle}
        title={forwardTitle}
      >
        <ChevronRightIcon size={18} />
      </button>
    </div>,
    document.body,
  )
}

function App() {
  const { t } = useTranslation(['commands', 'chat', 'common', 'components'])
  const router = useRouter()
  const {
    sessionId: routeSessionId,
    directory: routeDirectory,
    navigateToSession: navigateRouteToSession,
    navigateHome: navigateRouteHome,
    replaceSession,
  } = router
  const { currentDirectory, savedDirectories, sidebarExpanded, setSidebarExpanded, pathInfo, addDirectory } = useDirectory()
  const { rightPanelOpen, rightPanelWidth, wakeLock } = useLayoutStore()
  const { surfaceRef, value: chatViewport } = useChatViewportController({
    sidebarExpanded,
    rightPanelOpen,
    requestedRightPanelWidth: rightPanelWidth,
  })
  const splitPaneEnabled = canUseSplitPane(chatViewport)
  const showTitlebarSidebarButton = chatViewport.interaction.sidebarBehavior !== 'overlay'
  const paneLayout = usePaneLayout()
  const focusedController = usePaneController(paneLayout.focusedPaneId)
  const paneControllers = usePaneControllers()
  const syncingFromRouteRef = useRef(false)
  const lastRouteSessionIdRef = useRef<string | null | undefined>(undefined)
  const sidebarTransitionTimerRef = useRef<number | null>(null)
  const sidebarPreviewCloseTimerRef = useRef<number | null>(null)
  const [sidebarPreviewOpen, setSidebarPreviewOpen] = useState(false)
  // 当 currentDirectory 为 undefined 时表示全局模式，
  // 不应 fallback 到 session 自身的 directory，否则 replaceSession 会把 dir 参数写回 URL
  const focusedRouteDirectory =
    currentDirectory !== undefined
      ? paneLayout.focusedSessionId === routeSessionId
        ? routeDirectory || focusedController?.effectiveDirectory || currentDirectory
        : focusedController?.effectiveDirectory || currentDirectory
      : undefined
  const [utilityPage, setUtilityPage] = useState<MainUtilityPage | null>(null)
  const [extensionPageTab, setExtensionPageTab] = useState<ExtensionPageTab>('skills')
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false)
  const [notificationCenterOpen, setNotificationCenterOpen] = useState(false)
  const unreadNotificationCount = useUnreadNotificationCount()
  const navRestoringRef = useRef(false)
  const prevUtilityPageRef = useRef<MainUtilityPage | null>(null)

  // 同步未读数到主进程，用于 Dock/菜单栏角标
  useEffect(() => {
    window.customOpenCode?.setBadgeCount(unreadNotificationCount)?.catch(() => undefined)
  }, [unreadNotificationCount])

  useEffect(() => {
    const cleanup = initNotificationSound()
    return cleanup
  }, [])

  // 启动时自动检查更新
  useEffect(() => {
    void updateStore.checkForUpdates()
  }, [])

  useViewportHeight()
  useWakeLock(wakeLock)

  const activeDirectories = useMemo(
    () =>
      collectActiveDirectories({
        routeDirectory,
        currentDirectory,
        paneDirectories: paneControllers
          .map(controller => controller.effectiveDirectory)
          .filter((directory): directory is string => Boolean(directory)),
        projectDirectories: (Array.isArray(savedDirectories) ? savedDirectories : []).map(directory => directory.path),
      }),
    [routeDirectory, currentDirectory, paneControllers, savedDirectories],
  )

  // 初始化导航历史
  useEffect(() => {
    initNavigation(window.location.hash)
    prevUtilityPageRef.current = utilityPage
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 推送导航状态变更（navRestoringRef 在恢复导航期间阻止重复推送）
  useEffect(() => {
    if (navRestoringRef.current) {
      navRestoringRef.current = false
      return
    }
    if (prevUtilityPageRef.current !== utilityPage) {
      prevUtilityPageRef.current = utilityPage
      pushNavigation({ utilityPage, hash: window.location.hash })
      return
    }
    pushNavigation({ utilityPage, hash: window.location.hash })
  }, [routeSessionId, utilityPage])

  // 全局唯一 SSE 连接。所有 pane 通过 consumer 机制接收自己的 session 事件。
  useGlobalEvents(activeDirectories)

  // URL -> focused pane session
  useEffect(() => {
    if (lastRouteSessionIdRef.current === routeSessionId) return
    lastRouteSessionIdRef.current = routeSessionId
    if (paneLayoutStore.getFocusedSessionId() === routeSessionId) return
    syncingFromRouteRef.current = true
    paneLayoutStore.setFocusedSession(routeSessionId)
  }, [routeSessionId])

  // focused pane session -> URL（路由只反映当前 focused pane）
  useEffect(() => {
    if (syncingFromRouteRef.current) {
      syncingFromRouteRef.current = false
      return
    }
    if (paneLayoutStore.getFocusedSessionId() !== paneLayout.focusedSessionId) return
    if (paneLayout.focusedSessionId === routeSessionId && isSameDirectory(routeDirectory, focusedRouteDirectory)) return
    replaceSession(paneLayout.focusedSessionId, focusedRouteDirectory)
  }, [
    paneLayout.focusedPaneId,
    paneLayout.focusedSessionId,
    routeSessionId,
    routeDirectory,
    replaceSession,
    focusedRouteDirectory,
  ])

  const navigatePaneToSession = useCallback(
    (paneId: string, sessionId: string, directory?: string) => {
      paneLayoutStore.focusPane(paneId)
      paneLayoutStore.setPaneSession(paneId, sessionId)
      navigateRouteToSession(sessionId, directory)
    },
    [navigateRouteToSession],
  )

  const navigatePaneHome = useCallback(
    (paneId: string, directory?: string | null) => {
      paneLayoutStore.focusPane(paneId)
      paneLayoutStore.setPaneSession(paneId, null)
      navigateRouteHome(directory)
    },
    [navigateRouteHome],
  )

  const routeDirectoryForSession = useCallback(
    (directory: string | undefined) => {
      if (!directory) return ''
      if (pathInfo?.directory && isSameDirectory(directory, pathInfo.directory)) return ''
      return directory
    },
    [pathInfo?.directory],
  )

  const handleSelectSession = useCallback(
    (session: { id: string; directory?: string }) => {
      const paneId = paneLayout.focusedPaneId ?? paneLayoutStore.getFocusedPaneId()
      if (!paneId) return
      setUtilityPage(null)
      navigatePaneToSession(paneId, session.id, routeDirectoryForSession(session.directory))
    },
    [paneLayout.focusedPaneId, navigatePaneToSession, routeDirectoryForSession],
  )

  const handleNewSession = useCallback(() => {
    const paneId = paneLayout.focusedPaneId ?? paneLayoutStore.getFocusedPaneId()
    if (!paneId) return
    setUtilityPage(null)
    navigatePaneHome(paneId)
  }, [paneLayout.focusedPaneId, navigatePaneHome])

  const handleEnterSplitMode = useCallback(() => {
    paneLayoutStore.enterSplitMode(paneLayout.focusedSessionId)
  }, [paneLayout.focusedSessionId])

  const handleToggleFocusedPaneFullscreen = useCallback(() => {
    const paneId = paneLayout.focusedPaneId ?? paneLayoutStore.getFocusedPaneId()
    if (!paneId) return
    paneLayoutStore.togglePaneFullscreen(paneId)
  }, [paneLayout.focusedPaneId])

  const isMobilePanelLayout = chatViewport.interaction.sidebarBehavior === 'overlay'
  const mobileLeftPanelWidth = chatViewport.layout.sidebar.overlayWidth
  const mobilePageWidth = Math.max(1, chatViewport.layout.viewportWidth)
  const mobileChatScrollLeft = mobileLeftPanelWidth
  const mobileRightScrollLeft = mobileLeftPanelWidth + mobilePageWidth
  const mobilePagerRef = useRef<HTMLDivElement | null>(null)
  const mobilePagerInitializedRef = useRef(false)
  const mobilePagerInteractingRef = useRef(false)
  const mobileProgrammaticTargetRef = useRef<MobilePagerPage | null>(null)
  const mobileScrollEndTimerRef = useRef<number | null>(null)
  const mobileRightUnmountTimerRef = useRef<number | null>(null)
  const shouldRenderMobileRightPanelRef = useRef(false)
  const [shouldRenderMobileRightPanel, setShouldRenderMobileRightPanel] = useState(false)

  const setMobileRightPanelRendered = useCallback((rendered: boolean) => {
    if (shouldRenderMobileRightPanelRef.current === rendered) return
    shouldRenderMobileRightPanelRef.current = rendered
    setShouldRenderMobileRightPanel(rendered)
  }, [])

  const clearMobileRightUnmountTimer = useCallback(() => {
    if (mobileRightUnmountTimerRef.current === null) return
    window.clearTimeout(mobileRightUnmountTimerRef.current)
    mobileRightUnmountTimerRef.current = null
  }, [])

  const ensureMobileRightPanelRendered = useCallback(() => {
    clearMobileRightUnmountTimer()
    setMobileRightPanelRendered(true)
  }, [clearMobileRightUnmountTimer, setMobileRightPanelRendered])

  const mobileActivePage: MobilePagerPage = rightPanelOpen ? 'right' : sidebarExpanded ? 'left' : 'chat'

  const getMobilePageScrollLeft = useCallback(
    (page: MobilePagerPage) => (page === 'left' ? 0 : page === 'right' ? mobileRightScrollLeft : mobileChatScrollLeft),
    [mobileChatScrollLeft, mobileRightScrollLeft],
  )

  const scrollMobilePagerTo = useCallback(
    (page: MobilePagerPage, behavior: ScrollBehavior = 'smooth') => {
      const pager = mobilePagerRef.current
      if (!pager) return

      const left = getMobilePageScrollLeft(page)
      if (Math.abs(pager.scrollLeft - left) < 1) {
        mobileProgrammaticTargetRef.current = null
        pager.scrollTo({ left, behavior: 'auto' })
        return
      }

      mobileProgrammaticTargetRef.current = behavior === 'smooth' ? page : null
      pager.scrollTo({ left, behavior })
    },
    [getMobilePageScrollLeft],
  )

  const openUtilityPage = useCallback((page: MainUtilityPage) => {
    setUtilityPage(page)
    pushNavigation({ utilityPage: page, hash: window.location.hash })
    if (isMobilePanelLayout) {
      scrollMobilePagerTo('chat')
      setSidebarExpanded(false)
    }
  }, [isMobilePanelLayout, scrollMobilePagerTo, setSidebarExpanded])

  const openPluginPage = useCallback(() => {
    setExtensionPageTab('skills')
    openUtilityPage('plugins')
  }, [openUtilityPage])
  const openTaskPage = useCallback(() => openUtilityPage('tasks'), [openUtilityPage])
  const handleGoBack = useCallback(() => {
    const entry = navGoBack()
    if (!entry) return
    navRestoringRef.current = true
    setUtilityPage(entry.utilityPage as MainUtilityPage | null)
    prevUtilityPageRef.current = entry.utilityPage as MainUtilityPage | null
    const sessionMatch = entry.hash.match(/^#\/session\/(.+?)(?:\?|$)/)
    if (sessionMatch) {
      const sid = sessionMatch[1]
      const dirMatch = entry.hash.match(/[?&]dir=([^&]*)/)
      const dir = dirMatch ? decodeURIComponent(dirMatch[1]) : undefined
      const paneId = paneLayout.focusedPaneId ?? paneLayoutStore.getFocusedPaneId()
      if (paneId) navigatePaneToSession(paneId, sid, dir)
      else window.location.hash = entry.hash
    } else {
      window.location.hash = entry.hash
    }
  }, [paneLayout.focusedPaneId, navigatePaneToSession])
  const handleGoForward = useCallback(() => {
    const entry = navGoForward()
    if (!entry) return
    navRestoringRef.current = true
    setUtilityPage(entry.utilityPage as MainUtilityPage | null)
    prevUtilityPageRef.current = entry.utilityPage as MainUtilityPage | null
    const sessionMatch = entry.hash.match(/^#\/session\/(.+?)(?:\?|$)/)
    if (sessionMatch) {
      const sid = sessionMatch[1]
      const dirMatch = entry.hash.match(/[?&]dir=([^&]*)/)
      const dir = dirMatch ? decodeURIComponent(dirMatch[1]) : undefined
      const paneId = paneLayout.focusedPaneId ?? paneLayoutStore.getFocusedPaneId()
      if (paneId) navigatePaneToSession(paneId, sid, dir)
      else window.location.hash = entry.hash
    } else {
      window.location.hash = entry.hash
    }
  }, [paneLayout.focusedPaneId, navigatePaneToSession])
  const getNearestMobilePage = useCallback(
    (scrollLeft: number): MobilePagerPage => {
      const leftDistance = Math.abs(scrollLeft)
      const chatDistance = Math.abs(scrollLeft - mobileChatScrollLeft)
      const rightDistance = Math.abs(scrollLeft - mobileRightScrollLeft)

      if (leftDistance <= chatDistance && leftDistance <= rightDistance) return 'left'
      if (rightDistance <= chatDistance) return 'right'
      return 'chat'
    },
    [mobileChatScrollLeft, mobileRightScrollLeft],
  )

  const syncMobilePagerState = useCallback(() => {
    const pager = mobilePagerRef.current
    if (!pager) return

    const page = getNearestMobilePage(pager.scrollLeft)
    if (page === 'left') {
      if (!sidebarExpanded) setSidebarExpanded(true)
      if (rightPanelOpen) layoutStore.closeRightPanel()
      return
    }

    if (page === 'right') {
      ensureMobileRightPanelRendered()
      if (sidebarExpanded) setSidebarExpanded(false)
      if (!rightPanelOpen) layoutStore.openRightPanel()
      return
    }

    if (sidebarExpanded) setSidebarExpanded(false)
    if (rightPanelOpen) layoutStore.closeRightPanel()
  }, [ensureMobileRightPanelRendered, getNearestMobilePage, rightPanelOpen, setSidebarExpanded, sidebarExpanded])

  const handleMobilePagerScroll = useCallback(() => {
    const pager = mobilePagerRef.current
    if (!pager) return

    const scrollLeft = pager.scrollLeft

    // -1 (滑向左栏) 到 0 (对话页) 到 1 (滑向右栏)
    const rawProgress = (scrollLeft - mobileChatScrollLeft) / (scrollLeft < mobileChatScrollLeft ? mobileLeftPanelWidth : mobilePageWidth)
    const progress = Math.max(-1, Math.min(1, rawProgress))
    const absProgress = Math.abs(progress)
    const rightProgress = Math.max(0, progress)
    const easedRightProgress = rightProgress * rightProgress
    const originX = 50 - progress * 50

    pager.style.setProperty('--mobile-chat-rotate-y', `${progress * 10}deg`)
    pager.style.setProperty('--mobile-chat-scale', `${1 - absProgress * 0.06}`)
    pager.style.setProperty('--mobile-chat-offset-x', `${easedRightProgress * -48}px`)
    pager.style.setProperty('--mobile-chat-transform-origin', `${originX}% 50%`)

    if (scrollLeft > mobileChatScrollLeft + 24) {
      ensureMobileRightPanelRendered()
    }

    if (mobileScrollEndTimerRef.current !== null) {
      window.clearTimeout(mobileScrollEndTimerRef.current)
    }

    mobileScrollEndTimerRef.current = window.setTimeout(() => {
      mobileScrollEndTimerRef.current = null
      if (mobilePagerInteractingRef.current) return

      if (mobileProgrammaticTargetRef.current) {
        const targetLeft = getMobilePageScrollLeft(mobileProgrammaticTargetRef.current)
        if (Math.abs(pager.scrollLeft - targetLeft) >= 2) return
        mobileProgrammaticTargetRef.current = null
      }

      syncMobilePagerState()
    }, MOBILE_PAGER_SCROLL_END_MS)
  }, [
    ensureMobileRightPanelRendered,
    getMobilePageScrollLeft,
    mobileChatScrollLeft,
    mobileLeftPanelWidth,
    mobilePageWidth,
    syncMobilePagerState,
  ])

  const handleMobilePagerInteractionStart = useCallback(() => {
    mobilePagerInteractingRef.current = true
    mobileProgrammaticTargetRef.current = null
  }, [])

  const handleMobilePagerInteractionEnd = useCallback(() => {
    mobilePagerInteractingRef.current = false

    if (mobileScrollEndTimerRef.current !== null) {
      window.clearTimeout(mobileScrollEndTimerRef.current)
    }

    mobileScrollEndTimerRef.current = window.setTimeout(() => {
      mobileScrollEndTimerRef.current = null
      syncMobilePagerState()
    }, MOBILE_PAGER_SCROLL_END_MS)
  }, [syncMobilePagerState])

  useLayoutEffect(() => {
    if (!isMobilePanelLayout) {
      mobilePagerInitializedRef.current = false
      return
    }

    const page = rightPanelOpen ? 'right' : sidebarExpanded ? 'left' : 'chat'
    if (!mobilePagerInitializedRef.current) {
      const pager = mobilePagerRef.current
      if (pager) {
        pager.scrollLeft = getMobilePageScrollLeft(page)
      }
      mobileProgrammaticTargetRef.current = null
      mobilePagerInitializedRef.current = true
      return
    }

    const frameId = window.requestAnimationFrame(() => {
      scrollMobilePagerTo(page, 'smooth')
    })
    return () => window.cancelAnimationFrame(frameId)
  }, [getMobilePageScrollLeft, isMobilePanelLayout, rightPanelOpen, scrollMobilePagerTo, sidebarExpanded])

  useEffect(() => {
    if (!isMobilePanelLayout) {
      clearMobileRightUnmountTimer()
      const frameId = window.requestAnimationFrame(() => setMobileRightPanelRendered(false))
      return () => window.cancelAnimationFrame(frameId)
    }

    if (rightPanelOpen) {
      clearMobileRightUnmountTimer()
      const frameId = window.requestAnimationFrame(() => setMobileRightPanelRendered(true))
      return () => window.cancelAnimationFrame(frameId)
    }

    clearMobileRightUnmountTimer()
    mobileRightUnmountTimerRef.current = window.setTimeout(() => {
      setMobileRightPanelRendered(false)
      mobileRightUnmountTimerRef.current = null
    }, MOBILE_RIGHT_PANEL_UNMOUNT_MS)

    return clearMobileRightUnmountTimer
  }, [clearMobileRightUnmountTimer, isMobilePanelLayout, rightPanelOpen, setMobileRightPanelRendered])

  useEffect(() => {
    if (!isMobilePanelLayout || !rightPanelOpen || !sidebarExpanded) return

    const frameId = window.requestAnimationFrame(() => setSidebarExpanded(false))
    return () => window.cancelAnimationFrame(frameId)
  }, [isMobilePanelLayout, rightPanelOpen, setSidebarExpanded, sidebarExpanded])

  useEffect(() => {
    return () => {
      if (mobileScrollEndTimerRef.current !== null) window.clearTimeout(mobileScrollEndTimerRef.current)
      if (mobileRightUnmountTimerRef.current !== null) window.clearTimeout(mobileRightUnmountTimerRef.current)
      mobileProgrammaticTargetRef.current = null
    }
  }, [])

  const handleOpenSidebar = useCallback(() => {
    if (isMobilePanelLayout && rightPanelOpen) {
      layoutStore.closeRightPanel()
    }
    if (isMobilePanelLayout) {
      scrollMobilePagerTo('left')
    }
    setSidebarExpanded(true)
  }, [isMobilePanelLayout, rightPanelOpen, scrollMobilePagerTo, setSidebarExpanded])

  const handleCloseSidebar = useCallback(() => {
    if (isMobilePanelLayout) {
      scrollMobilePagerTo('chat')
    }
    setSidebarExpanded(false)
  }, [isMobilePanelLayout, scrollMobilePagerTo, setSidebarExpanded])

  const handleToggleSidebar = useCallback(() => {
    if (!isMobilePanelLayout) {
      if (sidebarTransitionTimerRef.current !== null) window.clearTimeout(sidebarTransitionTimerRef.current)
      window.dispatchEvent(new CustomEvent('panel-resize-start'))
      sidebarTransitionTimerRef.current = window.setTimeout(() => {
        sidebarTransitionTimerRef.current = null
        window.dispatchEvent(new CustomEvent('panel-resize-end'))
      }, SIDEBAR_TRANSITION_MS + 50)
    }

    if (sidebarExpanded) {
      setSidebarPreviewOpen(false)
      handleCloseSidebar()
    } else {
      setSidebarPreviewOpen(false)
      handleOpenSidebar()
    }
  }, [handleCloseSidebar, handleOpenSidebar, isMobilePanelLayout, sidebarExpanded])

  const openSidebarPreview = useCallback(() => {
    if (sidebarExpanded || isMobilePanelLayout) return
    if (sidebarPreviewCloseTimerRef.current !== null) {
      window.clearTimeout(sidebarPreviewCloseTimerRef.current)
      sidebarPreviewCloseTimerRef.current = null
    }
    setSidebarPreviewOpen(true)
  }, [isMobilePanelLayout, sidebarExpanded])

  const closeSidebarPreview = useCallback(() => {
    if (sidebarExpanded) return
    if (sidebarPreviewCloseTimerRef.current !== null) window.clearTimeout(sidebarPreviewCloseTimerRef.current)
    sidebarPreviewCloseTimerRef.current = window.setTimeout(() => {
      sidebarPreviewCloseTimerRef.current = null
      setSidebarPreviewOpen(false)
    }, 120)
  }, [sidebarExpanded])

  useEffect(() => {
    return () => {
      if (sidebarTransitionTimerRef.current !== null) {
        window.clearTimeout(sidebarTransitionTimerRef.current)
        window.dispatchEvent(new CustomEvent('panel-resize-end'))
      }
      if (sidebarPreviewCloseTimerRef.current !== null) {
        window.clearTimeout(sidebarPreviewCloseTimerRef.current)
      }
    }
  }, [])

  const handleToggleRightPanel = useCallback(() => {
    if (!isMobilePanelLayout) {
      layoutStore.toggleRightPanel()
      return
    }

    if (rightPanelOpen) {
      scrollMobilePagerTo('chat')
      layoutStore.closeRightPanel()
      return
    }

    ensureMobileRightPanelRendered()
    if (sidebarExpanded) setSidebarExpanded(false)
    scrollMobilePagerTo('right')
    layoutStore.openRightPanel()
  }, [ensureMobileRightPanelRendered, isMobilePanelLayout, rightPanelOpen, scrollMobilePagerTo, setSidebarExpanded, sidebarExpanded])

  const focusedDirectory = focusedRouteDirectory || ''

  const [onboardingOpen, setOnboardingOpen] = useState(() => shouldShowOnboarding())
  const openSettingsTab = useCallback((tab: SettingsTab) => {
    setSettingsTab(tab)
    openUtilityPage('settings')
  }, [openUtilityPage])
  const openSettings = useCallback(() => {
    openSettingsTab('appearance')
  }, [openSettingsTab])
  const openProviderSettings = useCallback(() => {
    openSettingsTab('providers')
  }, [openSettingsTab])
  const openAboutSettings = useCallback(() => {
    openSettingsTab('about')
  }, [openSettingsTab])
  const openSettingsFromOnboarding = useCallback((tab: SettingsTab) => {
    setOnboardingOpen(false)
    openSettingsTab(tab)
  }, [openSettingsTab])
  const closeSettingsPage = useCallback(() => {
    setUtilityPage(null)
    if (shouldShowOnboarding()) setOnboardingOpen(true)
  }, [])
  const completeGettingStarted = useCallback(() => {
    completeOnboarding()
    setOnboardingOpen(false)
  }, [])

  const renderPaneLeaf = useCallback(
    (paneId: string, paneSessionId: string | null) => (
      <ChatPane
        key={paneId}
        paneId={paneId}
        sessionId={paneSessionId}
        isFocused={paneLayout.focusedPaneId === paneId}
        paneCount={paneLayout.paneCount}
        displayMode={paneLayout.isSplit && paneLayout.fullscreenPaneId !== paneId ? 'split' : 'single'}
        isPaneFullscreen={paneLayout.fullscreenPaneId === paneId}
        onOpenSidebar={handleOpenSidebar}
        onToggleRightPanel={handleToggleRightPanel}
        showSidebarButton={chatViewport.interaction.sidebarBehavior === 'overlay'}
        onSplitPane={splitPaneEnabled && !paneLayout.fullscreenPaneId ? handleEnterSplitMode : undefined}
        onTogglePaneFullscreen={paneLayout.isSplit ? handleToggleFocusedPaneFullscreen : undefined}
        onOpenSettings={openSettings}
        onOpenProviderSettings={openProviderSettings}
        navigatePaneToSession={navigatePaneToSession}
        navigatePaneHome={navigatePaneHome}
      />
    ),
    [
      paneLayout.focusedPaneId,
      paneLayout.paneCount,
      paneLayout.isSplit,
      paneLayout.fullscreenPaneId,
      chatViewport.interaction.sidebarBehavior,
      splitPaneEnabled,
      handleOpenSidebar,
      handleToggleRightPanel,
      handleEnterSplitMode,
      handleToggleFocusedPaneFullscreen,
      openSettings,
      openProviderSettings,
      navigatePaneToSession,
      navigatePaneHome,
    ],
  )

  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const openProject = useCallback(() => setProjectDialogOpen(true), [])
  const closeProjectDialog = useCallback(() => setProjectDialogOpen(false), [])

  // 桌面标题栏通过 CustomEvent 触发打开项目/设置
  useEffect(() => {
    void composerDraftStore.hydrateAll()
    const onOpenProject = () => openProject()
    const onOpenSettings = () => openSettings()
    window.addEventListener('titlebar:open-project', onOpenProject)
    window.addEventListener('titlebar:open-settings', onOpenSettings)
    return () => {
      window.removeEventListener('titlebar:open-project', onOpenProject)
      window.removeEventListener('titlebar:open-settings', onOpenSettings)
    }
  }, [openProject, openSettings])

  useEffect(() => {
    const restart = () => {
      resetOnboarding()
      setOnboardingOpen(true)
    }
    window.addEventListener('onboarding:restart', restart)
    return () => window.removeEventListener('onboarding:restart', restart)
  }, [])

  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const handleDeepLink = useCallback((deepLink: CustomOpenCodeDeepLink) => {
    const paneId = paneLayoutStore.getFocusedPaneId()
    if (!paneId) return

    setUtilityPage(null)
    setProjectDialogOpen(false)
    setCommandPaletteOpen(false)
    addDirectory(deepLink.directory)
    paneLayoutStore.setPaneSession(paneId, null)
    navigateRouteHome(deepLink.directory)

    const prompt = deepLink.action === 'new-session' ? deepLink.prompt : undefined
    if (!prompt) return
    requestAnimationFrame(() => {
      insertComposerDraft({
        paneId,
        text: prompt,
        mode: 'replace',
      })
    })
  }, [addDirectory, navigateRouteHome])
  const handleDeepLinkRef = useRef(handleDeepLink)
  handleDeepLinkRef.current = handleDeepLink

  useEffect(() => {
    let disposed = false
    const receive = (deepLink: CustomOpenCodeDeepLink) => handleDeepLinkRef.current(deepLink)
    const unsubscribe = window.customOpenCode.onDeepLink(receive)
    void window.customOpenCode.consumeInitialDeepLinks()
      .then(deepLinks => {
        if (disposed) return
        deepLinks.forEach(receive)
      })
      .catch(error => uiErrorHandler('consume deep links', error))
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  const handleNewTerminal = useCallback(async () => {
    try {
      const pty = await createPtySession({ cwd: focusedDirectory }, focusedDirectory)
      const tab: TerminalTab = {
        id: pty.id,
        title: pty.title || t('components:terminal.terminal'),
        status: 'connecting',
      }
      layoutStore.addTerminalTab(tab, true)
    } catch (error) {
      uiErrorHandler('create terminal', error)
    }
  }, [focusedDirectory, t])

  const keybindingHandlers = useMemo<KeybindingHandlers>(
    () => ({
      openSettings,
      openProject,
      commandPalette: () => setCommandPaletteOpen(true),
      toggleSidebar: handleToggleSidebar,
      toggleRightPanel: handleToggleRightPanel,
      focusInput: () => {
        const input = document.querySelector<HTMLTextAreaElement>('[data-input-box] textarea')
        input?.focus()
      },
      newSession: () => focusedController?.newSession(),
      archiveSession: () => focusedController?.archiveSession(),
      previousSession: () => focusedController?.previousSession(),
      nextSession: () => focusedController?.nextSession(),
      toggleTerminal: () => layoutStore.toggleBottomPanel(),
      newTerminal: handleNewTerminal,
      selectModel: () => focusedController?.openModelSelector(),
      toggleAgent: () => focusedController?.toggleAgent(),
      cancelMessage: () => focusedController?.cancelMessage(),
      copyLastResponse: () => focusedController?.copyLastResponse(),
      toggleFullAuto: () => focusedController?.toggleFullAuto(),
      // Pane
      focusNextPane: () => {
        paneLayoutStore.focusNextPane()
        requestAnimationFrame(() => {
          const pid = paneLayoutStore.getFocusedPaneId()
          if (pid) {
            const input = document.querySelector<HTMLTextAreaElement>(`[data-pane-id="${pid}"] textarea`)
            input?.focus()
          }
        })
      },
      focusPrevPane: () => {
        paneLayoutStore.focusPrevPane()
        requestAnimationFrame(() => {
          const pid = paneLayoutStore.getFocusedPaneId()
          if (pid) {
            const input = document.querySelector<HTMLTextAreaElement>(`[data-pane-id="${pid}"] textarea`)
            input?.focus()
          }
        })
      },
      splitRight: () => {
        const pid = paneLayout.focusedPaneId ?? paneLayoutStore.getFocusedPaneId()
        if (pid && splitPaneEnabled) paneLayoutStore.splitPane(pid, 'horizontal')
      },
      splitDown: () => {
        const pid = paneLayout.focusedPaneId ?? paneLayoutStore.getFocusedPaneId()
        if (pid && splitPaneEnabled) paneLayoutStore.splitPane(pid, 'vertical')
      },
      closePane: () => {
        const pid = paneLayout.focusedPaneId ?? paneLayoutStore.getFocusedPaneId()
        if (pid && paneLayout.isSplit) paneLayoutStore.closePane(pid)
      },
      togglePaneFullscreen: () => {
        if (paneLayout.isSplit) handleToggleFocusedPaneFullscreen()
      },
    }),
    [
      openSettings,
      openProject,
      focusedController,
      handleToggleSidebar,
      handleToggleRightPanel,
      handleNewTerminal,
      paneLayout.focusedPaneId,
      paneLayout.isSplit,
      splitPaneEnabled,
      handleToggleFocusedPaneFullscreen,
    ],
  )

  useGlobalKeybindings(keybindingHandlers)

  const commands = useMemo<CommandItem[]>(() => {
    const getShortcut = (action: string) =>
      keybindingStore.getKey(action as import('./store/keybindingStore').KeybindingAction)

    return [
      {
        id: 'openSettings',
        label: t('commands:openSettings'),
        description: t('commands:openSettingsDesc'),
        category: t('commands:categories.general'),
        shortcut: getShortcut('openSettings'),
        action: openSettings,
      },
      {
        id: 'openProject',
        label: t('commands:openProject'),
        description: t('commands:openProjectDesc'),
        category: t('commands:categories.general'),
        shortcut: getShortcut('openProject'),
        action: openProject,
      },
      {
        id: 'openSettingsShortcuts',
        label: t('commands:openShortcutsSettings'),
        description: t('commands:openShortcutsSettingsDesc'),
        category: t('commands:categories.general'),
        action: () => {
          openSettingsTab('keybindings')
        },
      },
      {
        id: 'toggleSidebar',
        label: t('commands:toggleSidebar'),
        description: t('commands:toggleSidebarDesc'),
        category: t('commands:categories.general'),
        shortcut: getShortcut('toggleSidebar'),
        action: handleToggleSidebar,
      },
      {
        id: 'toggleRightPanel',
        label: t('commands:toggleRightPanel'),
        description: t('commands:toggleRightPanelDesc'),
        category: t('commands:categories.general'),
        shortcut: getShortcut('toggleRightPanel'),
        action: handleToggleRightPanel,
      },
      {
        id: 'focusInput',
        label: t('commands:focusInput'),
        description: t('commands:focusInputDesc'),
        category: t('commands:categories.general'),
        shortcut: getShortcut('focusInput'),
        action: () => {
          const input = document.querySelector<HTMLTextAreaElement>('[data-input-box] textarea')
          input?.focus()
        },
      },
      {
        id: 'newSession',
        label: t('commands:newSession'),
        description: t('commands:newSessionDesc'),
        category: t('commands:categories.session'),
        shortcut: getShortcut('newSession'),
        action: () => focusedController?.newSession(),
      },
      {
        id: 'archiveSession',
        label: t('commands:archiveSession'),
        description: t('commands:archiveSessionDesc'),
        category: t('commands:categories.session'),
        shortcut: getShortcut('archiveSession'),
        action: () => focusedController?.archiveSession(),
      },
      {
        id: 'previousSession',
        label: t('commands:previousSession'),
        description: t('commands:previousSessionDesc'),
        category: t('commands:categories.session'),
        shortcut: getShortcut('previousSession'),
        action: () => focusedController?.previousSession(),
      },
      {
        id: 'nextSession',
        label: t('commands:nextSession'),
        description: t('commands:nextSessionDesc'),
        category: t('commands:categories.session'),
        shortcut: getShortcut('nextSession'),
        action: () => focusedController?.nextSession(),
      },
      {
        id: 'toggleTerminal',
        label: t('commands:toggleTerminal'),
        description: t('commands:toggleTerminalDesc'),
        category: t('commands:categories.terminal'),
        shortcut: getShortcut('toggleTerminal'),
        action: () => layoutStore.toggleBottomPanel(),
      },
      {
        id: 'newTerminal',
        label: t('commands:newTerminal'),
        description: t('commands:newTerminalDesc'),
        category: t('commands:categories.terminal'),
        shortcut: getShortcut('newTerminal'),
        action: handleNewTerminal,
      },
      {
        id: 'selectModel',
        label: t('commands:selectModel'),
        description: t('commands:selectModelDesc'),
        category: t('commands:categories.model'),
        shortcut: getShortcut('selectModel'),
        action: () => focusedController?.openModelSelector(),
      },
      {
        id: 'toggleAgent',
        label: t('commands:toggleAgent'),
        description: t('commands:toggleAgentDesc'),
        category: t('commands:categories.model'),
        shortcut: getShortcut('toggleAgent'),
        action: () => focusedController?.toggleAgent(),
      },
      {
        id: 'copyLastResponse',
        label: t('commands:copyLastResponse'),
        description: t('commands:copyLastResponseDesc'),
        category: t('commands:categories.message'),
        shortcut: getShortcut('copyLastResponse'),
        action: () => focusedController?.copyLastResponse(),
      },
      {
        id: 'cancelMessage',
        label: t('commands:cancelMessage'),
        description: t('commands:cancelMessageDesc'),
        category: t('commands:categories.message'),
        shortcut: getShortcut('cancelMessage'),
        action: () => focusedController?.cancelMessage(),
        when: () => !!focusedController?.isStreaming,
      },
      // Pane
      {
        id: 'focusNextPane',
        label: t('commands:focusNextPane'),
        description: t('commands:focusNextPaneDesc'),
        category: t('commands:categories.pane'),
        shortcut: getShortcut('focusNextPane'),
        action: () => paneLayoutStore.focusNextPane(),
      },
      {
        id: 'focusPrevPane',
        label: t('commands:focusPrevPane'),
        description: t('commands:focusPrevPaneDesc'),
        category: t('commands:categories.pane'),
        shortcut: getShortcut('focusPrevPane'),
        action: () => paneLayoutStore.focusPrevPane(),
      },
      {
        id: 'splitRight',
        label: t('commands:splitRight'),
        description: t('commands:splitRightDesc'),
        category: t('commands:categories.pane'),
        shortcut: getShortcut('splitRight'),
        action: () => {
          const pid = paneLayout.focusedPaneId ?? paneLayoutStore.getFocusedPaneId()
          if (pid && splitPaneEnabled) paneLayoutStore.splitPane(pid, 'horizontal')
        },
      },
      {
        id: 'splitDown',
        label: t('commands:splitDown'),
        description: t('commands:splitDownDesc'),
        category: t('commands:categories.pane'),
        shortcut: getShortcut('splitDown'),
        action: () => {
          const pid = paneLayout.focusedPaneId ?? paneLayoutStore.getFocusedPaneId()
          if (pid && splitPaneEnabled) paneLayoutStore.splitPane(pid, 'vertical')
        },
      },
      {
        id: 'closePane',
        label: t('commands:closePane'),
        description: t('commands:closePaneDesc'),
        category: t('commands:categories.pane'),
        shortcut: getShortcut('closePane'),
        action: () => {
          const pid = paneLayout.focusedPaneId ?? paneLayoutStore.getFocusedPaneId()
          if (pid && paneLayout.isSplit) paneLayoutStore.closePane(pid)
        },
        when: () => paneLayout.isSplit,
      },
      {
        id: 'togglePaneFullscreen',
        label: t('commands:togglePaneFullscreen'),
        description: t('commands:togglePaneFullscreenDesc'),
        category: t('commands:categories.pane'),
        shortcut: getShortcut('togglePaneFullscreen'),
        action: () => {
          if (paneLayout.isSplit) handleToggleFocusedPaneFullscreen()
        },
        when: () => paneLayout.isSplit,
      },
    ]
  }, [
    t,
    openSettings,
    openProject,
    openSettingsTab,
    handleToggleSidebar,
    handleToggleRightPanel,
    focusedController,
    handleNewTerminal,
    paneLayout.focusedPaneId,
    paneLayout.isSplit,
    splitPaneEnabled,
    handleToggleFocusedPaneFullscreen,
  ])

  const appShellStyle = useMemo(
    () =>
      ({
        '--sidebar-width': `${chatViewport.layout.sidebar.dockedWidth}px`,
      }) as CSSProperties,
    [chatViewport.layout.sidebar.dockedWidth],
  )
  const utilityPageContent = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-bg-100">
      <Suspense fallback={null}>
        {utilityPage === 'tasks' ? <TaskPanel onOpenSession={(sessionID, directory) => handleSelectSession({ id: sessionID, directory })} /> : utilityPage === 'plugins' ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="window-drag-region shrink-0 border-b border-border-200/60 px-5 pb-3 pt-2.5">
              <div className="mb-2">
                <div className="text-[length:var(--fs-lg)] font-semibold text-text-100">{t('components:extensionHub.title')}</div>
              </div>
              <div role="tablist" aria-label={t('components:extensionHub.title')} className="scrollbar-none flex items-center gap-1 overflow-x-auto">
                {([
                  { id: 'skills', label: t('chat:sidebar.skills'), icon: <TeachIcon size={14} /> },
                  { id: 'plugins', label: t('chat:sidebar.plugins'), icon: <PuzzleIcon size={14} /> },
                  { id: 'mcp', label: t('chat:sidebar.mcpServers'), icon: <PlugIcon size={14} /> },
                  { id: 'kits', label: t('components:expertKit.nav'), icon: <LayersIcon size={14} /> },
                ] satisfies { id: ExtensionPageTab; label: string; icon: ReactNode }[]).map(item => (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={extensionPageTab === item.id}
                    onClick={() => setExtensionPageTab(item.id)}
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[length:var(--fs-sm)] font-medium transition-colors ${extensionPageTab === item.id ? 'bg-bg-200 text-text-100' : 'text-text-400 hover:text-text-100'}`}
                  >
                    {item.icon}
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              {extensionPageTab === 'skills' ? <SkillPanel /> : extensionPageTab === 'plugins' ? <PluginPanel /> : extensionPageTab === 'mcp' ? <McpPanel /> : <ExpertKitPanel />}
            </div>
          </div>
        ) : null}
      </Suspense>
    </div>
  )

  return (
    <div
      className="app-shell relative flex h-full flex-col overflow-hidden"
      data-sidebar-expanded={sidebarExpanded ? 'true' : 'false'}
      style={appShellStyle}
    >
      <button type="button" className="skip-to-composer" onClick={() => document.querySelector<HTMLTextAreaElement>('[data-composer-input]')?.focus()}>{t('chat:inputToolbar.skipToComposer')}</button>
      <DesktopTitlebar />
      {isElectron() && getDesktopPlatform() === 'windows' ? (
        <ElectronWindowsTitlebar
          sidebarExpanded={sidebarExpanded}
          onToggleSidebar={handleToggleSidebar}
          onNewTask={handleNewSession}
          onOpenSidebarPreview={openSidebarPreview}
          onCloseSidebarPreview={closeSidebarPreview}
          onOpenSearch={() => setSessionSearchOpen(true)}
          sidebarTitle={sidebarExpanded ? t('chat:sidebar.collapseSidebar') : t('chat:sidebar.expandSidebar')}
          newTaskTitle={t('chat:sidebar.newChat')}
          searchTitle={t('chat:sidebar.search')}
          backTitle={t('components:desktopTitlebar.goBack')}
          forwardTitle={t('components:desktopTitlebar.goForward')}
          onGoBack={handleGoBack}
          onGoForward={handleGoForward}
        />
      ) : showTitlebarSidebarButton ? (
        <>
          <ElectronSidebarToggle
            expanded={sidebarExpanded}
            title={sidebarExpanded ? t('chat:sidebar.collapseSidebar') : t('chat:sidebar.expandSidebar')}
            onToggle={handleToggleSidebar}
            onPreviewOpen={openSidebarPreview}
            onPreviewClose={closeSidebarPreview}
          />
          <ElectronSidebarSearch title={t('chat:sidebar.search')} onOpen={() => setSessionSearchOpen(true)} />
          <ElectronHistoryNavigation backTitle={t('components:desktopTitlebar.goBack')} forwardTitle={t('components:desktopTitlebar.goForward')} onGoBack={handleGoBack} onGoForward={handleGoForward} />
        </>
      ) : null}
      <InternalDragLayer />
      <ChatViewportProvider value={chatViewport}>
        <div className={`relative flex min-h-0 flex-1 ${isMobilePanelLayout ? 'overflow-hidden' : ''}`}>
          <div
            className="relative flex min-h-0 flex-1 overflow-hidden"
            style={utilityPage === 'settings' ? { display: 'none' } : undefined}
          >
          {isMobilePanelLayout ? (
            <>
              <div
                ref={mobilePagerRef}
                className="mobile-chat-pager absolute inset-x-0 top-0 -bottom-4 flex overflow-x-auto overflow-y-hidden bg-[hsl(var(--chat-bg))] pb-4"
                style={{
                  scrollSnapType: 'x mandatory',
                  overscrollBehaviorX: 'contain',
                  scrollbarWidth: 'none',
                  WebkitOverflowScrolling: 'touch',
                  perspective: '1200px',
                  perspectiveOrigin: '50% 50%',
                }}
                onScroll={handleMobilePagerScroll}
                onTouchStart={handleMobilePagerInteractionStart}
                onTouchEnd={handleMobilePagerInteractionEnd}
                onTouchCancel={handleMobilePagerInteractionEnd}
              >
                <section
                  className="sidebar-surface h-full shrink-0 overflow-hidden"
                  aria-hidden={mobileActivePage !== 'left'}
                  inert={mobileActivePage !== 'left'}
                  style={{
                    width: `${mobileLeftPanelWidth}px`,
                    flexBasis: `${mobileLeftPanelWidth}px`,
                    scrollSnapAlign: 'start',
                    scrollSnapStop: 'always',
                  }}
                >
                  <Sidebar
                    isOpen={sidebarExpanded}
                    selectedSessionId={paneLayout.focusedSessionId}
                    onSelectSession={handleSelectSession}
                    onNewSession={handleNewSession}
                    onOpen={handleOpenSidebar}
                    onClose={handleCloseSidebar}
                    onOpenSettings={openSettings}
                    onOpenNotifications={() => setNotificationCenterOpen(true)}
                    onOpenSearch={() => setSessionSearchOpen(true)}
                    onOpenPlugins={openPluginPage}
                    onOpenTasks={openTaskPage}
                    activeUtilityPage={utilityPage === 'settings' ? null : utilityPage}
                    projectDialogOpen={projectDialogOpen}
                    onProjectDialogClose={closeProjectDialog}
                    mobileInline
                  />
                </section>

                <section
                  ref={surfaceRef}
                  className="relative h-full shrink-0 overflow-visible bg-[hsl(var(--chat-bg))]"
                  style={{
                    width: `${mobilePageWidth}px`,
                    flexBasis: `${mobilePageWidth}px`,
                    scrollSnapAlign: 'start',
                    scrollSnapStop: 'always',
                  }}
                >
                  <div
                    className="absolute inset-y-0 -left-4 -right-4 z-10 flex flex-col overflow-hidden bg-[hsl(var(--chat-bg))] rounded-xl shadow-[0_0_24px_hsl(var(--always-black)/0.15)] [contain:layout_paint]"
                    aria-hidden={mobileActivePage !== 'chat'}
                    inert={mobileActivePage !== 'chat'}
                    style={{
                      transform: 'translate3d(var(--mobile-chat-offset-x, 0px), 0, 0) rotateY(var(--mobile-chat-rotate-y, 0deg)) scale(var(--mobile-chat-scale, 1))',
                      transformOrigin: 'var(--mobile-chat-transform-origin, 50% 50%)',
                      transformStyle: 'preserve-3d',
                      backfaceVisibility: 'hidden',
                      willChange: 'transform',
                    }}
                  >
                    {utilityPage ? (
                      utilityPageContent
                    ) : (
                      <div className={`flex-1 min-h-0 px-4 ${paneLayout.isSplit && !paneLayout.fullscreenPaneId ? 'py-2' : ''}`}>
                        <SplitContainer
                          node={paneLayout.root}
                          renderLeaf={renderPaneLeaf}
                          fullscreenPaneId={paneLayout.fullscreenPaneId}
                        />
                      </div>
                    )}

                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 z-[80] rounded-xl border-x border-border-200/50"
                    />
                  </div>

                  {sidebarExpanded && (
                    <button
                      type="button"
                      aria-label={t('chat:sidebar.collapseSidebar')}
                      className="absolute inset-0 z-[70] cursor-default bg-transparent [touch-action:pan-x]"
                      onClick={handleCloseSidebar}
                    />
                  )}
                </section>

                <section
                  className="h-full shrink-0 overflow-hidden bg-[hsl(var(--chat-bg))]"
                  aria-hidden={mobileActivePage !== 'right'}
                  inert={mobileActivePage !== 'right'}
                  style={{
                    width: `${mobilePageWidth}px`,
                    flexBasis: `${mobilePageWidth}px`,
                    scrollSnapAlign: 'start',
                    scrollSnapStop: 'always',
                  }}
                >
                  <RightPanel
                    directory={focusedDirectory}
                    sessionId={paneLayout.focusedSessionId}
                    inline
                    renderPanelContent={rightPanelOpen || shouldRenderMobileRightPanel}
                  />
                </section>
              </div>

              {utilityPage !== 'tasks' && utilityPage !== 'plugins' && (
                <BottomPanel directory={focusedDirectory} />
              )}
            </>
          ) : (
            <>
              {sidebarExpanded && (
                <Sidebar
                  isOpen={true}
                  selectedSessionId={paneLayout.focusedSessionId}
                  onSelectSession={handleSelectSession}
                  onNewSession={handleNewSession}
                  onOpen={handleOpenSidebar}
                  onClose={handleCloseSidebar}
                  onOpenSettings={openSettings}
                  onOpenNotifications={() => setNotificationCenterOpen(true)}
                  onOpenSearch={() => setSessionSearchOpen(true)}
                  onOpenPlugins={openPluginPage}
                  onOpenTasks={openTaskPage}
                  activeUtilityPage={utilityPage === 'settings' ? null : utilityPage}
                  projectDialogOpen={projectDialogOpen}
                  onProjectDialogClose={closeProjectDialog}
                />
              )}

              {!sidebarExpanded && sidebarPreviewOpen && (
                <div
                  className="sidebar-surface absolute left-0 top-0 bottom-0 z-[250]"
                  onPointerEnter={openSidebarPreview}
                  onPointerLeave={closeSidebarPreview}
                >
                  <Sidebar
                    isOpen={true}
                    selectedSessionId={paneLayout.focusedSessionId}
                    onSelectSession={handleSelectSession}
                    onNewSession={handleNewSession}
                    onOpen={handleOpenSidebar}
                    onClose={handleCloseSidebar}
                    onOpenSettings={openSettings}
                    onOpenNotifications={() => setNotificationCenterOpen(true)}
                    onOpenSearch={() => setSessionSearchOpen(true)}
                    onOpenPlugins={openPluginPage}
                    onOpenTasks={openTaskPage}
                    activeUtilityPage={utilityPage === 'settings' ? null : utilityPage}
                    projectDialogOpen={projectDialogOpen}
                    onProjectDialogClose={closeProjectDialog}
                    previewMode
                  />
                </div>
              )}

              <div className="chat-surface flex-1 flex min-w-0 h-full p-1">
                <div
                  ref={surfaceRef}
                  className="chat-surface-card flex-1 flex flex-col min-w-0 overflow-hidden rounded-xl border border-border-200/40 bg-[hsl(var(--chat-bg))]"
                  style={{ minWidth: `${CHAT_SURFACE_MIN_WIDTH}px` }}
                >
                  {utilityPage === 'tasks' || utilityPage === 'plugins' ? (
                    utilityPageContent
                  ) : (
                    <>
                      <div className={paneLayout.isSplit && !paneLayout.fullscreenPaneId ? 'flex-1 min-h-0 p-2' : 'flex-1 min-h-0'}>
                        <SplitContainer
                          node={paneLayout.root}
                          renderLeaf={renderPaneLeaf}
                          fullscreenPaneId={paneLayout.fullscreenPaneId}
                        />
                      </div>

                      <BottomPanel directory={focusedDirectory} />
                    </>
                  )}
                </div>

                {utilityPage !== 'tasks' && utilityPage !== 'plugins' && (
                  <RightPanel directory={focusedDirectory} sessionId={paneLayout.focusedSessionId} />
                )}
              </div>
            </>
          )}
          </div>
          {utilityPage === 'settings' && <SettingsPage onBack={closeSettingsPage} />}
          <ToastContainer onOpenAbout={openAboutSettings} />
        </div>

        <Suspense fallback={null}>
          <OnboardingDialog isOpen={onboardingOpen} projectSelected={Boolean(currentDirectory)} onOpenSettings={openSettingsFromOnboarding} onComplete={completeGettingStarted} />
          <CommandPalette
            isOpen={commandPaletteOpen}
            onClose={() => setCommandPaletteOpen(false)}
            commands={commands}
          />
        </Suspense>

        <SessionSearchDialog
          isOpen={sessionSearchOpen}
          onClose={() => setSessionSearchOpen(false)}
          onSelectSession={handleSelectSession}
        />

        <NotificationCenterDialog isOpen={notificationCenterOpen} onClose={() => setNotificationCenterOpen(false)} />

      </ChatViewportProvider>
    </div>
  )
}

export default App
