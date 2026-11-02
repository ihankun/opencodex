import { useState, useRef, useEffect, useCallback, useMemo, useSyncExternalStore, useLayoutEffect, memo } from 'react'
import { useTranslation } from 'react-i18next'
import trayIcon from '../../../../../assets/opencode-tray.png'
import { AttachmentPreview, type Attachment } from '../attachment'
import {
  MentionMenu,
  detectMentionTrigger,
  getFileName,
  normalizePath,
  toFileUrl,
  type MentionMenuHandle,
  type MentionItem,
} from '../mention'
import { SlashCommandMenu, type SlashCommandMenuHandle } from '../slash-command'
import { SessionReferenceMenu, type SessionReferenceMenuHandle } from '../session-reference'
import { InputToolbar } from './input/InputToolbar'
import { GoalStatusBar } from './input/GoalStatusBar'
import type { ModelSelectorHandle } from './ModelSelector'
import { FloatingActions, CollapsedCapsule } from './input/InputActions'
import { useMobileCollapse } from './input/useMobileCollapse'
import { useAttachmentRail } from './input/useAttachmentRail'
import { useInputHistory } from './input/useInputHistory'
import { normalizeVoiceRecording } from './input/voiceAudio'
import { projectOptionsInSidebarOrder } from './projectOptions'
import {
  TEXT_STYLE,
  detectSlashTrigger,
  ensureFileMime,
  isDuplicateAttachment,
  isFileSupported,
  readFileAsDataUrl,
} from './input/inputUtils'
import { keybindingStore, matchesKeybinding } from '../../store/keybindingStore'
import { themeStore } from '../../store/themeStore'
import { composerDraftStore } from '../../store/composerDraftStore'
import type { QueuedFollowupDraft } from '../../store/followupQueueStore'
import { useChatViewport } from './chatViewport'
import { useDirectory } from '../../contexts/useDirectory'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  CloseIcon,
  FolderIcon,
  GitBranchIcon,
  GitWorktreeIcon,
  GlobeIcon,
  LaptopIcon,
  PencilIcon,
  ReturnIcon,
  SpinnerIcon,
  TrashIcon,
} from '../../components/Icons'
import type { ApiAgent, ApiSession } from '../../api/client'
import { getVcsDiff, getVcsInfo, listVcsBranches, switchVcsBranch } from '../../api'
import type { VcsBranch, ModelInfo, FileCapabilities } from '../../api'
import type { Command } from '../../api/command'
import { useServerStore, useSessionContext } from '../../hooks'
import type { SessionStats } from '../../hooks'
import { notificationStore } from '../../store'
import {
  applyComposerDraftInsertion,
  matchesComposerDraftInsertion,
  onComposerDraftInsertion,
} from '../../utils/composerDraft'
import { executionTargetStore } from '../../store/executionTargetStore'
import { projectProfileStore } from '../../store/projectProfileStore'
import type { ProjectProfile } from '../../store/projectProfileStore'
import { projectEnvironmentStore } from '../../store/projectEnvironmentStore'
import { getDirectoryName, isSameDirectory } from '../../utils'
import { getModelKey } from '../../utils/modelUtils'
import {
  getInternalDragSnapshot,
  isPointInsideElement as isInternalPointInsideElement,
  subscribeInternalDrag,
  subscribeInternalDrop,
} from '../../lib/internalDragCore'

// ============================================
// Types
// ============================================

interface HistoryEntry {
  text: string
  attachments: Attachment[]
}

interface VoiceRecorderState {
  recorder: MediaRecorder
  stream: MediaStream
  chunks: Blob[]
}

interface DraggedFileInfo {
  type: 'file' | 'folder'
  path: string
  absolute: string
  name: string
}

const TEXTAREA_MIN_HEIGHT = 24
const TEXTAREA_VERTICAL_CHROME = 24
const INPUT_TOOLBAR_FALLBACK_HEIGHT = 36
const INPUT_FOOTER_FALLBACK_HEIGHT = 32
const COMPOSER_MIN_HEIGHT = 144
const COMPOSER_DESKTOP_MAX_HEIGHT = 420
const COMPOSER_COMPACT_MAX_HEIGHT = 320

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function getComposerPaneHeight(anchor: HTMLElement | null): number {
  const paneRoot = anchor?.closest<HTMLElement>('[data-chat-pane-root]')
  const paneHeight = paneRoot?.getBoundingClientRect().height
  if (paneHeight && paneHeight > 0) return paneHeight
  return window.innerHeight || 800
}

function getComposerMaxHeight(paneHeight: number, isCompact: boolean): number {
  const ratio = isCompact ? 0.44 : 0.4
  const hardMax = isCompact ? COMPOSER_COMPACT_MAX_HEIGHT : COMPOSER_DESKTOP_MAX_HEIGHT
  const availableMax = Math.max(COMPOSER_MIN_HEIGHT, paneHeight - 96)
  return clamp(Math.floor(paneHeight * ratio), COMPOSER_MIN_HEIGHT, Math.min(hardMax, availableMax))
}

function isLoopbackServer(url: string) {
  try {
    return ['127.0.0.1', 'localhost', '::1'].includes(new URL(url).hostname)
  } catch {
    return false
  }
}

export interface CollapsedDialogInfo {
  label: string
  queueLength: number
  onExpand: () => void
}

export interface InputBoxProps {
  paneId: string
  onSend: (
    text: string,
    attachments: Attachment[],
    options?: { agent?: string; variant?: string; delivery?: 'steer' | 'queue' },
  ) => Promise<boolean> | boolean
  onAbort?: () => void
  onCommand?: (command: string) => Promise<boolean> | boolean // 斜杠命令回调，接收完整命令字符串如 "/help"
  onNewChat?: () => void // 新建对话回调
  disabled?: boolean
  isStreaming?: boolean
  agents?: ApiAgent[]
  selectedAgent?: string
  onAgentChange?: (agentName: string) => void
  variants?: string[]
  selectedVariant?: string
  onVariantChange?: (variant: string | undefined) => void
  supportsImages?: boolean // 保留向后兼容（deprecated，优先用 fileCapabilities）
  fileCapabilities?: FileCapabilities
  // Model（移动端 InputToolbar 用）
  models?: ModelInfo[]
  selectedModelKey?: string | null
  onModelChange?: (modelKey: string, model: ModelInfo) => void
  modelsLoading?: boolean
  modelSelectorRef?: React.RefObject<ModelSelectorHandle | null>
  contextStats?: SessionStats
  hasMessages?: boolean
  rootPath?: string
  sessionId?: string | null
  queuedFollowups?: QueuedFollowupDraft[]
  queuedFollowupSendingId?: string
  onQueuedFollowupRemove?: (id: string) => void
  onQueuedFollowupUpdate?: (id: string, text: string) => boolean
  onQueuedFollowupMove?: (id: string, direction: -1 | 1) => void
  onQueuedFollowupSteer?: (id: string) => Promise<boolean> | boolean
  // Undo/Redo
  revertedText?: string
  revertedAttachments?: Attachment[]
  canRedo?: boolean
  revertSteps?: number
  onRedo?: () => void
  onRedoAll?: () => void
  onClearRevert?: () => void
  // Animation
  registerInputBox?: (element: HTMLElement | null) => void
  isAtBottom?: boolean
  showScrollToBottom?: boolean
  onScrollToBottom?: () => void
  // Collapsed dialog capsules
  collapsedPermission?: CollapsedDialogInfo
  collapsedQuestion?: CollapsedDialogInfo
  homeMode?: boolean
}

