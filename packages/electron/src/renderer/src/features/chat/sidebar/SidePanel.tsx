import { useCallback, useMemo, useState, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { SessionList } from "../../sessions"
import { getProjectGroupIdentity } from "./projectGrouping"
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog"
import { ActiveSessionItem } from "./ActiveSessionItem"
import { NotificationItem } from "./NotificationItem"
import { SidebarFooter } from "./SidebarFooter"
import { buildActiveSessionTree } from "./activeSessionTree"
import {
  PROJECT_SESSION_PREVIEW_LIMIT,
  collapsedProjectSessionPreviews,
  projectSessionsForDisplay,
} from "./projectSessionPreview"
import {
  FolderIcon,
  FolderOpenIcon,
  GlobeIcon,
  PlusIcon,
  TrashIcon,
  ArchiveIcon,
  CirclePlusIcon,
  SearchIcon,
  PencilIcon,
  CheckIcon,
  SpinnerIcon,
  PackagePlusIcon,
  ClockIcon,
  GitBranchIcon,
  MessageSquareIcon,
  PinIcon,
} from "../../../components/Icons"
import {
  useDirectory,
  useGitWorkspaceCatalog,
  useReorderableList,
  useSessions,
} from "../../../hooks"
import { useSessionContext } from "../../../contexts/useSessionContext"
import { useLayoutStore, childSessionStore, serverStore } from "../../../store"
import { useBusySessions } from "../../../store/activeSessionStore"
import { notificationStore, useNotifications } from "../../../store/notificationStore"
import { pinnedSessionsStore } from "../../../store/pinnedSessionsStore"
import type { NotificationEntry } from "../../../store/notificationStore"
import {
  updateSession,
  archiveSession as apiArchiveSession,
  getSession,
  getSessions,
  getVcsInfo,
  isExternalChannelSession,
  isScheduledTaskSession,
  subscribeToConnectionState,
  type ApiSession,
  type ConnectionInfo,
} from "../../../api"
import {
  areSessionListsSame,
  getDirectoryName,
  isSameDirectory,
  normalizeToForwardSlash,
  serverStorage,
} from "../../../utils"
import { STORAGE_KEY_EXPANDED_PROJECTS, STORAGE_KEY_EXPANDED_CONVERSATIONS } from "../../../constants/storage"
import { clearSessionRuntimeState } from "../../../utils/sessionLifecycle"
import { uiErrorHandler } from "../../../utils"
import { isElectron, getDesktopPlatform } from "../../../utils/platform"

// 侧边栏设计模式：
// - 按钮结构统一，不因 expanded/collapsed 改变 DOM
// - 按钮内容使用 -translate-x-2 让图标在收起时居中
// - 文字用 opacity 过渡，不改变布局
// - 收起宽度 49px，展开宽度 288px

interface SidePanelProps {
  onNewSession: () => void
  onSelectSession: (session: ApiSession) => void
  onCloseMobile?: () => void
  selectedSessionId: string | null
  onAddProject: () => void
  onOpenSearch?: () => void
  onOpenPlugins?: () => void
  onOpenTasks?: () => void
  onExpandSidebar?: () => void
  activeNavigation?: "new" | "plugins" | "tasks" | null
  isMobile?: boolean
  isExpanded?: boolean
  onOpenSettings?: () => void
  onOpenNotifications?: () => void
}

function navigationItemClass(active: boolean) {
  return `h-9 flex items-center rounded-xl active:scale-[0.98] transition-all duration-300 overflow-hidden ${
    active ? "sidebar-selected-row sidebar-primary-text" : "sidebar-hover-row sidebar-primary-text"
  }`
}

interface ProjectItem {
  id: string
  worktree: string
  name: string
  pinnedAt?: number
  canReorder?: boolean
  memberDirectories?: string[]
  workspaceDirectories?: string[]
  sectionKind?: "project" | "workspace"
}

function ProjectInfoHover({
  project,
  disabled,
  children,
}: {
  project: ProjectItem
  disabled: boolean
  children: ReactNode
}) {
  const { t } = useTranslation("chat")
  const triggerRef = useRef<HTMLDivElement>(null)
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestRef = useRef(0)
  const loadedAtRef = useRef(0)
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [details, setDetails] = useState<{ branch: string | null; sessionCount: number | null } | null>(null)
  const [position, setPosition] = useState({ top: 8, left: 8, width: 340 })

  const updatePosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return

    const width = Math.min(340, window.innerWidth - 16)
    setPosition({
      top: Math.max(8, Math.min(rect.top, window.innerHeight - 176)),
      left: Math.max(8, Math.min(rect.right + 10, window.innerWidth - width - 8)),
      width,
    })
  }, [])

  const loadDetails = useCallback(async () => {
    if (isLoading || Date.now() - loadedAtRef.current < 30_000) return
    const request = ++requestRef.current
    setIsLoading(true)

    const [vcsInfo, sessions] = await Promise.all([
      getVcsInfo(project.worktree).catch(() => null),
      getSessions({
        roots: true,
        limit: 1000,
        directory: normalizeToForwardSlash(project.worktree) || project.worktree,
      }).catch(() => null),
    ])

    if (request !== requestRef.current) return
    setDetails({
      branch: vcsInfo?.branch ?? null,
      sessionCount: sessions?.filter((session) => !isScheduledTaskSession(session)).length ?? null,
    })
    loadedAtRef.current = Date.now()
    setIsLoading(false)
  }, [isLoading, project.worktree])

  const show = useCallback(() => {
    if (disabled) return
    if (openTimerRef.current) clearTimeout(openTimerRef.current)
    openTimerRef.current = setTimeout(() => {
      updatePosition()
      setIsOpen(true)
      void loadDetails()
    }, 250)
  }, [disabled, loadDetails, updatePosition])

  const hide = useCallback(() => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
    setIsOpen(false)
  }, [])

  useEffect(() => {
    if (!isOpen) return
    updatePosition()
    window.addEventListener("resize", updatePosition)
    window.addEventListener("scroll", updatePosition, true)
    return () => {
      window.removeEventListener("resize", updatePosition)
      window.removeEventListener("scroll", updatePosition, true)
    }
  }, [isOpen, updatePosition])

  useEffect(() => {
    return () => {
      requestRef.current += 1
      if (openTimerRef.current) clearTimeout(openTimerRef.current)
    }
  }, [])

  if (disabled) return children

  return (
    <div ref={triggerRef} onMouseEnter={show} onMouseLeave={hide} onPointerDown={hide}>
      {children}
      {isOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              className="pointer-events-none fixed z-[10000] rounded-xl border border-border-200/70 bg-bg-000/95 p-3.5 shadow-xl backdrop-blur-md"
              style={position}
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <FolderIcon size={17} className="shrink-0 text-text-300" />
                <div className="truncate text-[length:var(--fs-base)] font-semibold text-text-100">{project.name}</div>
              </div>
              <div className="my-3 h-px bg-border-200/60" />
              <div className="space-y-2.5 text-[length:var(--fs-sm)]">
                <div className="grid grid-cols-[18px_76px_minmax(0,1fr)] items-center gap-2">
                  <GitBranchIcon size={14} className="text-text-400" />
                  <span className="text-text-400">{t("sidebar.projectBranch")}</span>
                  <span className="truncate text-right font-medium text-text-200" title={details?.branch ?? undefined}>
                    {isLoading ? t("sidebar.projectInfoLoading") : (details?.branch ?? t("sidebar.projectNoBranch"))}
                  </span>
                </div>
                <div className="grid grid-cols-[18px_76px_minmax(0,1fr)] items-center gap-2">
                  <MessageSquareIcon size={14} className="text-text-400" />
                  <span className="text-text-400">{t("sidebar.projectSessionCount")}</span>
                  <span className="text-right font-medium text-text-200">
                    {isLoading ? t("sidebar.projectInfoLoading") : (details?.sessionCount ?? "—")}
                  </span>
                </div>
                <div className="grid grid-cols-[18px_76px_minmax(0,1fr)] items-start gap-2">
                  <FolderOpenIcon size={14} className="mt-0.5 text-text-400" />
                  <span className="text-text-400">{t("sidebar.projectPath")}</span>
                  <span className="break-all text-right leading-5 text-text-200">{project.worktree}</span>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

function getSelectionRange(visibleIds: string[], anchorId: string, targetId: string) {
  const startIndex = visibleIds.indexOf(anchorId)
  const endIndex = visibleIds.indexOf(targetId)

  if (startIndex === -1 || endIndex === -1) return null

  const from = Math.min(startIndex, endIndex)
  const to = Math.max(startIndex, endIndex)
  return visibleIds.slice(from, to + 1)
}

function findProjectGroupForDirectory(projects: ProjectItem[], directory: string) {
  return projects.find((project) => {
    if (isSameDirectory(project.id, directory) || isSameDirectory(project.worktree, directory)) {
      return true
    }

    if (project.workspaceDirectories?.some((workspace) => isSameDirectory(workspace, directory))) {
      return true
    }

    if (project.memberDirectories?.some((memberDirectory) => isSameDirectory(memberDirectory, directory))) {
      return true
    }

    return false
  })
}

function isDefaultWorkspaceDirectory(directory: string | undefined): boolean {
  if (!directory) return false
  const normalized = normalizeToForwardSlash(directory)
  return normalized.endsWith("/.opencodex/workspace") || normalized === ".opencodex/workspace"
}

export function SidePanel({
  onNewSession,
  onSelectSession,
  onCloseMobile,
  selectedSessionId,
  onAddProject,
  onOpenSearch,
  onOpenPlugins,
  onOpenTasks,
  onExpandSidebar,
  activeNavigation,
  isMobile = false,
  isExpanded = true,
  onOpenSettings,
  onOpenNotifications,
}: SidePanelProps) {
  const { t } = useTranslation(["chat", "common"])
  const desktopPlatform = getDesktopPlatform()
  const {
    currentDirectory,
    savedDirectories,
    setCurrentDirectory,
    removeDirectory,
    addDirectory,
    reorderDirectories,
    setDirectoriesPinned,
    pathInfo,
  } = useDirectory()
  const catalogDirectories = useMemo(
    () =>
      Array.from(
        new Set(
          savedDirectories
            .map((directory) => normalizeToForwardSlash(directory.path))
            .concat(currentDirectory ? [normalizeToForwardSlash(currentDirectory)] : []),
        ),
      ),
    [savedDirectories, currentDirectory],
  )
  const { catalog: gitWorkspaceCatalog, isLoading: isGitWorkspaceCatalogLoading } =
    useGitWorkspaceCatalog(catalogDirectories)
  const { sidebarShowChildSessions } = useLayoutStore()
  const normalizedCurrentDirectory = useMemo(
    () => (currentDirectory ? normalizeToForwardSlash(currentDirectory) : undefined),
    [currentDirectory],
  )
  const [connectionState, setConnectionState] = useState<ConnectionInfo | null>(null)
  const [connectionRefreshVersion, setConnectionRefreshVersion] = useState(0)
  const previousConnectionStateRef = useRef<ConnectionInfo["state"]>("disconnected")
  const [enabledTaskCount, setEnabledTaskCount] = useState(0)
  const [projectDeleteConfirm, setProjectDeleteConfirm] = useState<{ isOpen: boolean; projectId: string | null }>({
    isOpen: false,
    projectId: null,
  })
  const [projectContextMenu, setProjectContextMenu] = useState<{
    projectId: string
    x: number
    y: number
  } | null>(null)
  const projectContextMenuRef = useRef<HTMLDivElement>(null)
  const [sidebarTab, setSidebarTab] = useState<"recents" | "active">("recents")
  const [expandedProjectIds, setExpandedProjectIds] = useState<string[]>(
    () => serverStorage.getJSON<string[]>(STORAGE_KEY_EXPANDED_PROJECTS) ?? [],
  )
  const [expandedProjectSessionIds, setExpandedProjectSessionIds] = useState<string[]>([])
  const [expandedConversations, setExpandedConversations] = useState(
    () => serverStorage.get(STORAGE_KEY_EXPANDED_CONVERSATIONS) === "true",
  )

  const CONVERSATION_PREVIEW_LIMIT = 10

  useEffect(() => {
    serverStorage.setJSON(STORAGE_KEY_EXPANDED_PROJECTS, expandedProjectIds)
  }, [expandedProjectIds])

  useEffect(() => {
    serverStorage.set(STORAGE_KEY_EXPANDED_CONVERSATIONS, String(expandedConversations))
  }, [expandedConversations])

  useEffect(() => {
    setExpandedProjectSessionIds((prev) => collapsedProjectSessionPreviews(prev, expandedProjectIds))
  }, [expandedProjectIds])

  // ---- 编辑模式状态 ----
  const [isEditMode, setIsEditMode] = useState(false)
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set())
  const sessionSelectionAnchorIdRef = useRef<string | null>(null)
  const recentsSelectionRootRef = useRef<HTMLDivElement>(null)
  const projectsDropdownRef = useRef<HTMLDivElement>(null)
  // 批量删除确认弹窗
  const [batchDeleteSessionConfirm, setBatchDeleteSessionConfirm] = useState(false)
  const [isBatchDeleting, setIsBatchDeleting] = useState(false)

  useEffect(() => {
    if (!projectContextMenu) return

    const close = (event: MouseEvent) => {
      if (projectContextMenuRef.current?.contains(event.target as Node)) return
      setProjectContextMenu(null)
    }
    const closeImmediately = () => setProjectContextMenu(null)
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeImmediately()
    }

    window.addEventListener("mousedown", close, true)
    window.addEventListener("keydown", closeOnEscape, true)
    window.addEventListener("resize", closeImmediately)
    window.addEventListener("scroll", closeImmediately, true)
    return () => {
      window.removeEventListener("mousedown", close, true)
      window.removeEventListener("keydown", closeOnEscape, true)
      window.removeEventListener("resize", closeImmediately)
      window.removeEventListener("scroll", closeImmediately, true)
    }
  }, [projectContextMenu])

  const getVisibleSelectionIds = useCallback((kind: "session" | "project") => {
    const root = recentsSelectionRootRef.current
    if (!root) return []

    return Array.from(root.querySelectorAll<HTMLElement>(`[data-selection-kind="${kind}"]`))
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => element.dataset.selectionId)
      .filter((id): id is string => Boolean(id))
  }, [])

  const toggleSessionSelection = useCallback(
    (sessionId: string, options?: { shiftKey?: boolean }) => {
      const anchorId = sessionSelectionAnchorIdRef.current
      const visibleIds = getVisibleSelectionIds("session")

      setSelectedSessionIds((prev) => {
        if (options?.shiftKey && anchorId) {
          const range = getSelectionRange(visibleIds, anchorId, sessionId)
          if (range) {
            const next = new Set(prev)
            for (const id of range) next.add(id)
            return next
          }
        }

        const next = new Set(prev)
        if (next.has(sessionId)) next.delete(sessionId)
        else next.add(sessionId)
        return next
      })
      sessionSelectionAnchorIdRef.current = sessionId
    },
    [getVisibleSelectionIds],
  )

  const exitEditMode = useCallback(() => {
    setIsEditMode(false)
    setSelectedSessionIds(new Set())
    sessionSelectionAnchorIdRef.current = null
  }, [])

  const enterEditMode = useCallback(() => {
    setIsEditMode(true)
    sessionSelectionAnchorIdRef.current = null
  }, [])

  const showLabels = isExpanded || isMobile

  // Active sessions
  const busySessions = useBusySessions()
  useSyncExternalStore(
    childSessionStore.subscribe.bind(childSessionStore),
    childSessionStore.getVersion,
    childSessionStore.getVersion,
  )
  // Notification history
  const notifications = useNotifications()

  useEffect(() => {
    return subscribeToConnectionState((info) => {
      setConnectionState((prev) => (prev?.state === info.state ? prev : info))
      if (info.state === "connected" && previousConnectionStateRef.current !== "connected") {
        setConnectionRefreshVersion((version) => version + 1)
      }
      previousConnectionStateRef.current = info.state
    })
  }, [])

  useEffect(() => {
    if (typeof window.customOpenCode?.listTasks !== "function") return
    const load = () =>
      void window.customOpenCode
        .listTasks()
        .then((tasks) => setEnabledTaskCount(tasks.filter((task) => task.enabled).length))
        .catch(() => setEnabledTaskCount(0))
    load()
    const unsubscribe = window.customOpenCode.onTasksChanged?.(load)
    window.addEventListener("focus", load)
    return () => {
      unsubscribe?.()
      window.removeEventListener("focus", load)
    }
  }, [])

  const { sessions, isLoading, isLoadingMore, hasMore, search, setSearch, loadMore, deleteSession, refresh } =
    useSessionContext()
  const [shouldLoadExternalSessions, setShouldLoadExternalSessions] = useState(() => !isElectron())

  useEffect(() => {
    if (!isElectron()) return
    if (typeof window.customOpenCode?.imBridgeConfig !== "function") {
      setShouldLoadExternalSessions(true)
      return
    }

    let disposed = false
    const loadConfig = () => {
      void window.customOpenCode
        .imBridgeConfig()
        .then((config) => {
          if (disposed) return
          setShouldLoadExternalSessions(
            [config.feishu, config.qq, config.telegram, config.discord, config.wechat, config.dingtalk].some(
              (channel) => channel.enabled,
            ),
          )
        })
        .catch(() => {
          if (!disposed) setShouldLoadExternalSessions(true)
        })
    }

    loadConfig()
    const unsubscribe = window.customOpenCode.onImBridgeStateChanged?.((state) => {
      if (state.status === "starting" || state.status === "running") setShouldLoadExternalSessions(true)
    })
    window.addEventListener("focus", loadConfig)
    return () => {
      disposed = true
      unsubscribe?.()
      window.removeEventListener("focus", loadConfig)
    }
  }, [])

  const { sessions: globalSessions } = useSessions({ global: true, pageSize: 30, enabled: shouldLoadExternalSessions })
  const externalChannelSessions = useMemo(() => globalSessions.filter(isExternalChannelSession), [globalSessions])

  useEffect(() => {
    const directories = Array.from(
      new Set(
        externalChannelSessions
          .map((session) => normalizeToForwardSlash(session.directory))
          .filter((directory) => getDirectoryName(directory).endsWith("[im]")),
      ),
    )
    if (directories.length === 0) return

    // 只在目录首次出现（尚未在项目列表中）时自动展开，避免覆盖用户手动折叠的状态
    const newDirectories = directories.filter(
      (directory) => !savedDirectories.some((saved) => isSameDirectory(saved.path, directory)),
    )
    if (newDirectories.length === 0) return

    newDirectories.forEach((directory) => addDirectory(directory, { select: false }))
    setExpandedProjectIds((prev) => Array.from(new Set([...prev, ...newDirectories])))
  }, [addDirectory, externalChannelSessions, savedDirectories])

  const pinnedEntries = useSyncExternalStore(
    pinnedSessionsStore.subscribe,
    pinnedSessionsStore.getSnapshot,
    pinnedSessionsStore.getSnapshot,
  )
  // 缓存通过 API 拉取的 session 数据（sessions 列表中不存在的）
  const [fetchedSessions, setFetchedSessions] = useState<Record<string, ApiSession>>({})
  const [defaultSessions, setDefaultSessions] = useState<{ sessions: ApiSession[]; isLoading: boolean }>({
    sessions: [],
    isLoading: false,
  })
  const [projectSessions, setProjectSessions] = useState<
    Record<string, { sessions: ApiSession[]; isLoading: boolean }>
  >({})
  const [unavailablePinnedSessionIds, setUnavailablePinnedSessionIds] = useState<Set<string>>(() => new Set())

  // 为 active sessions 构建 sessionId -> ApiSession 的查找表
  const sessionLookup = useMemo(() => {
    const map = new Map<string, ApiSession>()
    for (const s of sessions) {
      map.set(s.id, s)
    }
    for (const s of defaultSessions.sessions) {
      map.set(s.id, s)
    }
    for (const s of externalChannelSessions) {
      map.set(s.id, s)
    }
    // fetchedSessions 作为补充（其他项目的 session）
    for (const [id, s] of Object.entries(fetchedSessions)) {
      if (!map.has(id)) {
        map.set(id, s)
      }
    }
    return map
  }, [sessions, defaultSessions.sessions, externalChannelSessions, fetchedSessions])

  const orderedSessions = useMemo(() => {
    const pinnedSet = new Set(pinnedEntries.map((e) => e.sessionId))
    const pinned = pinnedEntries
      .map((entry) => sessionLookup.get(entry.sessionId))
      .filter((session): session is ApiSession => Boolean(session))
    const rest = sessions.filter((s) => !pinnedSet.has(s.id))
    return [...pinned, ...rest]
  }, [pinnedEntries, sessionLookup, sessions])
  const pinnedDividerAfterIds = useMemo(() => {
    const lastPinned = pinnedEntries
      .map((entry) => sessionLookup.get(entry.sessionId))
      .filter((session): session is ApiSession => Boolean(session))
      .at(-1)
    if (!lastPinned) return undefined
    const pinnedSet = new Set(pinnedEntries.map((e) => e.sessionId))
    return sessions.some((s) => !pinnedSet.has(s.id)) ? new Set([lastPinned.id]) : undefined
  }, [pinnedEntries, sessionLookup, sessions])
  const resolvedPinnedSessions = useMemo(
    () =>
      pinnedEntries
        .map((entry) => sessionLookup.get(entry.sessionId))
        .filter((session): session is ApiSession => Boolean(session)),
    [pinnedEntries, sessionLookup],
  )
  const unavailablePinnedEntries = useMemo(
    () =>
      pinnedEntries.filter(
        (entry) => unavailablePinnedSessionIds.has(entry.sessionId) && !sessionLookup.has(entry.sessionId),
      ),
    [pinnedEntries, sessionLookup, unavailablePinnedSessionIds],
  )

  // 异步拉取不在 lookup 中的 active/notification/pinned/selected session
  useEffect(() => {
    const allNeeded: Array<{ sessionId: string; directory?: string; pinned?: boolean }> = [
      ...busySessions.map((e) => ({ sessionId: e.sessionId, directory: e.directory })),
      ...notifications.map((e) => ({ sessionId: e.sessionId, directory: e.directory })),
      ...pinnedEntries.map((e) => ({ sessionId: e.sessionId, directory: e.directory, pinned: true })),
    ]
    if (selectedSessionId && !sessionLookup.has(selectedSessionId)) {
      allNeeded.push({ sessionId: selectedSessionId, directory: currentDirectory || pathInfo?.directory || "" })
    }

    setUnavailablePinnedSessionIds((prev) => {
      if (prev.size === 0) return prev
      let changed = false
      const next = new Set(prev)
      for (const entry of pinnedEntries) {
        if (sessionLookup.has(entry.sessionId) && next.delete(entry.sessionId)) changed = true
      }
      return changed ? next : prev
    })

    // 全局通知（例如技能或设置操作）没有关联 session，不能调用单 session 接口补全。
    const missing = allNeeded.filter((entry) => entry.sessionId?.trim() && !sessionLookup.has(entry.sessionId))
    if (missing.length === 0) return

    let cancelled = false
    const fetchMissing = async () => {
      const results: Record<string, ApiSession> = {}
      await Promise.allSettled(
        missing.map(async (entry) => {
          try {
            const session = await getSession(entry.sessionId, entry.directory)
            if (!cancelled) {
              results[session.id] = session
              if (entry.pinned) {
                pinnedSessionsStore.update(session.id, {
                  directory: session.directory || entry.directory,
                  title: session.title || session.id.slice(0, 12) + "...",
                })
                setUnavailablePinnedSessionIds((prev) => {
                  if (!prev.has(session.id)) return prev
                  const next = new Set(prev)
                  next.delete(session.id)
                  return next
                })
              }
            }
          } catch {
            if (!cancelled && entry.pinned) {
              setUnavailablePinnedSessionIds((prev) => {
                if (prev.has(entry.sessionId)) return prev
                return new Set(prev).add(entry.sessionId)
              })
            }
          }
        }),
      )
      if (!cancelled && Object.keys(results).length > 0) {
        setFetchedSessions((prev) => ({ ...prev, ...results }))
      }
    }
    fetchMissing()
    return () => {
      cancelled = true
    }
  }, [
    busySessions,
    notifications,
    pinnedEntries,
    sessionLookup,
    selectedSessionId,
    currentDirectory,
    pathInfo?.directory,
  ])

  // ---- 子 session 展示数据 ----
  const rootSessionIds = useMemo(() => new Set(sessions.map((s) => s.id)), [sessions])

  const findParentId = useCallback(
    (id: string) => {
      const s = sessionLookup.get(id)
      if (s?.parentID) return s.parentID
      return childSessionStore.getSessionInfo(id)?.parentID
    },
    [sessionLookup],
  )

  // 开关开 → 拉 /children 全量：选中的 root 或选中子 session 时保持其父展开
  const expandedChildSessionIds = useMemo(() => {
    if (search || !sidebarShowChildSessions || !selectedSessionId) return undefined
    if (rootSessionIds.has(selectedSessionId)) return new Set([selectedSessionId])
    const pid = findParentId(selectedSessionId)
    if (pid && rootSessionIds.has(pid)) return new Set([pid])
    return undefined
  }, [search, sidebarShowChildSessions, selectedSessionId, rootSessionIds, findParentId])

  // 开关关 → 只挂活跃的 + 选中的子 session
  const inlineChildSessions = useMemo(() => {
    if (search) return undefined
    const map = new Map<string, ApiSession[]>()
    const add = (parentId: string, session: ApiSession) => {
      if (expandedChildSessionIds?.has(parentId)) return
      let arr = map.get(parentId)
      if (!arr) {
        arr = []
        map.set(parentId, arr)
      }
      if (!arr.some((s) => s.id === session.id)) arr.push(session)
    }
    for (const entry of busySessions) {
      const pid = findParentId(entry.sessionId)
      if (pid && rootSessionIds.has(pid)) {
        const s = sessionLookup.get(entry.sessionId)
        if (s) add(pid, s)
      }
    }
    if (!sidebarShowChildSessions && selectedSessionId && !rootSessionIds.has(selectedSessionId)) {
      const pid = findParentId(selectedSessionId)
      if (pid && rootSessionIds.has(pid)) {
        const s = sessionLookup.get(selectedSessionId)
        if (s) add(pid, s)
      }
    }
    return map.size > 0 ? map : undefined
  }, [
    search,
    busySessions,
    selectedSessionId,
    sidebarShowChildSessions,
    rootSessionIds,
    expandedChildSessionIds,
    sessionLookup,
    findParentId,
  ])

  const activeSessionTree = useMemo(
    () => buildActiveSessionTree(busySessions, findParentId),
    [busySessions, findParentId],
  )

  const buildProjectGroups = useCallback(
    (directories: typeof savedDirectories): ProjectItem[] => {
      const savedNameByPath = new Map(
        directories.map((directory) => [normalizeToForwardSlash(directory.path), directory.name]),
      )
      const groups = new Map<string, ProjectItem>()

      for (const directory of directories) {
        const normalizedDirectory = normalizeToForwardSlash(directory.path)
        const meta = gitWorkspaceCatalog.get(normalizedDirectory)
        const { projectId, workspaceDirectories } = getProjectGroupIdentity(normalizedDirectory, meta)
        const existing = groups.get(projectId)

        if (existing) {
          const pinnedAt = Math.max(existing.pinnedAt ?? 0, directory.pinnedAt ?? 0) || undefined
          groups.set(projectId, {
            ...existing,
            pinnedAt,
            memberDirectories: [...(existing.memberDirectories ?? []), directory.path],
          })
          continue
        }

        groups.set(projectId, {
          id: projectId,
          worktree: projectId,
          name: savedNameByPath.get(projectId) ?? getDirectoryName(projectId),
          pinnedAt: directory.pinnedAt,
          canReorder: true,
          memberDirectories: [directory.path],
          workspaceDirectories,
        })
      }

      return Array.from(groups.values()).map((project) => {
        if (!project.workspaceDirectories?.length) return project

        const savedWorkspaceDirectories = (project.memberDirectories ?? [])
          .map((directory) => normalizeToForwardSlash(directory))
          .filter((directory) =>
            project.workspaceDirectories?.some((workspace) => isSameDirectory(workspace, directory)),
          )

        const remainingWorkspaceDirectories = project.workspaceDirectories.filter(
          (workspace) => !savedWorkspaceDirectories.some((directory) => isSameDirectory(directory, workspace)),
        )

        return {
          ...project,
          workspaceDirectories: [...savedWorkspaceDirectories, ...remainingWorkspaceDirectories],
        }
      })
    },
    [gitWorkspaceCatalog],
  )

  const folderProjectGroups = useMemo<ProjectItem[]>(() => {
    return buildProjectGroups(savedDirectories)
  }, [buildProjectGroups, savedDirectories])

  const globalProject = useMemo<ProjectItem>(
    () => ({
      id: "global",
      worktree: t("sidebar.allProjects"),
      name: t("sidebar.global"),
    }),
    [t],
  )

  const projects = useMemo<ProjectItem[]>(() => {
    return folderProjectGroups
  }, [folderProjectGroups])

  const currentProject = useMemo<ProjectItem>(() => {
    if (!currentDirectory) return globalProject

    const groupedProject = findProjectGroupForDirectory(folderProjectGroups, normalizedCurrentDirectory!)
    if (groupedProject) return groupedProject

    const meta = gitWorkspaceCatalog.get(normalizedCurrentDirectory!)
    const { projectId, workspaceDirectories } = getProjectGroupIdentity(normalizedCurrentDirectory!, meta)
    const found = findProjectGroupForDirectory(folderProjectGroups, projectId)
    if (found) return found

    return {
      id: projectId,
      worktree: projectId,
      name: getDirectoryName(projectId),
      canReorder: false,
      memberDirectories: [],
      workspaceDirectories,
    }
  }, [currentDirectory, folderProjectGroups, gitWorkspaceCatalog, globalProject, normalizedCurrentDirectory])

  useEffect(() => {
    if (!selectedSessionId) return
    if (currentProject.id === "global") return
    setExpandedProjectIds((prev) => (prev.includes(currentProject.id) ? prev : [...prev, currentProject.id]))
  }, [currentProject.id, selectedSessionId])

  const displayedProjects = useMemo(() => {
    const base =
      currentProject.id === "global"
        ? projects
        : projects.some((project) => isSameDirectory(project.id, currentProject.id))
          ? projects
          : [...projects, { ...currentProject, canReorder: false }]
    return base.filter(
      (project) =>
        project.id === "global" ||
        (!isDefaultWorkspaceDirectory(project.id) && !isDefaultWorkspaceDirectory(project.worktree)),
    )
  }, [currentProject, projects])

  const expandedProjects = useMemo(
    () => displayedProjects.filter((project) => project.id !== "global" && expandedProjectIds.includes(project.id)),
    [displayedProjects, expandedProjectIds],
  )

  const pinnedProjectBusyCount = useMemo(
    () =>
      busySessions.filter((entry) => {
        if (!entry.directory) return false
        const group = findProjectGroupForDirectory(displayedProjects, entry.directory)
        return Boolean(group && group.pinnedAt !== undefined)
      }).length,
    [busySessions, displayedProjects],
  )

  const projectBusyCount = useMemo(
    () =>
      busySessions.filter((entry) => {
        if (!entry.directory) return false
        const group = findProjectGroupForDirectory(displayedProjects, entry.directory)
        return Boolean(group && group.pinnedAt === undefined)
      }).length,
    [busySessions, displayedProjects],
  )

  const conversationBusyCount = useMemo(
    () =>
      busySessions.filter((entry) => {
        if (!entry.directory) return true
        if (isDefaultWorkspaceDirectory(entry.directory)) return true
        return !findProjectGroupForDirectory(displayedProjects, entry.directory)
      }).length,
    [busySessions, displayedProjects],
  )

  useEffect(() => {
    if (currentProject.id !== "global") return
    setDefaultSessions((prev) => {
      if (!prev.isLoading && areSessionListsSame(prev.sessions, orderedSessions)) return prev
      return { sessions: orderedSessions, isLoading: false }
    })
  }, [currentProject.id, orderedSessions])

  useEffect(() => {
    if (currentProject.id === "global" || !pathInfo?.directory) return

    let cancelled = false
    let freshLoaded = false
    let retryTimer: number | undefined
    const serverId = serverStore.getActiveServerId()
    const directory = normalizeToForwardSlash(pathInfo.directory) || pathInfo.directory
    setDefaultSessions((prev) => {
      if (prev.isLoading) return prev
      return { ...prev, isLoading: true }
    })

    if (!search && typeof window.customOpenCode?.cachedSessions === "function") {
      void window.customOpenCode
        .cachedSessions(serverId, directory)
        .then((cached) => {
          if (cancelled || freshLoaded || !cached) return
          if (serverStore.getActiveServerId() !== serverId) return
          setDefaultSessions((prev) => {
            if (!prev.isLoading && areSessionListsSame(prev.sessions, cached.sessions)) return prev
            return { sessions: cached.sessions, isLoading: false }
          })
        })
        .catch(() => undefined)
    }

    const fetchDefaultSessions = (attempt: number) => {
      const run = () => {
        void getSessions({
          roots: true,
          limit: 200,
          directory,
          search: search || undefined,
        })
          .then((data) => {
            if (cancelled || serverStore.getActiveServerId() !== serverId) return
            freshLoaded = true
            setDefaultSessions((prev) => {
              if (!prev.isLoading && areSessionListsSame(prev.sessions, data)) return prev
              return { sessions: data, isLoading: false }
            })
            setFetchedSessions((prev) => ({
              ...prev,
              ...Object.fromEntries(data.map((session) => [session.id, session])),
            }))
          })
          .catch(() => {
            if (cancelled) return
            if (attempt < 3) {
              fetchDefaultSessions(attempt + 1)
              return
            }
            setDefaultSessions((prev) => {
              if (!prev.isLoading) return prev
              return { ...prev, isLoading: false }
            })
          })
      }

      const delay = [0, 500, 1500, 3000][attempt]
      if (!delay) {
        run()
        return
      }
      retryTimer = window.setTimeout(run, delay)
    }

    fetchDefaultSessions(0)

    return () => {
      cancelled = true
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    }
  }, [connectionRefreshVersion, currentProject.id, pathInfo?.directory, search])

  useEffect(() => {
    if (expandedProjects.length === 0) return

    let cancelled = false
    const loadingProjects = expandedProjects.filter((project) => {
      if (currentDirectory && isSameDirectory(currentDirectory, project.worktree)) return false
      return true
    })

    if (loadingProjects.length === 0) return

    setProjectSessions((prev) => ({
      ...prev,
      ...Object.fromEntries(
        loadingProjects.map((project) => [
          project.id,
          {
            sessions: prev[project.id]?.sessions ?? [],
            isLoading: true,
          },
        ]),
      ),
    }))

    Promise.allSettled(
      loadingProjects.map(async (project) => ({
        project,
        sessions: await getSessions({
          roots: true,
          limit: 200,
          directory: normalizeToForwardSlash(project.worktree) || project.worktree,
          search: search || undefined,
        }),
      })),
    ).then((results) => {
      if (cancelled) return

      setProjectSessions((prev) => ({
        ...prev,
        ...Object.fromEntries(
          results.map((result, index) => {
            const project = loadingProjects[index]
            if (result.status === "fulfilled") {
              return [
                result.value.project.id,
                {
                  sessions: [...result.value.sessions].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0)),
                  isLoading: false,
                },
              ]
            }

            return [
              project.id,
              {
                sessions: prev[project.id]?.sessions ?? [],
                isLoading: false,
              },
            ]
          }),
        ),
      }))

      setFetchedSessions((prev) => ({
        ...prev,
        ...Object.fromEntries(
          results.flatMap((result) => {
            if (result.status !== "fulfilled") return []
            return result.value.sessions.map((session) => [session.id, session])
          }),
        ),
      }))
    })

    return () => {
      cancelled = true
    }
  }, [currentDirectory, expandedProjects, search])

  const folderProjects = useMemo<ProjectItem[]>(() => {
    const list = [...folderProjectGroups]

    if (currentDirectory && !list.some((project) => isSameDirectory(project.worktree, currentProject.worktree))) {
      list.push({ ...currentProject, canReorder: false })
    }

    return list
  }, [folderProjectGroups, currentDirectory, currentProject])

  const workspaceDirectoriesByProjectId = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const project of folderProjects) {
      if (project.workspaceDirectories && project.workspaceDirectories.length > 1) {
        map.set(project.id, project.workspaceDirectories)
      }
    }
    return map
  }, [folderProjects])

  const currentProjectWorkspaceDirectories = useMemo(
    () => currentProject.workspaceDirectories ?? [],
    [currentProject.workspaceDirectories],
  )
  const shouldRenderWorkspaceTreeOnly =
    !search && currentProjectWorkspaceDirectories.length > 1 && currentProject.id !== "global"
  const shouldWaitForWorkspaceResolution =
    !search &&
    !!currentDirectory &&
    isGitWorkspaceCatalogLoading &&
    currentProjectWorkspaceDirectories.length <= 1 &&
    !!normalizedCurrentDirectory &&
    !gitWorkspaceCatalog.has(normalizedCurrentDirectory)

  const currentProjectTreeProjects = useMemo<ProjectItem[]>(() => {
    if (!shouldRenderWorkspaceTreeOnly || currentProject.id === "global") return []

    const draggableWorkspaceSet = new Set(
      (currentProject.memberDirectories ?? []).map((directory) => normalizeToForwardSlash(directory)),
    )

    return currentProjectWorkspaceDirectories.map((workspaceDirectory) => {
      const isSavedWorkspace = draggableWorkspaceSet.has(normalizeToForwardSlash(workspaceDirectory))

      return {
        id: workspaceDirectory,
        worktree: workspaceDirectory,
        name: getDirectoryName(workspaceDirectory),
        canReorder: isSavedWorkspace,
        memberDirectories: isSavedWorkspace ? [workspaceDirectory] : [],
        sectionKind: "workspace" as const,
      }
    })
  }, [currentProject, currentProjectWorkspaceDirectories, shouldRenderWorkspaceTreeOnly])

  const allDisplayedProjects = useMemo(() => {
    return [...folderProjects, ...currentProjectTreeProjects]
  }, [folderProjects, currentProjectTreeProjects])

  const getProjectDirectoriesToRemove = useCallback(
    (projectId: string) => {
      const project = allDisplayedProjects.find((item) => isSameDirectory(item.id, projectId))
      return project?.memberDirectories?.length ? project.memberDirectories : [projectId]
    },
    [allDisplayedProjects],
  )

  const handleSelectProject = useCallback(
    (projectId: string) => {
      if (projectId === "global") {
        setCurrentDirectory(undefined)
      } else {
        setCurrentDirectory(projectId)
      }
    },
    [setCurrentDirectory],
  )

  const handleToggleProject = useCallback((projectId: string) => {
    setExpandedProjectIds((prev) =>
      prev.includes(projectId) ? prev.filter((item) => item !== projectId) : [...prev, projectId],
    )
  }, [])

  const handleRemoveProject = useCallback(
    (projectId: string) => {
      getProjectDirectoriesToRemove(projectId).forEach((directory) => removeDirectory(directory))
    },
    [getProjectDirectoriesToRemove, removeDirectory],
  )

  const handleTogglePinnedProject = useCallback(
    (project: ProjectItem) => {
      setDirectoriesPinned(
        project.memberDirectories?.length ? project.memberDirectories : [project.id],
        project.pinnedAt === undefined,
      )
      setProjectContextMenu(null)
    },
    [setDirectoriesPinned],
  )

  const handleShowProjectInFinder = useCallback(async (project: ProjectItem) => {
    setProjectContextMenu(null)
    if (!isElectron()) return
    try {
      await window.customOpenCode.openLocation({ path: project.worktree, appId: "default" })
    } catch (error) {
      uiErrorHandler("open project in file manager", error)
    }
  }, [])

  const handleOpenProjectContextMenu = useCallback((projectId: string, x: number, y: number) => {
    setProjectContextMenu({
      projectId,
      x: Math.max(8, Math.min(x, window.innerWidth - 184)),
      y: Math.max(8, Math.min(y, window.innerHeight - 124)),
    })
  }, [])

  const handleReorderProjectGroup = useCallback(
    (draggedPath: string, targetPath: string, position: "before" | "after") => {
      const draggedProject = folderProjects.find((project) => isSameDirectory(project.id, draggedPath))
      const targetProject = folderProjects.find((project) => isSameDirectory(project.id, targetPath))
      if ((draggedProject?.pinnedAt !== undefined) !== (targetProject?.pinnedAt !== undefined)) return
      const draggedDirectories = draggedProject?.memberDirectories
      const targetDirectories = targetProject?.memberDirectories
      if (!draggedDirectories?.length || !targetDirectories?.length) return
      reorderDirectories(draggedDirectories, targetDirectories, position)
    },
    [folderProjects, reorderDirectories],
  )

  const projectById = useMemo(
    () => new Map(displayedProjects.map((project) => [project.id, project])),
    [displayedProjects],
  )
  const expandedProjectsBeforeDragRef = useRef<string[] | null>(null)
  const {
    draggedId: draggedProjectId,
    displayOrder: displayedProjectOrder,
    handlePointerStart: handleProjectPointerStart,
    handleTouchStart: handleProjectTouchStart,
    handleTouchMove: handleProjectTouchMove,
    handleTouchEnd: handleProjectTouchEnd,
    registerRef: registerProjectRef,
  } = useReorderableList({
    ids: displayedProjects.map((project) => project.id),
    canDrag: (id) => !!projectById.get(id)?.canReorder && !isEditMode,
    onCommit: (draggedId, targetId, order) => {
      const draggedProject = projectById.get(draggedId)
      const targetProject = projectById.get(targetId)
      if (!draggedProject?.canReorder || !targetProject?.canReorder) return
      handleReorderProjectGroup(
        draggedProject.worktree,
        targetProject.worktree,
        order.indexOf(draggedId) > displayedProjects.findIndex((project) => project.id === draggedId)
          ? "after"
          : "before",
      )
    },
    onDragActivated: () => {
      expandedProjectsBeforeDragRef.current = expandedProjectIds
      setExpandedProjectIds([])
    },
    onDragFinished: () => {
      if (!expandedProjectsBeforeDragRef.current) return
      setExpandedProjectIds(expandedProjectsBeforeDragRef.current)
      expandedProjectsBeforeDragRef.current = null
    },
  })
  const pinnedProjectOrder = displayedProjectOrder.filter(
    (projectId) => projectById.get(projectId)?.pinnedAt !== undefined,
  )
  const regularProjectOrder = displayedProjectOrder.filter(
    (projectId) => projectById.get(projectId)?.pinnedAt === undefined,
  )
  const contextMenuProject = projectContextMenu ? projectById.get(projectContextMenu.projectId) : undefined

  const handleSelect = useCallback(
    (session: ApiSession) => {
      const isDefaultDirectorySession =
        pathInfo?.directory && session.directory && isSameDirectory(pathInfo.directory, session.directory)

      if (!currentDirectory && session.directory && !isDefaultDirectorySession) {
        addDirectory(session.directory)
      }
      onSelectSession(session)
      if (window.innerWidth < 768 && onCloseMobile) {
        onCloseMobile()
      }
    },
    [currentDirectory, pathInfo?.directory, addDirectory, onSelectSession, onCloseMobile],
  )

  // Active tab 专用：跨目录的 session 需要确保目录在项目列表中
  const handleSelectActive = useCallback(
    (session: ApiSession) => {
      if (session.directory) {
        addDirectory(session.directory)
      }
      onSelectSession(session)
      if (window.innerWidth < 768 && onCloseMobile) {
        onCloseMobile()
      }
    },
    [addDirectory, onSelectSession, onCloseMobile],
  )

  const renderActiveSessionNode = useCallback(
    function renderActiveSessionNode(entry: (typeof busySessions)[number], level = 0): ReactNode {
      const resolvedSession = sessionLookup.get(entry.sessionId)
      const childEntries = activeSessionTree.childrenByParent.get(entry.sessionId) ?? []

      return (
        <div key={entry.sessionId} style={level > 0 ? { marginLeft: level * 12 } : undefined}>
          <ActiveSessionItem
            entry={entry}
            resolvedSession={resolvedSession}
            isSelected={entry.sessionId === selectedSessionId}
            onSelect={handleSelectActive}
          />
          {childEntries.map((childEntry) => renderActiveSessionNode(childEntry, level + 1))}
        </div>
      )
    },
    [activeSessionTree.childrenByParent, handleSelectActive, selectedSessionId, sessionLookup],
  )

  const handleRename = useCallback(
    async (sessionId: string, newTitle: string) => {
      try {
        await updateSession(sessionId, { title: newTitle }, currentDirectory || pathInfo?.directory)
        pinnedSessionsStore.update(sessionId, { title: newTitle })
        refresh()
      } catch (e) {
        uiErrorHandler("rename session", e)
      }
    },
    [currentDirectory, pathInfo?.directory, refresh],
  )

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      await deleteSession(sessionId)

      if (selectedSessionId === sessionId) {
        onNewSession()
      }
    },
    [deleteSession, onNewSession, selectedSessionId],
  )

  const handleRenameListedSession = useCallback(
    async (sessionId: string, newTitle: string) => {
      const session = sessionLookup.get(sessionId)
      try {
        await updateSession(
          sessionId,
          { title: newTitle },
          session?.directory || currentDirectory || pathInfo?.directory,
        )
        pinnedSessionsStore.update(sessionId, { title: newTitle })
        setProjectSessions((prev) =>
          Object.fromEntries(
            Object.entries(prev).map(([projectId, value]) => [
              projectId,
              {
                ...value,
                sessions: value.sessions.map((item) => (item.id === sessionId ? { ...item, title: newTitle } : item)),
              },
            ]),
          ),
        )
        setDefaultSessions((prev) => ({
          ...prev,
          sessions: prev.sessions.map((item) => (item.id === sessionId ? { ...item, title: newTitle } : item)),
        }))
        await refresh()
      } catch (e) {
        uiErrorHandler("rename session", e)
      }
    },
    [currentDirectory, pathInfo?.directory, refresh, sessionLookup],
  )

  const handleDeleteListedSession = useCallback(
    async (sessionId: string) => {
      const session = sessionLookup.get(sessionId)
      if (!session) {
        await handleDeleteSession(sessionId)
        return
      }

      await apiArchiveSession(sessionId, session.directory)
      pinnedSessionsStore.unpin(sessionId)
      clearSessionRuntimeState(sessionId)
      setProjectSessions((prev) =>
        Object.fromEntries(
          Object.entries(prev).map(([projectId, value]) => [
            projectId,
            {
              ...value,
              sessions: value.sessions.filter((item) => item.id !== sessionId),
            },
          ]),
        ),
      )
      setDefaultSessions((prev) => ({
        ...prev,
        sessions: prev.sessions.filter((item) => item.id !== sessionId),
      }))
      await refresh()

      if (selectedSessionId === sessionId) {
        onNewSession()
      }
    },
    [handleDeleteSession, onNewSession, refresh, selectedSessionId, sessionLookup],
  )

  // ---- 批量删除 session ----
  const handleBatchDeleteSessions = useCallback(async () => {
    if (selectedSessionIds.size === 0) return
    setIsBatchDeleting(true)

    const needSwitchSession = selectedSessionId && selectedSessionIds.has(selectedSessionId)

    // 文件夹模式下可能跨目录，需要按 session 逐个调用
    // 普通模式下也用 sessionLookup 获取目录信息
    const ids = Array.from(selectedSessionIds)
    await Promise.allSettled(
      ids.map(async (id) => {
        try {
          const s = sessionLookup.get(id)
          if (s) {
            await apiArchiveSession(id, s.directory)
          } else {
            await apiArchiveSession(id, currentDirectory || pathInfo?.directory)
          }
          pinnedSessionsStore.unpin(id)
        } catch (e) {
          uiErrorHandler("batch archive session", e)
        }
      }),
    )

    await refresh()
    setSelectedSessionIds(new Set())
    sessionSelectionAnchorIdRef.current = null
    setBatchDeleteSessionConfirm(false)
    setIsBatchDeleting(false)

    if (needSwitchSession) {
      onNewSession()
    }
  }, [
    selectedSessionIds,
    selectedSessionId,
    sessionLookup,
    currentDirectory,
    pathInfo?.directory,
    refresh,
    onNewSession,
  ])

  const localConversationSource =
    currentProject.id === "global"
      ? {
          sessions: orderedSessions,
          isLoading: isLoading || shouldWaitForWorkspaceResolution,
          isLoadingMore,
          hasMore,
          onLoadMore: loadMore,
        }
      : {
          sessions: defaultSessions.sessions,
          isLoading: defaultSessions.isLoading,
          isLoadingMore: false,
          hasMore: false,
          onLoadMore: () => {},
        }
  const conversationSessions = useMemo(() => {
    const merged = new Map(
      localConversationSource.sessions
        .filter(
          (session) =>
            !isExternalChannelSession(session) &&
            (isDefaultWorkspaceDirectory(session.directory) ||
              !findProjectGroupForDirectory(displayedProjects, session.directory)),
        )
        .map((session) => [session.id, session]),
    )

    const pinned = pinnedEntries
      .map((entry) => merged.get(entry.sessionId))
      .filter((session): session is ApiSession => Boolean(session))
    const pinnedIds = new Set(pinned.map((session) => session.id))
    const recent = Array.from(merged.values())
      .filter((session) => !pinnedIds.has(session.id))
      .toSorted((left, right) => right.time.updated - left.time.updated)
    return [...pinned, ...recent]
  }, [displayedProjects, localConversationSource.sessions, pinnedEntries])

  const visibleConversationSessions = useMemo(() => {
    if (expandedConversations || search) return conversationSessions
    return conversationSessions.slice(0, CONVERSATION_PREVIEW_LIMIT)
  }, [conversationSessions, expandedConversations, search])

  const hasHiddenConversations =
    !search && !expandedConversations && conversationSessions.length > CONVERSATION_PREVIEW_LIMIT

  const defaultConversationSource = {
    sessions: visibleConversationSessions,
    isLoading: localConversationSource.isLoading,
    isLoadingMore: localConversationSource.isLoadingMore,
    hasMore: localConversationSource.hasMore,
    onLoadMore: localConversationSource.onLoadMore,
  }
  const projectsHeading = (
    <div className="sidebar-muted-text mb-1 mt-3 flex items-center px-2 text-[length:var(--fs-xs)] font-medium tracking-wide">
      <span>{t("sidebar.projects")}</span>
      {projectBusyCount > 0 && (
        <span
          className="ml-1.5 inline-flex h-[15px] min-w-[15px] shrink-0 items-center justify-center rounded-full bg-success-100/10 px-1 text-[length:var(--fs-xxs)] font-medium leading-none text-success-100"
          title={t("sidebar.active")}
        >
          {projectBusyCount}
        </span>
      )}
      <button
        type="button"
        onClick={onAddProject}
        className="ml-auto rounded-md p-1 text-text-500 transition-colors hover:bg-bg-200/60 hover:text-text-200"
        aria-label={t("sidebar.addProject")}
        title={t("sidebar.addProject")}
      >
        <PlusIcon size={13} />
      </button>
    </div>
  )

  // 统一的结构，通过 CSS 控制显示/隐藏
  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ===== Header ===== */}
      {isMobile || !(isElectron() && desktopPlatform === "windows") ? (
        <div className="mobile-safe-topbar-14 window-drag-region relative shrink-0">
          {isMobile && (
            <button
              type="button"
              onClick={onOpenSearch}
              aria-label={t("sidebar.search")}
              title={t("sidebar.search")}
              className="window-no-drag absolute bottom-3 right-3 inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-400 transition-colors hover:bg-bg-200/70 hover:text-text-100"
            >
              <SearchIcon size={16} />
            </button>
          )}
        </div>
      ) : (
        <div className="shrink-0" style={{ height: 8 }} />
      )}

      {/* ===== Navigation - 图标位置固定 ===== */}
      <div className="mx-2 flex shrink-0 flex-col gap-0">
        {/* New Chat - 图标始终在 padding-left: 6px 位置，收起时刚好居中 */}
        <button
          type="button"
          onClick={onNewSession}
          aria-label={t("sidebar.newChat")}
          className={
            showLabels
              ? "group mb-1 flex h-10 w-full items-center justify-center gap-2 rounded-xl glass-alt border border-border-200/60 px-2 text-[length:var(--fs-base)] font-medium text-text-100 shadow-sm transition-[filter] hover:brightness-110 active:scale-[0.99]"
              : `${navigationItemClass(false)} group`
          }
          style={showLabels ? undefined : { width: 32, paddingLeft: 10, paddingRight: 10 }}
          title={t("sidebar.newChat")}
        >
          <span className="size-5 flex items-center justify-center shrink-0">
            <CirclePlusIcon size={16} />
          </span>
          <span
            className="whitespace-nowrap transition-opacity duration-300"
            style={{ opacity: showLabels ? 1 : 0 }}
          >
            {t("sidebar.newChat")}
          </span>
        </button>

        <button
          type="button"
          onClick={onOpenPlugins}
          aria-label={t("sidebar.plugins")}
          className={navigationItemClass(activeNavigation === "plugins")}
          style={{
            width: showLabels ? "100%" : 32,
            paddingLeft: 10,
            paddingRight: 10,
          }}
          title={t("sidebar.plugins")}
        >
          <span className="size-5 flex items-center justify-center shrink-0">
            <PackagePlusIcon size={16} />
          </span>
          <span
            className="ml-2 text-[length:var(--fs-base)] whitespace-nowrap transition-opacity duration-300"
            style={{ opacity: showLabels ? 1 : 0 }}
          >
            {t("sidebar.plugins")}
          </span>
        </button>

        <button
          type="button"
          onClick={onOpenTasks}
          aria-label={t("sidebar.tasks")}
          className={navigationItemClass(activeNavigation === "tasks")}
          style={{ width: showLabels ? "100%" : 32, paddingLeft: 10, paddingRight: 10 }}
          title={t("sidebar.tasks")}
        >
          <span className="size-5 flex items-center justify-center shrink-0">
            <ClockIcon size={16} />
          </span>
          <span
            className="ml-2 text-[length:var(--fs-base)] whitespace-nowrap transition-opacity duration-300"
            style={{ opacity: showLabels ? 1 : 0 }}
          >
            {t("sidebar.tasks")}
          </span>
          {showLabels && enabledTaskCount > 0 && (
            <span
              className="ml-auto inline-flex h-[15px] min-w-[15px] shrink-0 items-center justify-center rounded-full bg-success-100/10 px-1 text-[length:var(--fs-xxs)] font-medium leading-none text-success-100"
              title={`${enabledTaskCount} 个已开启任务`}
            >
              {enabledTaskCount}
            </span>
          )}
        </button>

        {!showLabels && (
          <>
            <button
              type="button"
              onClick={onExpandSidebar}
              aria-label={t("sidebar.projects")}
              className={navigationItemClass(false)}
              style={{ width: 32, paddingLeft: 10, paddingRight: 10 }}
              title={t("sidebar.projects")}
            >
              <span className="size-5 flex items-center justify-center shrink-0">
                <FolderIcon size={16} />
              </span>
            </button>
            <button
              type="button"
              onClick={onOpenSearch}
              aria-label={t("sidebar.search")}
              className={navigationItemClass(false)}
              style={{ width: 32, paddingLeft: 10, paddingRight: 10 }}
              title={t("sidebar.search")}
            >
              <span className="size-5 flex items-center justify-center shrink-0">
                <SearchIcon size={16} />
              </span>
            </button>
          </>
        )}
      </div>

      <div
        ref={recentsSelectionRootRef}
        onScroll={(event) => {
          const element = event.currentTarget
          if (
            sidebarTab === "recents" &&
            defaultConversationSource.hasMore &&
            !defaultConversationSource.isLoadingMore &&
            element.scrollHeight - element.scrollTop - element.clientHeight < 100
          ) {
            defaultConversationSource.onLoadMore()
          }
        }}
        className="flex-1 min-h-0 overflow-y-auto custom-scrollbar transition-all duration-300 ease-out"
        style={{
          opacity: showLabels ? 1 : 0,
          visibility: showLabels ? "visible" : "hidden",
        }}
      >
        {showLabels && (
          <section className="mx-2 mt-2">
            {pinnedProjectOrder.length > 0 ? (
              <div className="sidebar-muted-text mb-1 mt-3 flex items-center px-2 text-[length:var(--fs-xs)] font-medium tracking-wide">
                <span>{t("sidebar.pinnedProjects")}</span>
                {pinnedProjectBusyCount > 0 && (
                  <span
                    className="ml-1.5 inline-flex h-[15px] min-w-[15px] shrink-0 items-center justify-center rounded-full bg-success-100/10 px-1 text-[length:var(--fs-xxs)] font-medium leading-none text-success-100"
                    title={t("sidebar.active")}
                  >
                    {pinnedProjectBusyCount}
                  </span>
                )}
              </div>
            ) : (
              projectsHeading
            )}
            <div
              ref={projectsDropdownRef}
              onTouchMove={handleProjectTouchMove}
              onTouchEnd={handleProjectTouchEnd}
              onTouchCancel={handleProjectTouchEnd}
              className="pb-1"
            >
              {[...pinnedProjectOrder, ...regularProjectOrder].map((projectId) => {
                const project = projectById.get(projectId)
                if (!project) return null
                const beginsRegularSection = pinnedProjectOrder.length > 0 && projectId === regularProjectOrder[0]
                const isGlobal = project.id === "global"
                const isActive = currentProject?.id === project.id
                const isExpanded = expandedProjectIds.includes(project.id)
                const usesActiveSessionSource = Boolean(
                  isActive && currentDirectory && isSameDirectory(currentProject.worktree, project.worktree),
                )
                const rawProjectSessionSource = usesActiveSessionSource
                  ? {
                      sessions: orderedSessions,
                      isLoading: isLoading || shouldWaitForWorkspaceResolution,
                      isLoadingMore,
                      hasMore,
                      onLoadMore: loadMore,
                    }
                  : {
                      sessions: projectSessions[project.id]?.sessions ?? [],
                      isLoading: projectSessions[project.id]?.isLoading ?? false,
                      isLoadingMore: false,
                      hasMore: false,
                      onLoadMore: () => {},
                    }
                const projectExternalSessions = externalChannelSessions.filter((session) =>
                  findProjectGroupForDirectory([project], session.directory),
                )
                const projectSessionSource = {
                  ...rawProjectSessionSource,
                  sessions: Array.from(
                    new Map(
                      [...projectExternalSessions, ...rawProjectSessionSource.sessions].map((session) => [
                        session.id,
                        session,
                      ]),
                    ).values(),
                  ).sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0)),
                }
                const isProjectSessionListExpanded = Boolean(search) || expandedProjectSessionIds.includes(project.id)
                const visibleProjectSessions = projectSessionsForDisplay(
                  projectSessionSource.sessions,
                  isProjectSessionListExpanded,
                  Boolean(search),
                )
                const hasHiddenProjectSessions =
                  !search &&
                  !isProjectSessionListExpanded &&
                  projectSessionSource.sessions.length > PROJECT_SESSION_PREVIEW_LIMIT
                const itemLabel = project.name || (isGlobal ? t("sidebar.global") : project.worktree)
                return (
                  <div key={project.id}>
                    {beginsRegularSection && <div className="mt-2">{projectsHeading}</div>}
                    <ProjectInfoHover project={project} disabled={isGlobal || isMobile}>
                      <div
                        ref={(element) => registerProjectRef(project.id, element)}
                        data-reorder-preview
                        onClick={() => handleSelectProject(project.id)}
                        onContextMenu={(event) => {
                          if (isGlobal) return
                          event.preventDefault()
                          event.stopPropagation()
                          handleOpenProjectContextMenu(project.id, event.clientX, event.clientY)
                        }}
                        onTouchStart={
                          project.canReorder && !isEditMode
                            ? (event) => handleProjectTouchStart(project.id, event)
                            : undefined
                        }
                        className={`group w-full flex items-center gap-2 rounded-lg px-2 py-1.5 transition-all ${
                          draggedProjectId === project.id
                            ? "relative z-10 bg-bg-100 shadow-lg ring-1 ring-inset ring-accent-main-100/30"
                            : ""
                        } ${
                          isActive
                            ? "sidebar-selected-row sidebar-primary-text"
                            : "sidebar-hover-row sidebar-primary-text"
                        }`}
                      >
                        <button
                          type="button"
                          onPointerDown={
                            project.canReorder && !isEditMode
                              ? (event) => handleProjectPointerStart(project.id, event)
                              : undefined
                          }
                          onClick={(e) => {
                            e.stopPropagation()
                            handleSelectProject(project.id)
                            if (!isGlobal) handleToggleProject(project.id)
                          }}
                          aria-current={isActive ? "true" : undefined}
                          className={`min-w-0 flex flex-1 items-center gap-2 text-left bg-transparent border-none p-0 ${
                            project.canReorder && !isEditMode ? "cursor-grab active:cursor-grabbing" : ""
                          }`}
                        >
                          <span className="flex size-5 shrink-0 items-center justify-center">
                            {isGlobal ? (
                              <GlobeIcon size={14} className="text-accent-main-100" />
                            ) : isExpanded ? (
                              <FolderOpenIcon size={14} />
                            ) : (
                              <FolderIcon size={14} />
                            )}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[length:var(--fs-sm)]">{itemLabel}</span>
                        </button>
                      </div>
                    </ProjectInfoHover>
                    {!isGlobal &&
                      isExpanded &&
                      sidebarTab === "recents" &&
                      (projectSessionSource.sessions.length > 0 || projectSessionSource.isLoading || search) && (
                        <div className="ml-[18px] mt-0.5 mb-0.5">
                          <SessionList
                            sessions={visibleProjectSessions}
                            selectedId={selectedSessionId}
                            isLoading={projectSessionSource.isLoading}
                            isLoadingMore={false}
                            hasMore={false}
                            search={search}
                            onSearchChange={setSearch}
                            onSelect={handleSelect}
                            onDelete={handleDeleteListedSession}
                            onRename={handleRenameListedSession}
                            onLoadMore={projectSessionSource.onLoadMore}
                            onNewChat={onNewSession}
                            showHeader={false}
                            grouped={false}
                            density="minimal"
                            showStats={false}
                            showDirectory={false}
                            expandedChildSessionIds={expandedChildSessionIds}
                            inlineChildSessions={inlineChildSessions}
                            onSelectChildSession={handleSelectActive}
                            pinnedDividerAfterIds={pinnedDividerAfterIds}
                            parentScroll
                            isEditMode={isEditMode}
                            selectedSessionIds={selectedSessionIds}
                            onToggleSessionSelection={toggleSessionSelection}
                            reorderScope={`project:${normalizeToForwardSlash(project.worktree)}`}
                          />
                          {hasHiddenProjectSessions && (
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedProjectSessionIds((prev) =>
                                  prev.includes(project.id) ? prev : [...prev, project.id],
                                )
                              }
                              className="sidebar-muted-text sidebar-primary-text-hover flex w-full items-center justify-start rounded-md py-1 pl-4 pr-2 text-[length:var(--fs-sm)] transition-colors hover:bg-bg-200/45"
                            >
                              <span>{t("sidebar.showMoreChats")}</span>
                            </button>
                          )}
                        </div>
                      )}
                  </div>
                )
              })}
              {pinnedProjectOrder.length > 0 && regularProjectOrder.length === 0 && (
                <div className="mt-2">{projectsHeading}</div>
              )}
            </div>
          </section>
        )}
        {/* ===== Main Content ===== */}
        <div className="flex flex-col">
          <div className="flex flex-col">
            <div className="mx-2 flex shrink-0 items-center gap-1">
              <div className="sidebar-muted-text pl-[6px] py-1 text-left text-[length:var(--fs-sm)]">
                <span>{t("sidebar.conversations")}</span>
              </div>
              {conversationBusyCount > 0 && (
                <span
                  className="inline-flex h-[15px] min-w-[15px] shrink-0 items-center justify-center rounded-full bg-success-100/10 px-1 text-[length:var(--fs-xxs)] font-medium leading-none text-success-100"
                  title={t("sidebar.active")}
                >
                  {conversationBusyCount}
                </span>
              )}
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={isEditMode ? exitEditMode : enterEditMode}
                aria-label={isEditMode ? t("common:done") : t("common:edit")}
                className={`ml-auto p-1 rounded-md transition-colors duration-150 ${
                  isEditMode
                    ? "text-accent-main-100 hover:bg-accent-main-100/10"
                    : "text-text-500 hover:text-text-300 hover:bg-bg-200/50"
                }`}
                title={isEditMode ? t("common:done") : t("common:edit")}
              >
                {isEditMode ? <CheckIcon size={14} /> : <PencilIcon size={14} />}
              </button>
            </div>

            {/* 编辑模式批量操作条 */}
            {isEditMode && sidebarTab === "recents" && (
              <div className="shrink-0 px-3 py-1.5 flex items-center gap-1.5 border-b border-border-200/30">
                <span className="text-[length:var(--fs-xxs)] text-text-400 flex-1 min-w-0 truncate">
                  {selectedSessionIds.size > 0 && t("sidebar.selectedSessions", { count: selectedSessionIds.size })}
                  {selectedSessionIds.size === 0 && t("sidebar.selectItems")}
                </span>
                {selectedSessionIds.size > 0 && (
                  <button
                    onClick={() => setBatchDeleteSessionConfirm(true)}
                    className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-[length:var(--fs-xxs)] font-medium text-danger-100 bg-danger-100/10 hover:bg-danger-100/20 transition-colors"
                  >
                    <ArchiveIcon size={11} />
                    {t("sidebar.deleteSessions", { count: selectedSessionIds.size })}
                  </button>
                )}
              </div>
            )}

            {/* Recents Tab */}
            {sidebarTab === "recents" && (
              <div className="-ml-0.5">
                <SessionList
                  sessions={defaultConversationSource.sessions}
                  selectedId={selectedSessionId}
                  isLoading={defaultConversationSource.isLoading}
                  isLoadingMore={defaultConversationSource.isLoadingMore}
                  hasMore={defaultConversationSource.hasMore}
                  search={search}
                  onSearchChange={setSearch}
                  onSelect={handleSelect}
                  onDelete={handleDeleteListedSession}
                  onRename={handleRenameListedSession}
                  onLoadMore={defaultConversationSource.onLoadMore}
                  onNewChat={onNewSession}
                  showHeader={false}
                  grouped={false}
                  density="minimal"
                  showStats={false}
                  showDirectory={false}
                  expandedChildSessionIds={expandedChildSessionIds}
                  inlineChildSessions={inlineChildSessions}
                  onSelectChildSession={handleSelectActive}
                  pinnedDividerAfterIds={pinnedDividerAfterIds}
                  parentScroll
                  isEditMode={isEditMode}
                  selectedSessionIds={selectedSessionIds}
                  onToggleSessionSelection={toggleSessionSelection}
                  reorderScope={`conversation:${
                    currentProject.id === "global"
                      ? "global"
                      : normalizeToForwardSlash(pathInfo?.directory ?? "") || "default"
                  }`}
                />
                {hasHiddenConversations && (
                  <button
                    type="button"
                    onClick={() => setExpandedConversations(true)}
                    className="sidebar-muted-text sidebar-primary-text-hover flex w-full items-center justify-start rounded-md py-1 pl-4 pr-2 text-[length:var(--fs-sm)] transition-colors hover:bg-bg-200/45"
                  >
                    <span>{t("sidebar.showMoreChats")}</span>
                  </button>
                )}
              </div>
            )}

            {/* Active Sessions Tab */}
            {sidebarTab === "active" && (
              <div className="px-2 pb-3">
                {busySessions.length === 0 && notifications.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-text-400 opacity-60">
                    <p className="text-[length:var(--fs-sm)]">{t("sidebar.noActiveSessions")}</p>
                  </div>
                ) : (
                  <div className="mt-1 space-y-0.5">
                    {/* Busy sessions — 子 session 挂在父下面 */}
                    {activeSessionTree.rootEntries.map((entry) => renderActiveSessionNode(entry))}

                    {/* Divider + actions between busy and notifications */}
                    {notifications.length > 0 && (
                      <div
                        className={`flex items-center justify-between gap-2 ${busySessions.length > 0 ? "mt-2 pt-2 border-t border-border-200/30" : ""}`}
                      >
                        <span className="text-[length:var(--fs-xxs)] font-medium text-text-400 uppercase tracking-wider pl-[6px]">
                          {t("sidebar.notifications")}
                        </span>
                        <div className="flex items-center gap-0.5">
                          {notifications.some((n: NotificationEntry) => !n.read) && (
                            <button
                              className="text-[length:var(--fs-xxs)] text-text-400 hover:text-text-200 px-1.5 py-0.5 rounded-md hover:bg-bg-200 transition-all duration-150 active:scale-95"
                              onClick={() => notificationStore.markAllRead()}
                            >
                              {t("sidebar.readAll")}
                            </button>
                          )}
                          <button
                            className="text-[length:var(--fs-xxs)] text-text-400 hover:text-text-200 px-1.5 py-0.5 rounded-md hover:bg-bg-200 transition-all duration-150 active:scale-95"
                            onClick={() => notificationStore.clearAll()}
                          >
                            {t("common:clear")}
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Notification history */}
                    {notifications.map((entry: NotificationEntry) => {
                      const resolvedSession = sessionLookup.get(entry.sessionId)
                      return (
                        <NotificationItem
                          key={entry.id}
                          entry={entry}
                          resolvedSession={resolvedSession}
                          onSelect={handleSelectActive}
                        />
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Spacer for collapsed */}
      {!showLabels && <div className="flex-1" />}

      {/* ===== Footer ===== */}
      <SidebarFooter
        showLabels={showLabels}
        connectionState={connectionState?.state || "disconnected"}
        onOpenSettings={onOpenSettings}
        onOpenNotifications={onOpenNotifications}
      />

      {projectContextMenu &&
        contextMenuProject &&
        createPortal(
          <div
            ref={projectContextMenuRef}
            role="menu"
            aria-label={contextMenuProject.name}
            onContextMenu={(event) => event.preventDefault()}
            className="fixed z-[10000] w-44 rounded-lg border border-border-200 bg-bg-100 p-1 shadow-xl"
            style={{ left: projectContextMenu.x, top: projectContextMenu.y }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => handleTogglePinnedProject(contextMenuProject)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[length:var(--fs-sm)] text-text-200 transition-colors hover:bg-bg-200"
            >
              <PinIcon size={14} />
              <span>
                {t(contextMenuProject.pinnedAt === undefined ? "sidebar.pinProject" : "sidebar.unpinProject")}
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => void handleShowProjectInFinder(contextMenuProject)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[length:var(--fs-sm)] text-text-200 transition-colors hover:bg-bg-200"
            >
              <FolderOpenIcon size={14} />
              <span>
                {t(
                  desktopPlatform === "windows"
                    ? "sidebar.showProjectInExplorer"
                    : desktopPlatform === "macos"
                      ? "sidebar.showProjectInFinder"
                      : "sidebar.showProjectInFileManager",
                )}
              </span>
            </button>
            <div className="my-1 border-t border-border-200/60" />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setProjectContextMenu(null)
                setProjectDeleteConfirm({ isOpen: true, projectId: contextMenuProject.id })
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[length:var(--fs-sm)] text-danger-100 transition-colors hover:bg-danger-100/10"
            >
              <TrashIcon size={14} />
              <span>{t("sidebar.removeProject")}</span>
            </button>
          </div>,
          document.body,
        )}

      {/* Confirm Dialog */}
      <ConfirmDialog
        isOpen={projectDeleteConfirm.isOpen}
        onClose={() => setProjectDeleteConfirm({ isOpen: false, projectId: null })}
        onConfirm={() => {
          if (projectDeleteConfirm.projectId) {
            handleRemoveProject(projectDeleteConfirm.projectId)
          }
          setProjectDeleteConfirm({ isOpen: false, projectId: null })
        }}
        title={t("sidebar.removeProject")}
        description={t("sidebar.removeProjectConfirm")}
        confirmText={t("common:remove")}
        variant="danger"
      />

      {/* 批量删除会话确认弹窗 */}
      <ConfirmDialog
        isOpen={batchDeleteSessionConfirm}
        onClose={() => setBatchDeleteSessionConfirm(false)}
        onConfirm={handleBatchDeleteSessions}
        title={t("sidebar.batchDeleteSessions", { count: selectedSessionIds.size })}
        description={
          <>
            {t("sidebar.batchDeleteSessionsConfirm", { count: selectedSessionIds.size })}
            {selectedSessionId && selectedSessionIds.has(selectedSessionId) && (
              <div className="mt-2 text-[length:var(--fs-sm)] text-warning-100">
                {t("sidebar.batchDeleteIncludesCurrent")}
              </div>
            )}
          </>
        }
        confirmText={t("sidebar.deleteChat")}
        variant="info"
        isLoading={isBatchDeleting}
      />
    </div>
  )
}