function FollowupQueue({
  items,
  sendingId,
  isStreaming,
  onRemove,
  onUpdate,
  onMove,
  onSteer,
}: {
  items: QueuedFollowupDraft[]
  sendingId?: string
  isStreaming?: boolean
  onRemove?: (id: string) => void
  onUpdate?: (id: string, text: string) => boolean
  onMove?: (id: string, direction: -1 | 1) => void
  onSteer?: (id: string) => Promise<boolean> | boolean
}) {
  const { t } = useTranslation('chat')
  const [editingId, setEditingId] = useState<string>()
  const [editingText, setEditingText] = useState('')

  useEffect(() => {
    if (!editingId || items.some(item => item.id === editingId)) return
    setEditingId(undefined)
    setEditingText('')
  }, [editingId, items])

  const saveEdit = () => {
    if (!editingId || !onUpdate?.(editingId, editingText)) return
    setEditingId(undefined)
    setEditingText('')
  }

  return (
    <div className="relative z-0 -mb-3 rounded-t-2xl border border-b-0 border-border-200/55 bg-bg-100/95 px-3 pb-4 pt-2 shadow-sm">
      <div className="mb-1.5 flex items-center justify-between text-[length:var(--fs-xs)] text-text-400">
        <span>{t('followupQueue.title', { count: items.length })}</span>
        <span>{t('followupQueue.shortcut')}</span>
      </div>
      <div className="space-y-1.5">
        {items.map((item, index) => {
          const sending = sendingId === item.id
          const editing = editingId === item.id
          return (
            <div
              key={item.id}
              className="group flex min-w-0 items-center gap-2 rounded-xl bg-bg-200/65 px-2.5 py-2 text-[length:var(--fs-sm)] text-text-100"
            >
              <span className="shrink-0 text-[length:var(--fs-xxs)] tabular-nums text-text-500">{index + 1}</span>
              {editing ? (
                <input
                  autoFocus
                  value={editingText}
                  onChange={event => setEditingText(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      saveEdit()
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      setEditingId(undefined)
                    }
                  }}
                  className="min-w-0 flex-1 rounded-md border border-border-200/70 bg-bg-000/80 px-2 py-1 text-text-100 outline-none focus:border-accent-main-100/60"
                />
              ) : (
                <div className="min-w-0 flex-1">
                  <div className="truncate">{item.text}</div>
                  {item.attachments.length > 0 && (
                    <div className="text-[length:var(--fs-xxs)] text-text-500">
                      {t('followupQueue.attachments', { count: item.attachments.length })}
                    </div>
                  )}
                </div>
              )}
              <div className="flex shrink-0 items-center gap-0.5">
                {editing ? (
                  <>
                    <button type="button" onClick={saveEdit} className="rounded-md px-2 py-1 text-accent-main-100 hover:bg-bg-300/70">
                      {t('followupQueue.save')}
                    </button>
                    <button type="button" onClick={() => setEditingId(undefined)} className="rounded-md p-1 text-text-400 hover:bg-bg-300/70 hover:text-text-100" aria-label={t('followupQueue.cancel')}>
                      <CloseIcon size={13} />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={sending}
                      onClick={() => void onSteer?.(item.id)}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-text-300 hover:bg-bg-300/70 hover:text-text-100 disabled:opacity-50"
                      title={isStreaming ? t('followupQueue.steerDescription') : t('followupQueue.sendDescription')}
                    >
                      <ReturnIcon size={13} />
                      {sending ? t('followupQueue.sending') : isStreaming ? t('followupQueue.steer') : t('followupQueue.send')}
                    </button>
                    <button type="button" disabled={sending || index === 0} onClick={() => onMove?.(item.id, -1)} className="rounded-md p-1 text-text-400 hover:bg-bg-300/70 hover:text-text-100 disabled:opacity-25" aria-label={t('followupQueue.moveUp')}>
                      <ArrowUpIcon size={13} />
                    </button>
                    <button type="button" disabled={sending || index === items.length - 1} onClick={() => onMove?.(item.id, 1)} className="rounded-md p-1 text-text-400 hover:bg-bg-300/70 hover:text-text-100 disabled:opacity-25" aria-label={t('followupQueue.moveDown')}>
                      <ArrowDownIcon size={13} />
                    </button>
                    <button
                      type="button"
                      disabled={sending}
                      onClick={() => {
                        setEditingId(item.id)
                        setEditingText(item.text)
                      }}
                      className="rounded-md p-1 text-text-400 hover:bg-bg-300/70 hover:text-text-100 disabled:opacity-50"
                      aria-label={t('followupQueue.edit')}
                    >
                      <PencilIcon size={13} />
                    </button>
                    <button type="button" disabled={sending} onClick={() => onRemove?.(item.id)} className="rounded-md p-1 text-text-400 hover:bg-danger-100/10 hover:text-danger-100 disabled:opacity-50" aria-label={t('followupQueue.delete')}>
                      <TrashIcon size={13} />
                    </button>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

type TaskPreflightIssue = { level: 'error' | 'warning' | 'info'; message: string }

function NewTaskContextBar({ paneId, onApplyProfile, onPreflight }: { paneId: string; onApplyProfile: (profile: ProjectProfile) => void; onPreflight: (issues: TaskPreflightIssue[]) => void }) {
  const { t } = useTranslation('chat')
  const { currentDirectory, setCurrentDirectory, savedDirectories } = useDirectory()
  const { servers, activeServer, setActiveServer, checkHealth, getHealth } = useServerStore()
  const [menu, setMenu] = useState<'project' | 'server' | 'mode' | 'branch'>()
  const [branches, setBranches] = useState<VcsBranch[]>([])
  const [branchLoading, setBranchLoading] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [executionMode, setExecutionMode] = useState<'current' | 'worktree'>('current')
  const [dirtyCount, setDirtyCount] = useState(0)
  const [preflightIssues, setPreflightIssues] = useState<TaskPreflightIssue[]>([])
  const appliedProfileRef = useRef('')
  const appliedBranchRef = useRef('')
  const menuRef = useRef<HTMLDivElement>(null)
  const projects = useMemo(
    () => projectOptionsInSidebarOrder(savedDirectories, currentDirectory),
    [currentDirectory, savedDirectories],
  )
  const projectName = currentDirectory
    ? projects.find(directory => isSameDirectory(directory.path, currentDirectory))?.name ||
      getDirectoryName(currentDirectory) ||
      currentDirectory
    : t('emptyState.chooseProject')
  const serverName = activeServer
    ? activeServer.name
    : t('emptyState.noServer')
  const selectedBranch = branches.find(branch => branch.current)?.name
  const activeHealth = activeServer ? getHealth(activeServer.id) : null
  const supportsWorktree = activeHealth?.status === 'online' && activeHealth.capabilities?.worktree === true
  const supportsBranchSwitch = activeHealth?.status === 'online' && activeHealth.capabilities?.vcsMutations === true
  const projectProfile = projectProfileStore.get(currentDirectory)

  useEffect(() => {
    if (!activeServer || activeHealth) return
    void checkHealth(activeServer.id)
  }, [activeHealth, activeServer, checkHealth])

  useEffect(() => {
    if (!activeServer) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void checkHealth(activeServer.id)
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [activeServer, checkHealth])

  useEffect(() => {
    if (supportsWorktree || executionMode === 'current') return
    setExecutionMode('current')
  }, [executionMode, supportsWorktree])

  useEffect(() => {
    if (!activeServer) return
    const previous = executionTargetStore.getDraft(paneId)
    const sameLocation = previous?.serverId === activeServer.id && previous.directory === (currentDirectory ?? '')
    const targetMode = sameLocation ? executionMode : 'current'
    if (!sameLocation && executionMode !== 'current') setExecutionMode('current')
    executionTargetStore.updateDraft(paneId, {
      serverId: activeServer.id,
      directory: currentDirectory ?? '',
      sourceDirectory: currentDirectory,
      executionMode: targetMode,
      projectId: sameLocation ? previous.projectId : undefined,
      branch: selectedBranch,
      worktreeId: sameLocation ? previous.worktreeId : undefined,
      permissionProfile: projectProfile?.permissionProfile ?? (sameLocation ? previous.permissionProfile : undefined),
    })
  }, [activeServer, currentDirectory, executionMode, paneId, projectProfile?.permissionProfile, selectedBranch])

  useEffect(() => {
    if (!menu) return
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(undefined)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menu])

  useEffect(() => {
    if (!currentDirectory) {
      setBranches([])
      setDirtyCount(0)
      setBranchLoading(false)
      return
    }

    let disposed = false
    // The first branch read can race the managed service becoming reachable. Retry when the
    // runtime URL changes and stop the spinner if the request never settles.
    const timeoutId = window.setTimeout(() => {
      if (!disposed) setBranchLoading(false)
    }, 15_000)
    setBranchLoading(true)
    void Promise.all([getVcsInfo(currentDirectory), listVcsBranches(currentDirectory).catch(() => []), getVcsDiff('git', currentDirectory).catch(() => [])])
      .then(([info, listed, changes]) => {
        if (disposed) return
        setBranches(Array.isArray(listed) && listed.length > 0 ? listed : info?.branch ? [{ name: info.branch, current: true }] : [])
        setDirtyCount(changes.length)
      })
      .catch(() => {})
      .finally(() => {
        window.clearTimeout(timeoutId)
        if (!disposed) setBranchLoading(false)
      })
    return () => {
      disposed = true
      window.clearTimeout(timeoutId)
    }
  }, [activeServer?.id, activeServer?.url, currentDirectory])

  const selectServer = async (serverId: string) => {
    if (serverId === activeServer?.id) {
      setMenu(undefined)
      return
    }

    setSwitching(true)
    const health = await checkHealth(serverId)
    setSwitching(false)
    if (health.status !== 'online') {
      notificationStore.push(
        'error',
        t('emptyState.serverUnavailable'),
        health.error || servers.find(server => server.id === serverId)?.url || t('emptyState.serverUnavailableDescription'),
        '',
      )
      return
    }

    setActiveServer(serverId)
    setMenu(undefined)
  }

  const selectBranch = async (branch: string) => {
    if (!currentDirectory || branch === selectedBranch) {
      setMenu(undefined)
      return
    }

    setSwitching(true)
    try {
      await switchVcsBranch(branch, currentDirectory)
      setBranches(current => current.map(item => ({ ...item, current: item.name === branch })))
      setMenu(undefined)
    } catch (error) {
      notificationStore.push(
        'error',
        t('emptyState.branchSwitchFailed'),
        error instanceof Error ? error.message : t('emptyState.branchSwitchFailedDescription'),
        '',
        currentDirectory,
      )
    } finally {
      setSwitching(false)
    }
  }

  useEffect(() => {
    if (!projectProfile || !currentDirectory) return
    const key = `${currentDirectory}:${projectProfile.updatedAt}:${activeServer?.id ?? ''}`
    if (appliedProfileRef.current === key) return
    appliedProfileRef.current = key
    onApplyProfile(projectProfile)
    if (projectProfile.executionMode === 'worktree' && supportsWorktree) setExecutionMode('worktree')
    if (!projectProfile.defaultServerId || projectProfile.defaultServerId === activeServer?.id) return
    void checkHealth(projectProfile.defaultServerId).then(health => {
      if (health.status === 'online') {
        setActiveServer(projectProfile.defaultServerId!)
        return
      }
      notificationStore.push('error', '项目默认服务器不可用', health.error || projectProfile.defaultServerId || '', '', currentDirectory)
    })
  }, [activeServer?.id, checkHealth, currentDirectory, onApplyProfile, projectProfile, setActiveServer, supportsWorktree])

  useEffect(() => {
    if (!projectProfile?.defaultBranch || !currentDirectory || branchLoading || branches.length === 0) return
    if (selectedBranch === projectProfile.defaultBranch) return
    const key = `${currentDirectory}:${activeServer?.id}:${projectProfile.updatedAt}:${projectProfile.defaultBranch}`
    if (appliedBranchRef.current === key) return
    appliedBranchRef.current = key
    if (!supportsBranchSwitch || !branches.some(branch => branch.name === projectProfile.defaultBranch)) return
    if (dirtyCount > 0) {
      notificationStore.push('completed', '未自动切换项目默认分支', `工作区有 ${dirtyCount} 个未提交文件，请处理后手动切换到 ${projectProfile.defaultBranch}。`, '', currentDirectory)
      return
    }
    void selectBranch(projectProfile.defaultBranch)
  }, [activeServer?.id, branchLoading, branches, currentDirectory, dirtyCount, projectProfile, selectedBranch, supportsBranchSwitch])

  useEffect(() => {
    const issues: TaskPreflightIssue[] = []
    if (!activeServer) issues.push({ level: 'error', message: '没有可用的执行服务器。' })
    if (activeHealth && activeHealth.status !== 'online' && activeHealth.status !== 'checking') issues.push({ level: 'error', message: activeHealth.error || '执行服务器不可用。' })
    if (activeHealth?.compatibility === 'incompatible') issues.push({ level: 'error', message: '服务器版本与当前客户端不兼容。' })
    if (activeHealth?.status === 'checking' || !activeHealth) issues.push({ level: 'info', message: '正在检查服务器和项目环境…' })
    if (executionMode === 'worktree' && !supportsWorktree) issues.push({ level: 'error', message: '当前服务器不支持隔离 Worktree。' })
    if (dirtyCount > 0 && executionMode === 'current') issues.push({ level: 'warning', message: `当前工作区有 ${dirtyCount} 个未提交文件。` })
    if (projectProfile?.setupCommands.length) issues.push({ level: 'info', message: `项目 Profile 配置了 ${projectProfile.setupCommands.length} 条初始化命令。` })
    setPreflightIssues(issues)
    onPreflight(issues)
  }, [activeHealth, activeServer, dirtyCount, executionMode, onPreflight, projectProfile?.setupCommands.length, supportsWorktree])

  const triggerClass =
    'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[length:var(--fs-xs)] font-normal text-text-400 transition-colors hover:bg-bg-200/60 hover:text-text-100 disabled:opacity-60'
  const menuClass =
    'absolute bottom-full left-0 z-50 mb-2 max-h-64 min-w-60 overflow-y-auto rounded-xl border border-border-200/70 bg-bg-000 p-1 shadow-xl'

  return (
    <div
      ref={menuRef}
      className="relative z-0 mb-1 flex h-8 items-center gap-1 overflow-visible px-1"
    >
      <div className="relative min-w-0">
        <button
          type="button"
          onClick={() => setMenu(value => (value === 'project' ? undefined : 'project'))}
          className={`${triggerClass} max-w-52`}
          aria-haspopup="menu"
          aria-expanded={menu === 'project'}
          title={currentDirectory || t('emptyState.noWorkingDirectoryDescription')}
        >
          {currentDirectory ? <FolderIcon size={15} /> : <GlobeIcon size={15} />}
          <span className="truncate">{projectName}</span>
        </button>
        {menu === 'project' && (
          <div role="menu" className={menuClass}>
            <div className="px-2.5 py-1.5 text-[length:var(--fs-xxs)] font-medium uppercase tracking-wide text-text-500">
              {t('emptyState.workingDirectory')}
            </div>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!currentDirectory}
              onClick={() => {
                setCurrentDirectory(undefined)
                setMenu(undefined)
              }}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[length:var(--fs-sm)] transition-colors ${!currentDirectory ? 'sidebar-selected-row text-text-100' : 'text-text-300 hover:bg-bg-200/70'}`}
            >
              <GlobeIcon size={14} />
              <span className="min-w-0 flex-1 truncate">{t('emptyState.noWorkingDirectory')}</span>
            </button>
            {projects.map(directory => {
              const selected = !!currentDirectory && isSameDirectory(directory.path, currentDirectory)
              return (
                <button
                  key={directory.path}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => {
                    setCurrentDirectory(directory.path)
                    setMenu(undefined)
                  }}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[length:var(--fs-sm)] transition-colors ${selected ? 'sidebar-selected-row text-text-100' : 'text-text-300 hover:bg-bg-200/70'}`}
                  title={directory.path}
                >
                  <FolderIcon size={14} />
                  <span className="min-w-0 flex-1 truncate">{directory.name}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className="relative shrink-0">
        <button
          type="button"
          disabled={switching}
          onClick={() => setMenu(value => {
            if (value === 'server') return undefined
            void Promise.all(servers.map(server => checkHealth(server.id)))
            return 'server'
          })}
          className={triggerClass}
          aria-haspopup="menu"
          aria-expanded={menu === 'server'}
          title={activeServer?.url}
        >
          {switching ? (
            <SpinnerIcon size={15} className="animate-spin" />
          ) : isLoopbackServer(activeServer?.url || '') ? (
            <LaptopIcon size={15} />
          ) : (
            <GlobeIcon size={15} />
          )}
          <span className="max-w-32 truncate">{serverName}</span>
        </button>
        {menu === 'server' && (
          <div role="menu" className={menuClass}>
            <div className="px-2.5 py-1.5 text-[length:var(--fs-xxs)] font-medium uppercase tracking-wide text-text-500">
              {t('emptyState.executionServer')}
            </div>
            {servers.map(server => {
              const selected = server.id === activeServer?.id
              const health = getHealth(server.id)
              return (
                <button
                  key={server.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => void selectServer(server.id)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[length:var(--fs-sm)] transition-colors ${selected ? 'sidebar-selected-row text-text-100' : 'text-text-300 hover:bg-bg-200/70'}`}
                >
                  {isLoopbackServer(server.url) ? <LaptopIcon size={14} /> : <GlobeIcon size={14} />}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5"><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${health?.status === 'online' ? 'bg-success-100' : health?.status === 'checking' ? 'animate-pulse bg-warning-100' : health ? 'bg-danger-100' : 'bg-text-500'}`} /><span className="truncate">{server.name}</span>{health?.latency !== undefined ? <span className="shrink-0 text-[length:var(--fs-xxs)] text-text-500">{health.latency}ms</span> : null}</span>
                    <span className="block truncate font-mono text-[length:var(--fs-xxs)] text-text-500">{server.url}</span>
                    {health?.status === 'online' ? <span className="block truncate text-[length:var(--fs-xxs)] text-text-500">OpenCode {health.version || '—'} · {health.compatibility || 'unknown'}</span> : health?.error ? <span className="block truncate text-[length:var(--fs-xxs)] text-danger-100">{health.error}</span> : null}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className="relative shrink-0">
        <button
          type="button"
          disabled={!currentDirectory || branchLoading}
          onClick={() => setMenu(value => (value === 'mode' ? undefined : 'mode'))}
          className={triggerClass}
          aria-haspopup="menu"
          aria-expanded={menu === 'mode'}
        >
          {executionMode === 'worktree' ? <GitWorktreeIcon size={15} /> : <FolderIcon size={15} />}
          <span>{t(executionMode === 'worktree' ? 'emptyState.isolatedWorktree' : 'emptyState.currentWorkspace')}</span>
        </button>
        {menu === 'mode' && (
          <div role="menu" className={menuClass}>
            <div className="px-2.5 py-1.5 text-[length:var(--fs-xxs)] font-medium uppercase tracking-wide text-text-500">
              {t('emptyState.executionMode')}
            </div>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={executionMode === 'current'}
              onClick={() => {
                setExecutionMode('current')
                setMenu(undefined)
              }}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[length:var(--fs-sm)] transition-colors ${executionMode === 'current' ? 'sidebar-selected-row text-text-100' : 'text-text-300 hover:bg-bg-200/70'}`}
            >
              <FolderIcon size={14} />
              <span>{t('emptyState.currentWorkspace')}</span>
            </button>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={executionMode === 'worktree'}
              disabled={branches.length === 0 || !supportsWorktree}
              onClick={() => {
                setExecutionMode('worktree')
                setMenu(undefined)
              }}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[length:var(--fs-sm)] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${executionMode === 'worktree' ? 'sidebar-selected-row text-text-100' : 'text-text-300 hover:bg-bg-200/70'}`}
            >
              <GitWorktreeIcon size={14} />
              <span className="min-w-0 flex-1">
                <span className="block">{t('emptyState.isolatedWorktree')}</span>
                <span className="block text-[length:var(--fs-xxs)] text-text-500">
                  {supportsWorktree ? t('emptyState.isolatedWorktreeDescription') : t('emptyState.serverFeatureUnavailable')}
                </span>
              </span>
            </button>
          </div>
        )}
      </div>

      {(branchLoading || selectedBranch) && (
        <div className="relative min-w-0">
          <button
            type="button"
            disabled={branchLoading || switching || branches.length < 2 || !supportsBranchSwitch}
            onClick={() => setMenu(value => (value === 'branch' ? undefined : 'branch'))}
            className={`${triggerClass} max-w-44 disabled:cursor-default`}
            aria-haspopup="menu"
            aria-expanded={menu === 'branch'}
            title={selectedBranch}
          >
            {branchLoading ? <SpinnerIcon size={15} className="animate-spin" /> : <GitBranchIcon size={15} />}
            <span className="truncate">{selectedBranch || t('emptyState.loadingBranch')}</span>
          </button>
          {menu === 'branch' && branches.length > 1 && supportsBranchSwitch && (
            <div role="menu" className={menuClass}>
              <div className="px-2.5 py-1.5 text-[length:var(--fs-xxs)] font-medium uppercase tracking-wide text-text-500">
                {t('emptyState.gitBranch')}
              </div>
              {branches.map(branch => (
                <button
                  key={branch.name}
                  type="button"
                  role="menuitemradio"
                  aria-checked={branch.current}
                  onClick={() => void selectBranch(branch.name)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[length:var(--fs-sm)] transition-colors ${branch.current ? 'sidebar-selected-row text-text-100' : 'text-text-300 hover:bg-bg-200/70'}`}
                >
                  <GitBranchIcon size={14} />
                  <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {preflightIssues.length > 0 ? (
        <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2 pl-2 text-[length:var(--fs-xxs)] text-text-400">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              preflightIssues.some(issue => issue.level === 'error')
                ? 'bg-danger-100'
                : preflightIssues.some(issue => issue.level === 'warning')
                  ? 'bg-warning-100'
                  : 'bg-accent-main-100'
            }`}
          />
          <span className="truncate" title={preflightIssues.map(issue => issue.message).join('\n')}>
            {preflightIssues.map(issue => issue.message).join(' · ')}
          </span>
        </div>
      ) : null}
    </div>
  )
}

// ============================================
// InputBox Component
// ============================================

function InputBoxComponent({
  paneId,
  onSend,
  onAbort,
  onCommand,
  onNewChat,
  disabled,
  isStreaming,
  agents = [],
  selectedAgent,
  onAgentChange,
  variants = [],
  selectedVariant,
  onVariantChange,
  supportsImages = false,
  fileCapabilities: fileCapabilitiesProp,
  models = [],
  selectedModelKey = null,
  onModelChange,
  modelsLoading = false,
  modelSelectorRef,
  contextStats,
  hasMessages = false,
  rootPath = '',
  sessionId,
  queuedFollowups = [],
  queuedFollowupSendingId,
  onQueuedFollowupRemove,
  onQueuedFollowupUpdate,
  onQueuedFollowupMove,
  onQueuedFollowupSteer,
  revertedText,
  revertedAttachments,
  canRedo = false,
  revertSteps = 0,
  onRedo,
  onRedoAll,
  onClearRevert,
  registerInputBox,
  isAtBottom = true,
  showScrollToBottom = false,
  onScrollToBottom,
  collapsedPermission,
  collapsedQuestion,
  homeMode = false,
}: InputBoxProps) {
  const { t } = useTranslation('chat')
  const { currentDirectory, savedDirectories } = useDirectory()
  const { sessions } = useSessionContext()
  const taskProjectProfile = projectProfileStore.get(currentDirectory)
  const taskExecutionTarget = executionTargetStore.getDraft(paneId)
  // 合并文件能力：优先用 fileCapabilities，回退到 supportsImages
  const fileCaps: FileCapabilities = useMemo(
    () =>
      fileCapabilitiesProp ?? {
        image: supportsImages,
        pdf: false,
        audio: false,
        video: false,
      },
    [fileCapabilitiesProp, supportsImages],
  )
  const { enterKeyBehavior, queueFollowupMessages } = useSyncExternalStore(
    themeStore.subscribe,
    themeStore.getSnapshot,
  )

  // 是否有任何文件附件能力
  // PDF and Office documents can always enter the attachment pipeline. The
  // provider remains responsible for returning a visible unsupported-format
  // error if the selected model cannot parse them.
  const supportsAnyFile = true

  // 文本状态
  const [text, setText] = useState(() => composerDraftStore.getDraft(paneId)?.text ?? '')
  const [voiceListening, setVoiceListening] = useState(false)
  const [voiceTranscribing, setVoiceTranscribing] = useState(false)
  const voiceRecorderRef = useRef<VoiceRecorderState | null>(null)
  // 语音模型是否已在 设置-语音模型 中配置可用（apiKeyRequired 且缺 key 视为未配置）
  const [voiceConfigured, setVoiceConfigured] = useState(false)
  useEffect(() => {
    let disposed = false
    void window.customOpenCode?.speechModelConfig?.()
      .then(config => {
        if (disposed) return
        setVoiceConfigured(!!config && !(config.apiKeyRequired && !config.hasApiKey))
      })
      .catch(() => {
        if (!disposed) setVoiceConfigured(false)
      })
    return () => {
      disposed = true
    }
  }, [])
  const voiceSupported = typeof window !== 'undefined'
    && typeof MediaRecorder !== 'undefined'
    && Boolean(navigator.mediaDevices?.getUserMedia)
    && typeof window.customOpenCode?.transcribeAudio === 'function'
    && voiceConfigured
  const toggleVoice = useCallback(async () => {
    if (voiceTranscribing) return
    if (voiceListening) {
      const active = voiceRecorderRef.current
      if (active && active.recorder.state !== 'inactive') active.recorder.stop()
      setVoiceListening(false)
      return
    }
    const config = await window.customOpenCode.speechModelConfig().catch(() => undefined)
    if (!config || (config.apiKeyRequired && !config.hasApiKey)) {
      notificationStore.push(
        'error',
        t('inputToolbar.voicePermissionTitle'),
        t('inputToolbar.voiceModelNotConfigured'),
        sessionId ?? '',
        currentDirectory,
      )
      return
    }
    const permission = await window.customOpenCode?.microphonePermission?.().catch(() => 'unknown' as const)
    if (permission === 'cancelled' || permission === 'settings-opened') return
    if (permission === 'denied' || permission === 'restricted') {
      notificationStore.push(
        'error',
        t('inputToolbar.voicePermissionTitle'),
        t(permission === 'restricted' ? 'inputToolbar.voicePermissionRestricted' : 'inputToolbar.voicePermissionDenied'),
        sessionId ?? '',
        currentDirectory,
      )
      return
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(error => {
      const denied = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')
      notificationStore.push(
        'error',
        t('inputToolbar.voicePermissionTitle'),
        denied ? t('inputToolbar.voicePermissionDenied') : t('inputToolbar.voiceAudioUnavailable'),
        sessionId ?? '',
        currentDirectory,
      )
      return undefined
    })
    if (!stream) return
    try {
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type))
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      const state: VoiceRecorderState = { recorder, stream, chunks: [] }
      voiceRecorderRef.current = state
      recorder.ondataavailable = event => {
        if (event.data.size > 0) state.chunks.push(event.data)
      }
      recorder.onerror = () => {
        recorder.onstop = null
        if (voiceRecorderRef.current === state) voiceRecorderRef.current = null
        state.stream.getTracks().forEach(track => track.stop())
        setVoiceListening(false)
        setVoiceTranscribing(false)
        notificationStore.push(
          'error',
          t('inputToolbar.voicePermissionTitle'),
          t('inputToolbar.voiceAudioUnavailable'),
          sessionId ?? '',
          currentDirectory,
        )
      }
      recorder.onstop = async () => {
        if (voiceRecorderRef.current === state) voiceRecorderRef.current = null
        state.stream.getTracks().forEach(track => track.stop())
        setVoiceListening(false)
        if (state.chunks.length === 0) {
          notificationStore.push(
            'error',
            t('inputToolbar.voicePermissionTitle'),
            t('inputToolbar.voiceNoSpeech'),
            sessionId ?? '',
            currentDirectory,
          )
          return
        }
        setVoiceTranscribing(true)
        try {
          const audio = new Blob(state.chunks, { type: recorder.mimeType || state.chunks[0]?.type || 'audio/webm' })
          const normalized = await normalizeVoiceRecording(audio)
          const result = await window.customOpenCode.transcribeAudio({
            data: await normalized.arrayBuffer(),
            mimeType: normalized.type,
          })
          if (result.text) {
            setText(current => `${current}${current && !/\s$/.test(current) ? ' ' : ''}${result.text}`)
            requestAnimationFrame(() => textareaRef.current?.focus())
          }
        } catch (error) {
          notificationStore.push(
            'error',
            t('inputToolbar.voicePermissionTitle'),
            t('inputToolbar.voiceRecognitionFailed', { error: error instanceof Error ? error.message : String(error) }),
            sessionId ?? '',
            currentDirectory,
          )
        } finally {
          setVoiceTranscribing(false)
        }
      }
      recorder.start(1_000)
      setVoiceListening(true)
    } catch (error) {
      stream.getTracks().forEach(track => track.stop())
      voiceRecorderRef.current = null
      setVoiceListening(false)
      notificationStore.push(
        'error',
        t('inputToolbar.voicePermissionTitle'),
        t('inputToolbar.voiceRecognitionFailed', { error: error instanceof Error ? error.message : String(error) }),
        sessionId ?? '',
        currentDirectory,
      )
    }
  }, [currentDirectory, sessionId, t, voiceListening, voiceTranscribing])
  useEffect(
    () => () => {
      const active = voiceRecorderRef.current
      if (!active) return
      active.recorder.onstop = null
      if (active.recorder.state !== 'inactive') active.recorder.stop()
      active.stream.getTracks().forEach(track => track.stop())
      voiceRecorderRef.current = null
    },
    [],
  )
  // 附件状态（图片、文件、文件夹、agent）
  const [attachments, setAttachments] = useState<Attachment[]>(() => composerDraftStore.getDraft(paneId)?.attachments ?? [])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [taskPreflightIssues, setTaskPreflightIssues] = useState<TaskPreflightIssue[]>([])
  const applyProjectProfile = useCallback((profile: ProjectProfile) => {
    if (profile.defaultAgent && agents.some(agent => agent.name === profile.defaultAgent)) onAgentChange?.(profile.defaultAgent)
    if (!profile.defaultModelKey) return
    const model = models.find(item => getModelKey(item) === profile.defaultModelKey)
    if (model) onModelChange?.(profile.defaultModelKey, model)
  }, [agents, models, onAgentChange, onModelChange])
  const updateTaskPreflight = useCallback((issues: TaskPreflightIssue[]) => setTaskPreflightIssues(issues), [])

  // 挂载时从主进程异步恢复持久化草稿；仅当用户尚未输入时回填
  useEffect(() => {
    let disposed = false
    void composerDraftStore.hydratePane(paneId).then(() => {
      if (disposed) return
      const draft = composerDraftStore.getDraft(paneId)
      if (!draft) return
      setText(current => (current === '' && draft.text ? draft.text : current))
      setAttachments(current => (current.length === 0 && draft.attachments.length > 0 ? draft.attachments : current))
    })
    return () => {
      disposed = true
    }
  }, [paneId])

  useEffect(
    () =>
      onComposerDraftInsertion(insertion => {
        if (!matchesComposerDraftInsertion(insertion, { sessionId, paneId })) return
        setText(current => applyComposerDraftInsertion(current, insertion))
        requestAnimationFrame(() => textareaRef.current?.focus())
      }),
    [paneId, sessionId],
  )

  // @ Mention 状态
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [mentionStartIndex, setMentionStartIndex] = useState(-1)

  // / Slash Command 状态
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [slashStartIndex, setSlashStartIndex] = useState(-1)

  // # Session Reference 状态
  const [sessionReferenceOpen, setSessionReferenceOpen] = useState(false)
  const [sessionReferenceQuery, setSessionReferenceQuery] = useState('')
  const [sessionReferenceStartIndex, setSessionReferenceStartIndex] = useState(-1)

  // 拖拽状态
  const [isDragging, setIsDragging] = useState(false)
  const [isInternalFileDragging, setIsInternalFileDragging] = useState(false)
  const dragCounterRef = useRef(0)
  const { presentation, interaction } = useChatViewport()
  const isCompact = presentation.isCompact

  // Refs
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const inputContainerRef = useRef<HTMLDivElement>(null)
  const attachmentRailRef = useRef<HTMLDivElement>(null)
  const attachmentSectionRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const mentionMenuRef = useRef<MentionMenuHandle>(null)
  const slashMenuRef = useRef<SlashCommandMenuHandle>(null)
  const sessionReferenceMenuRef = useRef<SessionReferenceMenuHandle>(null)
  const prevRevertedTextRef = useRef<string | undefined>(undefined)
  const latestDraftRef = useRef<HistoryEntry>({ text: '', attachments: [] })
  const contentWrapRef = useRef<HTMLDivElement>(null)
  const footerRef = useRef<HTMLDivElement>(null)
  const isComposingRef = useRef(false)
  const compositionEndTimerRef = useRef<number | null>(null)
  const [composerMaxHeight, setComposerMaxHeight] = useState(280)
  const [inputContainerMaxHeight, setInputContainerMaxHeight] = useState(240)
  const [textareaMaxHeight, setTextareaMaxHeight] = useState(180)
  const [toolbarWidth, setToolbarWidth] = useState(0)

  // 监听输入框宽度，用于紧凑模式判断
  useEffect(() => {
    const el = inputContainerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        setToolbarWidth(entry.contentRect.width)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 附件横向轨道
  const {
    overflowing: attachmentsOverflowing,
    showLeftFade: showAttachmentLeftFade,
    showRightFade: showAttachmentRightFade,
    handleScroll: syncAttachmentRailState,
    handleWheel: handleAttachmentRailWheel,
  } = useAttachmentRail({ attachmentCount: attachments.length, railRef: attachmentRailRef })

  // ============================================
  // 历史消息导航（类终端体验，逻辑在 useInputHistory hook 中）
  // ============================================
  const { handleHistoryKeyDown, handleHistoryChange, resetHistoryIndex } = useInputHistory({ textareaRef })

  // ============================================
  // Mobile Input Dock: 滚动收起/展开（逻辑在 useMobileCollapse hook 中）
  // ============================================
  const hasContent = text.trim().length > 0 || attachments.length > 0
  const { isCollapsed, expandedHeight, handleExpandInput, handleFocus, handleBlur, handleContainerPointerDown } =
    useMobileCollapse({
      enabled: interaction.enableCollapsedInputDock,
      hasContent,
      isAtBottom,
      textareaRef,
      inputContainerRef,
      contentWrapRef,
      footerRef,
      registerInputBox,
      collapsedPermission,
      collapsedQuestion,
    })

  // 处理 revert 恢复
  useEffect(() => {
    latestDraftRef.current = { text, attachments }
  }, [text, attachments])

  // 草稿记忆：输入内容写入 composerDraftStore，页面切换（组件卸载/重挂载）后恢复
  useEffect(() => {
    if (text.trim().length === 0 && attachments.length === 0) {
      composerDraftStore.clearDraft(paneId)
      return
    }
    composerDraftStore.saveDraft(paneId, { text, attachments })
  }, [attachments, paneId, text])

  useEffect(() => {
    let frameId: number | null = null

    if (revertedText !== undefined) {
      frameId = requestAnimationFrame(() => {
        setText(revertedText)
        setAttachments(revertedAttachments || [])
        // 聚焦并移动光标到末尾
        if (textareaRef.current) {
          textareaRef.current.focus()
          textareaRef.current.setSelectionRange(revertedText.length, revertedText.length)
        }
      })
    } else if (prevRevertedTextRef.current !== undefined && revertedText === undefined && !isSubmitting) {
      frameId = requestAnimationFrame(() => {
        setText('')
        setAttachments([])
      })
    }

    prevRevertedTextRef.current = revertedText

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId)
      }
    }
  }, [revertedText, revertedAttachments, isSubmitting])

  useEffect(
    () => () => {
      if (compositionEndTimerRef.current !== null) {
        clearTimeout(compositionEndTimerRef.current)
      }
    },
    [],
  )

  const updateComposerHeightBudget = useCallback(() => {
    const paneHeight = getComposerPaneHeight(inputContainerRef.current ?? contentWrapRef.current)
    const nextComposerMaxHeight = getComposerMaxHeight(paneHeight, isCompact)
    const attachmentHeight = attachments.length > 0 ? (attachmentSectionRef.current?.offsetHeight ?? 0) : 0
    const toolbarHeight = toolbarRef.current?.offsetHeight || INPUT_TOOLBAR_FALLBACK_HEIGHT
    const footerHeight = isCollapsed ? 0 : footerRef.current?.offsetHeight || INPUT_FOOTER_FALLBACK_HEIGHT
    const inputContainerChrome = attachmentHeight + toolbarHeight + TEXTAREA_VERTICAL_CHROME
    const nextInputContainerMaxHeight = Math.max(
      TEXTAREA_MIN_HEIGHT + TEXTAREA_VERTICAL_CHROME + toolbarHeight,
      nextComposerMaxHeight - footerHeight,
    )
    const nextTextareaMaxHeight = Math.max(
      TEXTAREA_MIN_HEIGHT,
      nextInputContainerMaxHeight - inputContainerChrome,
    )

    setComposerMaxHeight(prev => (Math.abs(prev - nextComposerMaxHeight) < 1 ? prev : nextComposerMaxHeight))
    setInputContainerMaxHeight(prev =>
      Math.abs(prev - nextInputContainerMaxHeight) < 1 ? prev : nextInputContainerMaxHeight,
    )
    setTextareaMaxHeight(prev => (Math.abs(prev - nextTextareaMaxHeight) < 1 ? prev : nextTextareaMaxHeight))
  }, [attachments.length, isCollapsed, isCompact])

  useLayoutEffect(() => {
    updateComposerHeightBudget()
  }, [updateComposerHeightBudget, text])

  useEffect(() => {
    updateComposerHeightBudget()

    const observed = [
      inputContainerRef.current?.closest<HTMLElement>('[data-chat-pane-root]'),
      inputContainerRef.current,
      attachmentSectionRef.current,
      toolbarRef.current,
      footerRef.current,
    ].filter((element): element is HTMLElement => !!element)

    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateComposerHeightBudget) : null
    observed.forEach(element => observer?.observe(element))
    window.addEventListener('resize', updateComposerHeightBudget)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateComposerHeightBudget)
    }
  }, [updateComposerHeightBudget])

  // 自动调整 textarea 高度
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    // 只有真正空字符串时才重置高度；保留仅空格/空行时的换行高度
    if (text.length === 0) {
      textarea.style.height = `${TEXTAREA_MIN_HEIGHT}px`
      return
    }

    textarea.style.height = 'auto'
    const scrollHeight = textarea.scrollHeight
    textarea.style.height = Math.max(TEXTAREA_MIN_HEIGHT, Math.min(scrollHeight, textareaMaxHeight)) + 'px'
  }, [text, textareaMaxHeight])

  // 计算
  const inputDisabled = !!disabled
  const canSend = (text.trim().length > 0 || attachments.length > 0) && !inputDisabled
  const projectOptions = useMemo(
    () => projectOptionsInSidebarOrder(savedDirectories, currentDirectory),
    [currentDirectory, savedDirectories],
  )
  const selectedProjectName = currentDirectory
    ? projectOptions.find(directory => isSameDirectory(directory.path, currentDirectory))?.name ||
      getDirectoryName(currentDirectory) ||
      currentDirectory
    : t('emptyState.chooseProject')
  const shouldShowProjectInTitle = currentDirectory && selectedProjectName.length <= 18
  const homeTitle = shouldShowProjectInTitle
    ? t('emptyState.projectTitle', { project: selectedProjectName })
    : currentDirectory
      ? t('emptyState.projectTitleShort')
    : t('emptyState.homeTitle')

  // ============================================
  // Handlers
  // ============================================

  const resetDraft = useCallback(() => {
    latestDraftRef.current = { text: '', attachments: [] }
    setText('')
    setAttachments([])
    resetHistoryIndex()
  }, [resetHistoryIndex])

  const restoreDraft = useCallback(
    (draft: HistoryEntry) => {
      latestDraftRef.current = draft
      setText(draft.text)
      setAttachments(draft.attachments)
      resetHistoryIndex()

      requestAnimationFrame(() => {
        if (!textareaRef.current) return
        const cursorPos = draft.text.length
        textareaRef.current.focus()
        textareaRef.current.setSelectionRange(cursorPos, cursorPos)
      })
    },
    [resetHistoryIndex],
  )

  const submitCommandOptimistically = useCallback(
    (commandStr: string) => {
      if (!onCommand) return

      const draftSnapshot: HistoryEntry = {
        text,
        attachments: [...attachments],
      }

      resetDraft()
      requestAnimationFrame(() => {
        if (!textareaRef.current) return
        textareaRef.current.focus()
        textareaRef.current.setSelectionRange(0, 0)
      })

      void (async () => {
        let result: boolean | void
        try {
          result = await onCommand(commandStr)
        } catch {
          result = false
        }

        if (result !== false) {
          onClearRevert?.()
          return
        }

        const currentDraft = latestDraftRef.current
        if (currentDraft.text.length === 0 && currentDraft.attachments.length === 0) {
          restoreDraft(draftSnapshot)
        }
      })()
    },
    [attachments, onClearRevert, onCommand, resetDraft, restoreDraft, text],
  )

  const runSubmit = useCallback(
    async (submit: () => Promise<boolean | void> | boolean | void, onSuccess?: () => void, onFailure?: () => void) => {
      if (isSubmitting) return false

      setIsSubmitting(true)
      try {
        const result = await submit()
        if (result === false) {
          onFailure?.()
          return false
        }

        onSuccess?.()
        return true
      } finally {
        setIsSubmitting(false)
      }
    },
    [isSubmitting],
  )

  const handleSend = useCallback((delivery?: 'steer' | 'queue') => {
    if (!canSend || isSubmitting) return
    const blockingIssue = !sessionId ? taskPreflightIssues.find(issue => issue.level === 'error') : undefined
    if (blockingIssue) {
      notificationStore.push('error', '新建任务预检未通过', blockingIssue.message, '', currentDirectory)
      return
    }
    const normalizedDelivery = delivery === 'steer' || delivery === 'queue' ? delivery : undefined

    // 检测 command attachment
    const commandAttachment = attachments.find(a => a.type === 'command')
    if (commandAttachment && commandAttachment.commandName) {
      if (!onCommand) return

      // 提取命令后的参数文本
      const textRange = commandAttachment.textRange
      const afterCommand = textRange ? text.slice(textRange.end).trim() : ''
      const commandStr = `/${commandAttachment.commandName}${afterCommand ? ' ' + afterCommand : ''}`
      submitCommandOptimistically(commandStr)
      return
    }

    // 从 attachments 中找 agent mention
    const agentAttachment = attachments.find(a => a.type === 'agent')
    const mentionedAgent = agentAttachment?.agentName

    const initializeProject = !sessionId && currentDirectory && taskProjectProfile?.setupCommands.length && !projectEnvironmentStore.isCurrent(currentDirectory, taskProjectProfile.updatedAt, taskExecutionTarget?.serverId)
    const submittedText = initializeProject
      ? [`Before working on the task, initialize the project in the configured sandbox. Run these commands in order, stop and report if any command fails:`, '```sh', ...taskProjectProfile.setupCommands, '```', '', text].join('\n')
      : text
    void runSubmit(
      () =>
        onSend(submittedText, attachments, {
          agent: mentionedAgent || selectedAgent,
          variant: selectedVariant,
          delivery: normalizedDelivery,
        }),
      () => {
        if (initializeProject && currentDirectory && taskProjectProfile) projectEnvironmentStore.capture({ directory: currentDirectory, profileUpdatedAt: taskProjectProfile.updatedAt, serverId: taskExecutionTarget?.serverId, branch: taskExecutionTarget?.branch, dirtyFiles: 0, setupCommands: taskProjectProfile.setupCommands })
        resetDraft()
        onClearRevert?.()
      },
    )
  }, [
    attachments,
    canSend,
    isSubmitting,
    onCommand,
    onClearRevert,
    onSend,
    resetDraft,
    runSubmit,
    selectedAgent,
    selectedVariant,
    sessionId,
    submitCommandOptimistically,
    taskPreflightIssues,
    text,
    currentDirectory,
    taskProjectProfile,
    taskExecutionTarget?.serverId,
    taskExecutionTarget?.branch,
  ])

  // 更新 @ 查询文本（用于进入/退出文件夹）
  const updateMentionQuery = useCallback(
    (newQuery: string) => {
      if (!textareaRef.current) return

      const beforeAt = text.slice(0, mentionStartIndex)
      const afterQuery = text.slice(mentionStartIndex + 1 + mentionQuery.length)
      const newText = beforeAt + '@' + newQuery + afterQuery

      setText(newText)
      setMentionQuery(newQuery)

      // 移动光标到 @ 查询末尾
      requestAnimationFrame(() => {
        if (!textareaRef.current) return
        const pos = mentionStartIndex + 1 + newQuery.length
        textareaRef.current.setSelectionRange(pos, pos)
        textareaRef.current.focus()
      })
    },
    [text, mentionStartIndex, mentionQuery],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = e.nativeEvent
      const isImeComposing = isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229

      if (isImeComposing && (e.key === 'Enter' || e.key === 'Tab')) return

      // Slash Command 菜单打开时，拦截导航键
      if (slashOpen && slashMenuRef.current) {
        switch (e.key) {
          case 'ArrowUp':
            e.preventDefault()
            slashMenuRef.current.moveUp()
            return
          case 'ArrowDown':
            e.preventDefault()
            slashMenuRef.current.moveDown()
            return
          case 'Enter':
          case 'Tab':
            e.preventDefault()
            slashMenuRef.current.selectCurrent()
            return
          case 'Escape':
            e.preventDefault()
            setSlashOpen(false)
            return
        }
      }

      if (sessionReferenceOpen && sessionReferenceMenuRef.current) {
        switch (e.key) {
          case 'ArrowUp':
            e.preventDefault()
            sessionReferenceMenuRef.current.moveUp()
            return
          case 'ArrowDown':
            e.preventDefault()
            sessionReferenceMenuRef.current.moveDown()
            return
          case 'Enter':
          case 'Tab':
            e.preventDefault()
            sessionReferenceMenuRef.current.selectCurrent()
            return
          case 'Escape':
            e.preventDefault()
            setSessionReferenceOpen(false)
            return
        }
      }

      // Mention 菜单打开时，拦截导航键
      if (mentionOpen && mentionMenuRef.current) {
        switch (e.key) {
          case 'ArrowUp':
            e.preventDefault()
            mentionMenuRef.current.moveUp()
            return
          case 'ArrowDown':
            e.preventDefault()
            mentionMenuRef.current.moveDown()
            return
          case 'ArrowRight': {
            // 进入文件夹
            const selected = mentionMenuRef.current.getSelectedItem()
            if (selected?.type === 'folder') {
              e.preventDefault()
              const basePath = (selected.relativePath || selected.displayName).replace(/\/+$/, '')
              const folderPath = basePath + '/'
              updateMentionQuery(folderPath)
            }
            return
          }
          case 'ArrowLeft': {
            // 返回上一级
            if (mentionQuery.includes('/')) {
              e.preventDefault()
              const parts = mentionQuery.replace(/\/$/, '').split('/')
              // 记住当前目录名，返回后定位到它
              const folderName = parts[parts.length - 1]
              if (folderName) {
                mentionMenuRef.current.setRestoreFolder(folderName)
              }
              parts.pop()
              const parentPath = parts.length > 0 ? parts.join('/') + '/' : ''
              updateMentionQuery(parentPath)
            }
            return
          }
          case 'Enter':
          case 'Tab':
            e.preventDefault()
            mentionMenuRef.current.selectCurrent()
            return
          case 'Escape':
            e.preventDefault()
            setMentionOpen(false)
            return
        }
      }

      // Tab 键：mention 菜单关闭时，不做任何事（阻止跳到工具栏）
      if (e.key === 'Tab') {
        e.preventDefault()
        return
      }

      // 历史消息导航（类终端体验）
      const historyResult = handleHistoryKeyDown(e, text, attachments)
      if (historyResult) {
        setText(historyResult.text)
        setAttachments(historyResult.attachments)
        requestAnimationFrame(() => {
          if (!textareaRef.current) return
          const cursorPos = historyResult.cursor === 'start' ? 0 : historyResult.text.length
          textareaRef.current.focus()
          textareaRef.current.setSelectionRange(cursorPos, cursorPos)
        })
        return
      }

      // 发送消息（读取 keybinding 配置）
      if (isStreaming && e.key === 'Enter' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        handleSend(queueFollowupMessages ? 'steer' : 'queue')
        return
      }

      const isPlainEnter =
        e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
      if (isPlainEnter) {
        if (enterKeyBehavior === 'send') {
          e.preventDefault()
          handleSend()
        }
        return
      }

      const sendKey = keybindingStore.getKey('sendMessage')
      if (sendKey && !isImeComposing && matchesKeybinding(nativeEvent, sendKey)) {
        e.preventDefault()
        handleSend()
      }
    },
    [
      mentionOpen,
      slashOpen,
      sessionReferenceOpen,
      mentionQuery,
      updateMentionQuery,
      handleSend,
      text,
      attachments,
      handleHistoryKeyDown,
      isStreaming,
      queueFollowupMessages,
      enterKeyBehavior,
    ],
  )

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newText = e.target.value
      setText(newText)

      // 用户修改了内容，检查是否应退出历史模式
      handleHistoryChange(newText)

      // 同步检测 mention 是否被破坏/删除
      // 比对 attachments 的 textRange：如果文本中对应位置不再匹配，删除该 attachment
      setAttachments(prev => {
        const surviving = prev.filter(a => {
          if (!a.textRange) return true // 图片等无 textRange 的保留
          const { start, end, value } = a.textRange
          const actual = newText.slice(start, end)
          return actual === value
        })
        // 只在数量变化时更新（避免不必要的 re-render）
        return surviving.length === prev.length ? prev : surviving
      })

      // 检测 @ 触发
      const cursorPos = e.target.selectionStart || 0
      const trigger = detectMentionTrigger(newText, cursorPos, '@')

      if (trigger) {
        setMentionQuery(trigger.query)
        setMentionStartIndex(trigger.startIndex)
        setMentionOpen(true)
        setSlashOpen(false) // 关闭斜杠菜单
        setSessionReferenceOpen(false)
      } else {
        setMentionOpen(false)

        const sessionTrigger = detectMentionTrigger(newText, cursorPos, '#')
        if (sessionTrigger) {
          setSessionReferenceQuery(sessionTrigger.query)
          setSessionReferenceStartIndex(sessionTrigger.startIndex)
          setSessionReferenceOpen(true)
          setSlashOpen(false)
        } else {
          setSessionReferenceOpen(false)

          // 检测 / 触发（只在行首或空白后）
          const slashTrigger = detectSlashTrigger(newText, cursorPos)
          if (slashTrigger) {
            setSlashQuery(slashTrigger.query)
            setSlashStartIndex(slashTrigger.startIndex)
            setSlashOpen(true)
          } else {
            setSlashOpen(false)
          }
        }
      }
    },
    [handleHistoryChange],
  )

  const insertComposerTrigger = useCallback(
    (trigger: '@' | '/' | '#') => {
      const textarea = textareaRef.current
      const start = textarea?.selectionStart ?? text.length
      const end = textarea?.selectionEnd ?? start
      const needsSpace = start > 0 && !/\s/.test(text[start - 1])
      const nextText = `${text.slice(0, start)}${needsSpace ? ' ' : ''}${trigger}${text.slice(end)}`
      const triggerIndex = start + Number(needsSpace)

      setText(nextText)
      handleHistoryChange(nextText)
      if (trigger === '@') {
        setMentionQuery('')
        setMentionStartIndex(triggerIndex)
        setMentionOpen(true)
        setSlashOpen(false)
        setSessionReferenceOpen(false)
      } else if (trigger === '/') {
        setSlashQuery('')
        setSlashStartIndex(triggerIndex)
        setSlashOpen(true)
        setMentionOpen(false)
        setSessionReferenceOpen(false)
      } else {
        setSessionReferenceQuery('')
        setSessionReferenceStartIndex(triggerIndex)
        setSessionReferenceOpen(true)
        setMentionOpen(false)
        setSlashOpen(false)
      }

      requestAnimationFrame(() => {
        textarea?.focus()
        textarea?.setSelectionRange(triggerIndex + 1, triggerIndex + 1)
      })
    },
    [handleHistoryChange, text],
  )

  const handleCompositionStart = useCallback(() => {
    if (compositionEndTimerRef.current !== null) {
      clearTimeout(compositionEndTimerRef.current)
      compositionEndTimerRef.current = null
    }
    isComposingRef.current = true
  }, [])

  const handleCompositionEnd = useCallback(() => {
    if (compositionEndTimerRef.current !== null) {
      clearTimeout(compositionEndTimerRef.current)
    }

    compositionEndTimerRef.current = window.setTimeout(() => {
      isComposingRef.current = false
      compositionEndTimerRef.current = null
    }, 0)
  }, [])

  // @ Mention 选择处理
  const handleMentionSelect = useCallback(
    (item: MentionItem & { _enterFolder?: boolean }) => {
      if (!textareaRef.current) return

      // 如果是进入文件夹
      if (item._enterFolder && item.type === 'folder') {
        const basePath = (item.relativePath || item.displayName).replace(/\/+$/, '')
        const folderPath = basePath + '/'
        updateMentionQuery(folderPath)
        return
      }

      // 构建 @ 文本
      const mentionText = item.type === 'agent' ? `@${item.displayName}` : `@${item.relativePath || item.displayName}`

      // 计算新文本
      const beforeAt = text.slice(0, mentionStartIndex)
      const afterQuery = text.slice(mentionStartIndex + 1 + mentionQuery.length)
      const newText = beforeAt + mentionText + ' ' + afterQuery

      // 创建附件
      const attachment: Attachment = {
        id: crypto.randomUUID(),
        type: item.type,
        displayName: item.displayName,
        relativePath: item.relativePath,
        url: item.type !== 'agent' ? item.value : undefined,
        mime: item.type !== 'agent' ? 'text/plain' : undefined,
        agentName: item.type === 'agent' ? item.displayName : undefined,
        textRange: {
          value: mentionText,
          start: mentionStartIndex,
          end: mentionStartIndex + mentionText.length,
        },
      }

      setText(newText)
      setAttachments(prev => [...prev, attachment])
      setMentionOpen(false)

      // 移动光标到 mention 后
      requestAnimationFrame(() => {
        if (!textareaRef.current) return
        const newCursorPos = mentionStartIndex + mentionText.length + 1
        textareaRef.current.setSelectionRange(newCursorPos, newCursorPos)
        textareaRef.current.focus()
      })
    },
    [text, mentionStartIndex, mentionQuery, updateMentionQuery],
  )

  const handleMentionClose = useCallback(() => {
    setMentionOpen(false)
    textareaRef.current?.focus()
  }, [])

  // / Slash Command 选择处理 - 类似 @ mention
  const handleSlashSelect = useCallback(
    (command: Command) => {
      if (command.source === 'frontend') {
        if (!onCommand) return

        setSlashOpen(false)
        submitCommandOptimistically(`/${command.name}`)
        requestAnimationFrame(() => textareaRef.current?.focus())
        return
      }

      if (!textareaRef.current) return

      // 构建 /command 文本
      const commandText = `/${command.name}`

      // 计算新文本：替换 /query 为 /command
      const beforeSlash = text.slice(0, slashStartIndex)
      const afterQuery = text.slice(slashStartIndex + 1 + slashQuery.length)
      const newText = beforeSlash + commandText + ' ' + afterQuery

      // 创建 command attachment
      const attachment: Attachment = {
        id: crypto.randomUUID(),
        type: 'command',
        displayName: command.name,
        commandName: command.name,
        textRange: {
          value: commandText,
          start: slashStartIndex,
          end: slashStartIndex + commandText.length,
        },
      }

      setText(newText)
      setAttachments(prev => [...prev, attachment])
      setSlashOpen(false)

      // 移动光标到命令后
      requestAnimationFrame(() => {
        if (!textareaRef.current) return
        const newCursorPos = slashStartIndex + commandText.length + 1
        textareaRef.current.setSelectionRange(newCursorPos, newCursorPos)
        textareaRef.current.focus()
      })
    },
    [text, slashStartIndex, slashQuery, onCommand, submitCommandOptimistically],
  )

  const handleSlashClose = useCallback(() => {
    setSlashOpen(false)
    textareaRef.current?.focus()
  }, [])

  const handleSessionReferenceSelect = useCallback(
    (session: ApiSession) => {
      if (!textareaRef.current) return
      const referenceText = `#${session.title || t('sessionSearch.untitled')}`
      const beforeTrigger = text.slice(0, sessionReferenceStartIndex)
      const afterQuery = text.slice(sessionReferenceStartIndex + 1 + sessionReferenceQuery.length)
      const newText = beforeTrigger + referenceText + ' ' + afterQuery

      setText(newText)
      setAttachments(current => [
        ...current,
        {
          id: crypto.randomUUID(),
          type: 'session',
          displayName: session.title || t('sessionSearch.untitled'),
          sessionId: session.id,
          sessionDirectory: session.directory,
          textRange: {
            value: referenceText,
            start: sessionReferenceStartIndex,
            end: sessionReferenceStartIndex + referenceText.length,
          },
        },
      ])
      setSessionReferenceOpen(false)

      requestAnimationFrame(() => {
        const cursor = sessionReferenceStartIndex + referenceText.length + 1
        textareaRef.current?.setSelectionRange(cursor, cursor)
        textareaRef.current?.focus()
      })
    },
    [sessionReferenceQuery, sessionReferenceStartIndex, t, text],
  )

  const handleSessionReferenceClose = useCallback(() => {
    setSessionReferenceOpen(false)
    textareaRef.current?.focus()
  }, [])

  // 通用文件上传 — 根据模型能力判断是否接受
  const handleFilesSelected = useCallback(
    async (files: File[]) => {
      if (files.length === 0 || !supportsAnyFile || isSubmitting) return

      const nextAttachments: Attachment[] = []
      const unsupportedFiles: string[] = []
      const unreadableFiles: string[] = []
      const duplicateFiles: string[] = []

      for (const rawFile of files) {
        const file = ensureFileMime(rawFile)

        // 按 MIME 类型检查模型能力
        if (!isFileSupported(file.type, fileCaps)) {
          unsupportedFiles.push(file.name)
          continue
        }

        try {
          const dataUrl = await readFileAsDataUrl(file)

          nextAttachments.push({
            id: crypto.randomUUID(),
            type: 'file',
            displayName: file.name,
            url: dataUrl,
            mime: file.type,
          })
        } catch (err) {
          console.warn('[InputBox] Failed to process file:', err)
          unreadableFiles.push(file.name)
        }
      }

      const deduped: Attachment[] = []
      const seen = [...attachments]
      for (const candidate of nextAttachments) {
        if (isDuplicateAttachment(seen, candidate)) {
          duplicateFiles.push(candidate.displayName)
          continue
        }
        deduped.push(candidate)
        seen.push(candidate)
      }

      if (deduped.length > 0) {
        setAttachments(prev => [...prev, ...deduped])
      }
      if (unsupportedFiles.length > 0) {
        notificationStore.push(
          'error',
          t('inputBox.unsupportedFilesTitle'),
          t('inputBox.unsupportedFilesDescription', { files: unsupportedFiles.join(', ') }),
          sessionId ?? '',
          currentDirectory,
        )
      }
      if (unreadableFiles.length > 0) {
        notificationStore.push(
          'error',
          t('inputBox.fileReadFailedTitle'),
          t('inputBox.fileReadFailedDescription', { files: unreadableFiles.join(', ') }),
          sessionId ?? '',
          currentDirectory,
        )
      }
      if (duplicateFiles.length > 0) {
        notificationStore.push(
          'error',
          t('inputBox.attachmentDuplicateTitle'),
          t('inputBox.attachmentDuplicateDescription', { files: duplicateFiles.join(', ') }),
          sessionId ?? '',
          currentDirectory,
        )
      }
    },
    [attachments, currentDirectory, fileCaps, isSubmitting, sessionId, supportsAnyFile, t],
  )

  // 删除附件
  const handleRemoveAttachment = useCallback(
    (id: string) => {
      if (isSubmitting) return

      const attachment = attachments.find(a => a.id === id)
      if (!attachment) return

      // 如果有 textRange，从文本中删除 @mention
      if (attachment.textRange) {
        const { value } = attachment.textRange
        // 删除 @mention 和后面的空格
        const newText = text.replace(value + ' ', '').replace(value, '')
        setText(newText)
      }

      setAttachments(prev => prev.filter(a => a.id !== id))
    },
    [attachments, isSubmitting, text],
  )

  // 粘贴处理 — 根据模型能力过滤可粘贴的文件类型
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (supportsAnyFile) {
        const items = e.clipboardData?.items
        const files: File[] = []

        if (items) {
          for (let i = 0; i < items.length; i++) {
            if (items[i].kind === 'file') {
              const file = items[i].getAsFile()
              if (file && isFileSupported(ensureFileMime(file).type, fileCaps)) files.push(file)
            }
          }
        }

        if (files.length > 0) {
          e.preventDefault()
          void handleFilesSelected(files)
          return
        }
      }

      // 文本粘贴：让 textarea 默认处理（天然支持换行和 undo）
    },
    [supportsAnyFile, fileCaps, handleFilesSelected],
  )

  // 拖拽文件到输入框
  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounterRef.current++
      if (supportsAnyFile && e.dataTransfer.types.includes('Files')) {
        setIsDragging(true)
      }
    },
    [supportsAnyFile],
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setIsDragging(false)
    }
  }, [])

  // 将拖入的文件信息插入为 @mention 附件
  const insertDraggedFiles = useCallback(
    (fileInfos: DraggedFileInfo[]) => {
      if (fileInfos.length === 0) return

      const currentText = textareaRef.current?.value ?? text
      const cursorPos = textareaRef.current?.selectionStart ?? currentText.length
      const beforeCursor = currentText.slice(0, cursorPos)
      const afterCursor = currentText.slice(cursorPos)
      const needSpaceBefore = beforeCursor.length > 0 && !beforeCursor.endsWith(' ') && !beforeCursor.endsWith('\n')
      const prefix = needSpaceBefore ? ' ' : ''
      const mentions = fileInfos.map(fileInfo => {
        const relativePath = normalizePath(fileInfo.path)
        return {
          fileInfo,
          relativePath,
          mentionText: `@${relativePath}`,
        }
      })
      const insertedText = `${prefix}${mentions.map(item => item.mentionText).join(' ')} `
      const newText = beforeCursor + insertedText + afterCursor
      let mentionStart = cursorPos + prefix.length

      const nextAttachments: Attachment[] = mentions.map(({ fileInfo, relativePath, mentionText }) => {
        const start = mentionStart
        mentionStart += mentionText.length + 1

        return {
          id: crypto.randomUUID(),
          type: fileInfo.type,
          displayName: fileInfo.name,
          relativePath,
          url: toFileUrl(fileInfo.absolute),
          mime: fileInfo.type === 'file' ? 'text/plain' : undefined,
          textRange: {
            value: mentionText,
            start,
            end: start + mentionText.length,
          },
        }
      })

      setText(newText)
      setAttachments(prev => [...prev, ...nextAttachments])

      requestAnimationFrame(() => {
        if (!textareaRef.current) return
        const newCursorPos = cursorPos + insertedText.length
        textareaRef.current.setSelectionRange(newCursorPos, newCursorPos)
        textareaRef.current.focus()
      })
    },
    [text],
  )

  const insertDraggedFile = useCallback((fileInfo: DraggedFileInfo) => insertDraggedFiles([fileInfo]), [insertDraggedFiles])

  useEffect(() => {
    const updateInternalFileDragState = () => {
      const active = getInternalDragSnapshot().active
      if (!active || active.payload.kind !== 'file-mention') {
        setIsInternalFileDragging(false)
        return
      }
      setIsInternalFileDragging(isInternalPointInsideElement(active.current, inputContainerRef.current))
    }

    updateInternalFileDragState()
    return subscribeInternalDrag(updateInternalFileDragState)
  }, [])

  useEffect(() => {
    return subscribeInternalDrop(event => {
      if (event.payload.kind !== 'file-mention') return
      if (!isInternalPointInsideElement(event.point, inputContainerRef.current)) return
      insertDraggedFile(event.payload.file)
    })
  }, [insertDraggedFile])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounterRef.current = 0
      setIsDragging(false)

      // 原生文件拖拽（从操作系统拖入）
      if (e.dataTransfer.files.length > 0) {
        void handleFilesSelected(Array.from(e.dataTransfer.files))
      }
    },
    [handleFilesSelected],
  )

  // 滚动同步（备用，overlay 内部也监听了 scroll）
  const handleScroll = useCallback(() => {
    // overlay 通过 useEffect 自动同步，这里留空
  }, [])

  // ============================================
  // Render
  // ============================================

  // 计算已选择的 items (用于过滤菜单)
  const excludeValues = new Set<string>()
  const excludedSessionIds = new Set<string>()
  attachments.forEach(a => {
    if (a.url) excludeValues.add(a.url)
    if (a.agentName) excludeValues.add(a.agentName)
    if (a.sessionId) excludedSessionIds.add(a.sessionId)
  })
  if (sessionId) excludedSessionIds.add(sessionId)

  // 底部 padding 计算：
  // - isCollapsed (收起态 / 移动端「回复胶囊」)：
  //   公式 max(12, env)。Safari env()=0 → 12px breathing；PWA env()=34 → 34px，
  //   胶囊底部刚好贴 safe-area 顶部，避免 env+12 叠加出现的「多一截」间距。
  // - 展开态：Footer (h-8 = 2rem) 已是一个天然的视觉缓冲，只需补足 safe-area
  //   超出 Footer 的部分。这避免 PWA 下 Footer + 完整 safe-area 叠加出现
  //   「双倍 safe-area」的视觉 gap。
  //   公式：max(0, env - 2rem) → 总缓冲 = Footer + padding = max(32px, env)
  const bottomDockPadding = isCollapsed
    ? 'max(12px, var(--safe-area-inset-bottom, 0px))'
    : 'max(14px, var(--safe-area-inset-bottom, 0px))'

  return (
    <div className="w-full">
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {isStreaming ? t('inputBox.sending') : ''}
      </span>
      <div
        className={`mx-auto pointer-events-auto transition-[max-width] duration-300 ease-in-out ${homeMode ? 'max-w-[min(92%,52rem)]' : 'max-w-[min(92%,68rem)]'} ${isCompact ? 'px-4' : 'px-4 lg:px-6'}`}
        style={{ paddingBottom: homeMode ? undefined : bottomDockPadding }}
      >
        {homeMode && (
          <div className={`flex items-center justify-center gap-3 ${isCompact ? 'mb-5' : 'mb-6'}`}>
            <span
              aria-hidden="true"
              className="size-8 shrink-0 bg-text-100"
              style={{
                maskImage: `url(${trayIcon})`,
                WebkitMaskImage: `url(${trayIcon})`,
                maskSize: 'contain',
                WebkitMaskSize: 'contain',
                maskRepeat: 'no-repeat',
                WebkitMaskRepeat: 'no-repeat',
                maskPosition: 'center',
                WebkitMaskPosition: 'center',
              }}
            />
            <h1 className="min-w-0 truncate text-[1.6rem] font-normal leading-tight text-text-100 md:text-[1.9rem]">
              {homeTitle}
            </h1>
            <span className="shrink-0 rounded-full border border-border-200/60 px-2 py-0.5 font-mono text-[length:var(--fs-xxs)] text-text-400">
              v{__APP_VERSION__}
            </span>
          </div>
        )}
        <div
          ref={contentWrapRef}
          onPointerDown={handleContainerPointerDown}
          className={`relative flex flex-col gap-2 ${isCollapsed ? 'justify-end' : ''}`}
          style={
            isCollapsed && expandedHeight > 0
              ? { minHeight: expandedHeight, maxHeight: composerMaxHeight }
              : { maxHeight: composerMaxHeight }
          }
        >
          {/* FloatingActions — 
              展开态：absolute 定位在内容区上方，不占文档流，避免显隐变化影响高度导致滚动抖动
              收起态：正常文档流，紧贴胶囊上方
              始终同一 DOM 节点，切换时 FloatingActions 不 remount，避免入场动画闪烁 */}
          <div
            data-floating-actions
            className={
              isCollapsed
                ? 'flex justify-center pb-2'
                : 'absolute bottom-full left-0 right-0 flex justify-center pb-2 pointer-events-none'
            }
          >
            <div className="w-full">
              <FloatingActions
                showScrollToBottom={showScrollToBottom}
                isCollapsed={isCollapsed}
                canRedo={canRedo}
                revertSteps={revertSteps}
                onRedo={onRedo}
                onRedoAll={onRedoAll}
                onScrollToBottom={onScrollToBottom}
                collapsedPermission={collapsedPermission}
                collapsedQuestion={collapsedQuestion}
              />
            </div>
          </div>

          {/* Collapsed Capsule - 移动端收起状态 */}
          {isCollapsed && (
            <CollapsedCapsule
              onExpand={handleExpandInput}
              showScrollToBottom={showScrollToBottom}
              onScrollToBottom={onScrollToBottom}
            />
          )}

          {/* Wrapper — 菜单在 glass 容器外，避免嵌套 backdrop-filter 导致模糊失效。
              收起态只做视觉隐藏，不能卸载输入区，否则移动端虚拟键盘会随焦点元素销毁而关闭。 */}
          <div
            className={`z-30 transition-[opacity,transform] duration-200 ease-out ${
              isCollapsed
                ? 'pointer-events-none absolute inset-x-0 bottom-0 opacity-0 scale-95'
                : 'relative opacity-100 scale-100'
            }`}
          >
            {/* @ Mention Menu */}
            <MentionMenu
              ref={mentionMenuRef}
              isOpen={mentionOpen}
              query={mentionQuery}
              agents={agents}
              rootPath={rootPath}
              excludeValues={excludeValues}
              onSelect={handleMentionSelect}
              onNavigate={updateMentionQuery}
              onClose={handleMentionClose}
            />

            {/* / Slash Command Menu */}
            <SlashCommandMenu
              ref={slashMenuRef}
              isOpen={slashOpen}
              query={slashQuery}
              rootPath={rootPath}
              onSelect={handleSlashSelect}
              onClose={handleSlashClose}
            />

            <SessionReferenceMenu
              ref={sessionReferenceMenuRef}
              isOpen={sessionReferenceOpen}
              query={sessionReferenceQuery}
              sessions={sessions}
              excludeIds={excludedSessionIds}
              onSelect={handleSessionReferenceSelect}
              onClose={handleSessionReferenceClose}
            />

            <GoalStatusBar sessionId={sessionId} rootPath={rootPath} isStreaming={isStreaming} />

            {sessionId && queuedFollowups.length > 0 && (
              <FollowupQueue
                items={queuedFollowups}
                sendingId={queuedFollowupSendingId}
                isStreaming={isStreaming}
                onRemove={onQueuedFollowupRemove}
                onUpdate={onQueuedFollowupUpdate}
                onMove={onQueuedFollowupMove}
                onSteer={onQueuedFollowupSteer}
              />
            )}

            {!sessionId && <NewTaskContextBar paneId={paneId} onApplyProfile={applyProjectProfile} onPreflight={updateTaskPreflight} />}

            {/* Input Container */}
            <div
              ref={inputContainerRef}
              data-input-box
              aria-busy={isStreaming}
              data-pane-id={paneId}
              onPointerDown={handleContainerPointerDown}
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`${homeMode ? 'glass-alt' : 'glass'} rounded-2xl relative z-10 flex flex-col overflow-hidden focus-within:outline-none shadow-xl ${!sessionId ? 'min-h-[112px]' : ''} ${
                isDragging || isInternalFileDragging
                  ? 'border border-accent-main-100 ring-2 ring-accent-main-100/30'
                  : isStreaming
                    ? 'border border-accent-main-100/50 animate-border-pulse'
                    : 'border border-border-200/60'
              }`}
              style={{ maxHeight: inputContainerMaxHeight }}
            >
              {/* Drop overlay */}
              {(isDragging || isInternalFileDragging) && (
                <div className="absolute inset-0 z-50 rounded-2xl bg-accent-main-100/5 backdrop-blur-[1px] flex items-center justify-center pointer-events-none">
                  <span className="text-[length:var(--fs-base)] text-accent-main-100 font-medium">{t('inputBox.dropFilesHere')}</span>
                </div>
              )}

              <div className="relative flex min-h-0 flex-1 flex-col">
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  {/* Attachments Preview - 显示在输入框上方 */}
                  <div
                    ref={attachmentSectionRef}
                    className={`grid shrink-0 transition-[grid-template-rows,opacity] duration-300 ease-out ${
                      attachments.length > 0 ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                    }`}
                  >
                    <div className="overflow-hidden">
                      <div className="px-4 pt-3 pb-1">
                        <div className="relative">
                          <div
                            ref={attachmentRailRef}
                            onScroll={syncAttachmentRailState}
                            onWheel={handleAttachmentRailWheel}
                            className="overflow-x-auto overflow-y-hidden overscroll-x-contain no-scrollbar touch-pan-x"
                            style={{ WebkitOverflowScrolling: 'touch' }}
                          >
                            <AttachmentPreview
                              attachments={attachments}
                              onRemove={handleRemoveAttachment}
                              variant="rail"
                              className={isSubmitting ? 'pr-4 pointer-events-none opacity-70' : 'pr-4'}
                            />
                          </div>

                          {attachmentsOverflowing && showAttachmentLeftFade && (
                            <div className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-bg-000/50 to-transparent" />
                          )}

                          {attachmentsOverflowing && showAttachmentRightFade && (
                            <div className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-bg-000/50 to-transparent" />
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Text Input - 简单的 textarea，直接显示文本 */}
                  <div className="min-h-0 flex-1 overflow-hidden pt-4 pb-2">
                    <textarea
                      ref={textareaRef}
                      data-composer-input
                      value={text}
                      onChange={handleChange}
                      onKeyDown={handleKeyDown}
                      onCompositionStart={handleCompositionStart}
                      onCompositionEnd={handleCompositionEnd}
                      onPaste={handlePaste}
                      onScroll={handleScroll}
                      onFocus={handleFocus}
                      onBlur={handleBlur}
                      disabled={inputDisabled}
                      placeholder={homeMode ? t('emptyState.promptPlaceholder') : isCompact ? t('inputBox.replyToAgentMobile') : t('inputBox.replyToAgent')}
                      className={`block w-full resize-none border-0 bg-transparent text-text-100 shadow-none outline-none ring-0 placeholder:text-text-400 focus:border-0 focus:outline-none focus:ring-0 focus:shadow-none custom-scrollbar ${isCompact ? 'px-3' : 'px-4'}`}
                      style={{
                        ...TEXT_STYLE,
                        minHeight: '24px',
                        maxHeight: textareaMaxHeight,
                      }}
                      rows={1}
                    />
                  </div>

                  {/* Bottom Bar -> InputToolbar */}
                  <div ref={toolbarRef} className="relative z-10 shrink-0">
                    <InputToolbar
                      paneId={paneId}
                      agents={agents}
                      selectedAgent={selectedAgent}
                      onAgentChange={onAgentChange}
                      variants={variants}
                      selectedVariant={selectedVariant}
                      onVariantChange={onVariantChange}
                      fileCapabilities={fileCaps}
                      onFilesSelected={handleFilesSelected}
                      onAddReference={() => insertComposerTrigger('@')}
                      onAddCommand={() => insertComposerTrigger('/')}
                      isStreaming={isStreaming}
                      isSending={isSubmitting}
                      onAbort={onAbort}
                      canSend={canSend || false}
                      onSend={handleSend}
                      models={models}
                      selectedModelKey={selectedModelKey}
                      onModelChange={onModelChange}
                      modelsLoading={modelsLoading}
                      inputContainerRef={inputContainerRef}
                      modelSelectorRef={modelSelectorRef}
                      contextStats={contextStats}
                      hasMessages={hasMessages}
                      voiceSupported={voiceSupported}
                      voiceListening={voiceListening}
                      voiceTranscribing={voiceTranscribing}
                      onVoiceToggle={toggleVoice}
                      iconOnly={toolbarWidth > 0 && toolbarWidth < 480}
                    />
                  </div>
                </div>
              </div>
            </div>

          </div>
        </div>

        <div ref={footerRef} className="hidden" />
      </div>
    </div>
  )
}

// ============================================
// Export with memo for performance optimization
// ============================================

export const InputBox = memo(InputBoxComponent)
