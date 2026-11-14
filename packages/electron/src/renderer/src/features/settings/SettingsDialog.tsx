import { lazy, Suspense, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  SunIcon,
  GlobeIcon,
  AgentIcon,
  CpuIcon,
  KeyboardIcon,
  ChevronLeftIcon,
  BellIcon,
  KeyIcon,
  PlugIcon,
  MessageSquareIcon,
  LayersIcon,
  QuestionIcon,
  CogIcon,
  ArchiveIcon,
  ShieldIcon,
  GitBranchIcon,
  MicrophoneIcon,
  FileIcon,
  DownloadIcon,
  GaugeIcon,
} from '../../components/Icons'
import { useIsMobile } from '../../hooks'
import { useChatViewport } from '../chat/chatViewport'
import { SettingsSearch } from './SettingsSearch'
import { SETTINGS_SEARCH_DEFINITIONS, type SettingsSearchItem } from './settingsSearchCatalog'
import { setSettingsTab, useSettingsTab } from '../../store/settingsStore'
const KeybindingsSection = lazy(() => import('./KeybindingsSection').then(module => ({ default: module.KeybindingsSection })))
const AgentSettings = lazy(() => import('./components/AgentSettings').then(module => ({ default: module.AgentSettings })))
const AppearanceSettings = lazy(() => import('./components/AppearanceSettings').then(module => ({ default: module.AppearanceSettings })))
const AboutSettings = lazy(() => import('./components/AboutSettings').then(module => ({ default: module.AboutSettings })))
const LogsSettings = lazy(() => import('./components/LogsSettings').then(module => ({ default: module.LogsSettings })))
const BackupSettings = lazy(() => import('./components/BackupSettings').then(module => ({ default: module.BackupSettings })))
const ChatSettings = lazy(() => import('./components/ChatSettings').then(module => ({ default: module.ChatSettings })))
const ModelsSettings = lazy(() => import('./components/ModelsSettings').then(module => ({ default: module.ModelsSettings })))
const NotificationSettings = lazy(() => import('./components/NotificationSettings').then(module => ({ default: module.NotificationSettings })))
const ProviderSettings = lazy(() => import('./components/ProviderSettings').then(module => ({ default: module.ProviderSettings })))
const ServersSettings = lazy(() => import('./components/ServersSettings').then(module => ({ default: module.ServersSettings })))
const HostingSettings = lazy(() => import('./components/HostingSettings').then(module => ({ default: module.HostingSettings })))
const WorkspaceSettings = lazy(() => import('./components/WorkspaceSettings').then(module => ({ default: module.WorkspaceSettings })))
const ConfigSettings = lazy(() => import('./components/ConfigSettings').then(module => ({ default: module.ConfigSettings })))
const ArchivedSessionsSettings = lazy(() => import('./components/ArchivedSessionsSettings').then(module => ({ default: module.ArchivedSessionsSettings })))
const SecuritySettings = lazy(() => import('./components/SecuritySettings').then(module => ({ default: module.SecuritySettings })))
const MemorySettings = lazy(() => import('./components/MemorySettings').then(module => ({ default: module.MemorySettings })))
const HooksSettings = lazy(() => import('./components/HooksSettings').then(module => ({ default: module.HooksSettings })))
const GeneralSettings = lazy(() => import('./components/GeneralSettings').then(module => ({ default: module.GeneralSettings })))
const QuotaSettings = lazy(() => import('./components/QuotaSettings').then(module => ({ default: module.QuotaSettings })))
const SpeechModelSettings = lazy(() => import('./components/SpeechModelSettings').then(module => ({ default: module.SpeechModelSettings })))

// ============================================
// Types
// ============================================

export type SettingsTab =
  | 'general'
  | 'quota'
  | 'agent'
  | 'appearance'
  | 'chat'
  | 'models'
  | 'speechModel'
  | 'providers'
  | 'notifications'
  | 'config'
  | 'servers'
  | 'hosting'
  | 'keybindings'
  | 'workspace'
  | 'archived'
  | 'security'
  | 'memory'
  | 'hooks'
  | 'logs'
  | 'backup'
  | 'about'

// ============================================
// Nav Tabs
// ============================================

const TAB_ICONS: Record<SettingsTab, React.ReactNode> = {
  general: <CogIcon size={15} />,
  quota: <GaugeIcon size={15} />,
  servers: <GlobeIcon size={15} />,
  hosting: <GitBranchIcon size={15} />,
  agent: <AgentIcon size={15} />,
  chat: <MessageSquareIcon size={15} />,
  models: <CpuIcon size={15} />,
  speechModel: <MicrophoneIcon size={15} />,
  providers: <KeyIcon size={15} />,
  appearance: <SunIcon size={15} />,
  workspace: <LayersIcon size={15} />,
  notifications: <BellIcon size={15} />,
  config: <CogIcon size={15} />,
  keybindings: <KeyboardIcon size={15} />,
  about: <QuestionIcon size={15} />,
  archived: <ArchiveIcon size={15} />,
  security: <ShieldIcon size={15} />,
  memory: <AgentIcon size={15} />,
  hooks: <PlugIcon size={15} />,
  logs: <FileIcon size={15} />,
  backup: <DownloadIcon size={15} />,
}

const TAB_IDS: SettingsTab[] = [
  'appearance',
  'general',
  'quota',
  'notifications',
  'servers',
  'providers',
  'models',
  'speechModel',
  'agent',
  'chat',
  'workspace',
  'memory',
  'hosting',
  'hooks',
  'security',
  'logs',
  'backup',
  'config',
  'archived',
  'keybindings',
  'about',
]

const TAB_LABEL_KEYS: Record<SettingsTab, string> = {
  general: 'tabs.general',
  quota: 'tabs.quota',
  servers: 'tabs.servers',
  hosting: 'tabs.hosting',
  agent: 'tabs.agent',
  chat: 'tabs.chat',
  models: 'tabs.models',
  speechModel: 'tabs.speechModel',
  providers: 'tabs.providers',
  appearance: 'tabs.appearance',
  workspace: 'tabs.workspace',
  notifications: 'tabs.notifications',
  config: 'tabs.config',
  keybindings: 'tabs.shortcuts',
  about: 'tabs.about',
  archived: 'tabs.archived',
  security: 'tabs.security',
  memory: 'tabs.memory',
  hooks: 'tabs.hooks',
  logs: 'tabs.logs',
  backup: 'tabs.backup',
}

const TAB_DESC_KEYS: Record<SettingsTab, string> = {
  general: 'tabs.generalDesc',
  quota: 'tabs.quotaDesc',
  servers: 'tabs.serversDesc',
  hosting: 'tabs.hostingDesc',
  agent: 'tabs.agentDesc',
  chat: 'tabs.chatDesc',
  models: 'tabs.modelsDesc',
  speechModel: 'tabs.speechModelDesc',
  providers: 'tabs.providersDesc',
  appearance: 'tabs.appearanceDesc',
  workspace: 'tabs.workspaceDesc',
  notifications: 'tabs.notificationsDesc',
  config: 'tabs.configDesc',
  keybindings: 'tabs.shortcutsDesc',
  about: 'tabs.aboutDesc',
  archived: 'tabs.archivedDesc',
  security: 'tabs.securityDesc',
  memory: 'tabs.memoryDesc',
  hooks: 'tabs.hooksDesc',
  logs: 'tabs.logsDesc',
  backup: 'tabs.backupDesc',
}

const GROUP_DEFS: { labelKey?: string; tabs: SettingsTab[] }[] = [
  { labelKey: 'groups.general', tabs: ['appearance', 'general', 'quota', 'notifications'] },
  { labelKey: 'groups.basic', tabs: ['servers', 'providers', 'models', 'speechModel'] },
  { labelKey: 'groups.agent', tabs: ['agent', 'chat', 'workspace', 'memory'] },
  { labelKey: 'groups.advanced', tabs: ['hosting', 'hooks'] },
  { labelKey: 'groups.security', tabs: ['security', 'logs', 'backup', 'config'] },
  { labelKey: 'groups.archived', tabs: ['archived'] },
  { labelKey: 'groups.help', tabs: ['keybindings', 'about'] },
]

// ============================================
// Tab Content Router
// ============================================

function TabContent({ tab }: { tab: SettingsTab }) {
  const { t } = useTranslation(['common'])
  const content = (() => {
    switch (tab) {
    case 'general':
      return <GeneralSettings />
    case 'quota':
      return <QuotaSettings />
    case 'agent':
      return <AgentSettings />
    case 'appearance':
      return <AppearanceSettings />
    case 'chat':
      return <ChatSettings />
    case 'models':
      return <ModelsSettings />
    case 'speechModel':
      return <SpeechModelSettings />
    case 'providers':
      return <ProviderSettings />
    case 'notifications':
      return <NotificationSettings />
    case 'config':
      return <ConfigSettings />
    case 'servers':
      return <ServersSettings />
    case 'hosting':
      return <HostingSettings />
    case 'keybindings':
      return <KeybindingsSection />
    case 'workspace':
      return <WorkspaceSettings />
    case 'archived':
      return <ArchivedSessionsSettings />
    case 'security':
      return <SecuritySettings />
    case 'memory':
      return <MemorySettings />
    case 'hooks':
      return <HooksSettings />
    case 'logs':
      return <LogsSettings />
    case 'backup':
      return <BackupSettings />
    case 'about':
      return <AboutSettings />
    default:
      return null
    }
  })()
  return <Suspense fallback={<div className="flex min-h-48 items-center justify-center text-[length:var(--fs-sm)] text-text-400">{t('common:loading')}</div>}>{content}</Suspense>
}

// ============================================
// Settings Page (replaces the legacy dialog)
// ============================================

export function SettingsPage({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation(['settings'])
  const isMobile = useIsMobile()
  const { layout } = useChatViewport()
  const tab = useSettingsTab()
  const scrollRef = useRef<HTMLDivElement>(null)
  const highlightFrameRef = useRef<number | null>(null)
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const visibleTabs = useMemo(
    () =>
      TAB_IDS.map(id => ({
        id,
        label: t(TAB_LABEL_KEYS[id]),
        description: t(TAB_DESC_KEYS[id]),
        icon: TAB_ICONS[id],
      })),
    [t],
  )

  const groupedTabs = useMemo(
    () =>
      GROUP_DEFS.map(group => ({
        label: group.labelKey ? t(group.labelKey) : '',
        tabs: group.tabs
          .map(id => visibleTabs.find(vt => vt.id === id))
          .filter((vt): vt is (typeof visibleTabs)[number] => !!vt),
      })).filter(group => group.tabs.length > 0),
    [visibleTabs, t],
  )

  const searchItems = useMemo<SettingsSearchItem[]>(() => {
    const tabsById = new Map(visibleTabs.map(visibleTab => [visibleTab.id, visibleTab]))
    return SETTINGS_SEARCH_DEFINITIONS.flatMap(definition => {
      const visibleTab = tabsById.get(definition.tab)
      if (!visibleTab) return []
      return [{
        id: `${definition.tab}:${definition.labelKey}:${definition.contextKey ?? ''}`,
        tab: definition.tab,
        label: t(definition.labelKey),
        tabLabel: definition.contextKey ? `${visibleTab.label} · ${t(definition.contextKey)}` : visibleTab.label,
        description: visibleTab.description,
        targetLabel: t(definition.targetKey ?? definition.labelKey),
        fallbackLabel: definition.fallbackKey ? t(definition.fallbackKey) : undefined,
        targetContext: definition.contextKey ? t(definition.contextKey) : undefined,
      }]
    })
  }, [t, visibleTabs])

  useEffect(() => {
    if (visibleTabs.some(t => t.id === tab)) return

    setSettingsTab(visibleTabs[0]?.id || 'appearance')
  }, [tab, visibleTabs])

  // Esc 返回工作区；有更上层弹窗打开时让位给弹窗自身处理
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const topDialog = document.querySelector('[role="dialog"][aria-modal="true"][data-dialog-open="true"]')
      if (topDialog) return
      onBack()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onBack])

  useEffect(
    () => () => {
      if (highlightFrameRef.current !== null) cancelAnimationFrame(highlightFrameRef.current)
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    },
    [],
  )

  // 切换 tab 时重置滚动位置
  const switchTab = useCallback((nextTab: SettingsTab) => {
    setSettingsTab(nextTab)
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: 0 })
    })
  }, [])

  const selectSearchItem = useCallback((item: SettingsSearchItem) => {
    switchTab(item.tab)
    if (highlightFrameRef.current !== null) cancelAnimationFrame(highlightFrameRef.current)
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)

    const locate = (remaining: number) => {
      const candidates = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>('[data-setting-label]') ?? [])
      const matching = candidates.filter(candidate =>
        candidate.dataset.settingLabel === item.targetLabel &&
        (!item.targetContext || candidate.dataset.settingContext === item.targetContext),
      )
      const target = matching[0] ?? candidates.find(candidate => candidate.dataset.settingLabel === item.fallbackLabel)
      if (!target && remaining > 0) {
        highlightFrameRef.current = requestAnimationFrame(() => locate(remaining - 1))
        return
      }
      highlightFrameRef.current = null
      if (!target) return
      scrollRef.current?.querySelector('.settings-search-highlight')?.classList.remove('settings-search-highlight')
      target.scrollIntoView({ block: 'center', behavior: 'smooth' })
      target.classList.add('settings-search-highlight')
      const focusTarget = Array.from(target.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled):not([type="hidden"]):not([tabindex="-1"]), select:not(:disabled):not([tabindex="-1"]), textarea:not(:disabled):not([tabindex="-1"])')).find(candidate => !candidate.closest('[hidden], .hidden, [aria-hidden="true"]'))
      focusTarget?.focus({ preventScroll: true })
      highlightTimerRef.current = setTimeout(() => {
        target.classList.remove('settings-search-highlight')
        highlightTimerRef.current = null
      }, 1800)
    }
    highlightFrameRef.current = requestAnimationFrame(() => locate(30))
  }, [switchTab])

  const handleTabKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        const dir = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1
        const ids = visibleTabs.map(t => t.id)
        if (ids.length === 0) return
        const next = (ids.indexOf(tab) + dir + ids.length) % ids.length
        switchTab(ids[next])
        requestAnimationFrame(() => {
          document.getElementById(`settings-tab-${ids[next]}`)?.focus()
        })
      }
    },
    [tab, visibleTabs, switchTab],
  )

  const activeTabMeta = visibleTabs.find(vt => vt.id === tab) || visibleTabs[0]
  const activePanelId = `settings-panel-${tab}`
  const search = (
    <SettingsSearch
      items={searchItems}
      placeholder={t('search.placeholder')}
      clearLabel={t('search.clear')}
      noResultsLabel={t('search.noResults')}
      onSelect={selectSearchItem}
    />
  )

  const backButton = (
    <button
      type="button"
      onClick={onBack}
      className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[length:var(--fs-sm)] font-medium text-text-300 transition-colors hover:bg-bg-100 hover:text-text-100"
      aria-label={t('backToWorkspace')}
    >
      <ChevronLeftIcon size={16} />
      <span className="truncate">{t('backToWorkspace')}</span>
    </button>
  )

  // 移动端：全屏体验，顶部 sticky tab
  if (isMobile) {
    return (
      <div className="settings-surface settings-mobile-surface flex min-h-0 flex-1 flex-col">
        {/* Sticky Header + Tabs */}
        <div className="shrink-0">
          {/* Window chrome floats over the top-left corner; keep the back button and tabs clear of it. */}
          <div className="mobile-safe-topbar-14 window-drag-region shrink-0" />
          {/* Title bar */}
          <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-2">
            <button type="button" onClick={onBack} className="flex items-center gap-1 rounded-md p-1 text-text-400 hover:bg-bg-100 hover:text-text-200" aria-label={t('backToWorkspace')}>
              <ChevronLeftIcon size={18} />
              <span className="text-[length:var(--fs-sm)]">{t('backToWorkspace')}</span>
            </button>
            <div className="text-[length:var(--fs-lg)] font-semibold text-text-100">{t('title')}</div>
            <div className="w-9" aria-hidden="true" />
          </div>
          <div className="px-4 pb-2">{search}</div>

          {/* Tab Bar - horizontal scroll with padding for visual safety */}
          <div className="relative">
            <div
              role="tablist"
              aria-label={t('title')}
              onKeyDown={handleTabKeyDown}
              className="flex items-center gap-1.5 px-4 pb-3 overflow-x-auto scrollbar-none"
            >
              {visibleTabs.map(vt => (
                <button
                  key={vt.id}
                  id={`settings-tab-${vt.id}`}
                  type="button"
                  role="tab"
                  aria-selected={vt.id === tab}
                  aria-controls={`settings-panel-${vt.id}`}
                  tabIndex={vt.id === tab ? 0 : -1}
                  onClick={() => switchTab(vt.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[length:var(--fs-md)] font-medium transition-colors whitespace-nowrap shrink-0 border
                    ${
                      vt.id === tab
                        ? 'bg-accent-main-100/10 text-accent-main-100 border-accent-main-100/30'
                        : 'text-text-400 border-transparent active:bg-bg-100/60'
                    }`}
                >
                  {vt.icon}
                  {vt.label}
                </button>
              ))}
            </div>
            <div className="absolute bottom-0 left-0 right-0 border-b border-border-100/40" />
          </div>
        </div>

        {/* Content - single scroll container */}
        <div
          id={activePanelId}
          role="tabpanel"
          aria-labelledby={`settings-tab-${tab}`}
          ref={scrollRef}
          className="flex-1 min-h-0 py-4 px-4 overflow-y-auto custom-scrollbar overscroll-contain"
        >
          <TabContent tab={tab} />
        </div>
      </div>
    )
  }

  // 桌面端：左侧导航 + 右侧内容
  return (
    <div className="settings-surface flex h-full min-h-0 flex-1 min-w-0">
      {/* Left Nav - 窄屏时收缩 */}
      <nav
        role="tablist"
        aria-orientation="vertical"
        aria-label={t('title')}
        className="settings-sidebar-surface shrink-0 border-r border-border-100/60 flex flex-col"
        style={{ width: layout.sidebar.openWidth }}
        onKeyDown={handleTabKeyDown}
      >
        {/* Window chrome floats over the top-left corner; keep the back button clear of it. */}
        <div className="mobile-safe-topbar-14 window-drag-region shrink-0" />
        {/* 返回工作区 - 固定不随滚动 */}
        <div className="shrink-0 px-2 xl:px-2.5 pb-3">
          <div className="px-2.5 xl:px-3">{backButton}</div>
        </div>
        {/* 搜索框 - 固定不随滚动 */}
        <div className="shrink-0 px-2 xl:px-2.5 pb-4">
          <div className="px-2.5 xl:px-3">{search}</div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-none px-2 xl:px-2.5 pb-4">
          <div className="space-y-3">
            {groupedTabs.map(group => (
              <div key={group.tabs[0].id}>
                {group.label && (
                  <div className="px-2.5 xl:px-3 mb-1.5 text-[length:var(--fs-xxs)] font-semibold uppercase tracking-wider text-text-400/90">
                    {group.label}
                  </div>
                )}
                <div className="space-y-0.5">
                  {group.tabs.map(vt => (
                    <button
                      key={vt.id}
                      id={`settings-tab-${vt.id}`}
                      type="button"
                      role="tab"
                      aria-selected={vt.id === tab}
                      aria-controls={`settings-panel-${vt.id}`}
                      onClick={() => switchTab(vt.id)}
                      tabIndex={vt.id === tab ? 0 : -1}
                      className={`w-full flex items-center gap-2.5 px-2.5 xl:px-3 py-2 xl:py-2.5 rounded-lg text-[length:var(--fs-md)] font-medium transition-colors
                        ${
                          vt.id === tab
                            ? 'sidebar-selected-row text-text-100 ring-1 ring-border-200/60'
                            : 'text-text-400 hover:text-text-200 sidebar-hover-row'
                        }`}
                    >
                      {vt.icon}
                      <span className="truncate">{vt.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </nav>

      {/* Right Content */}
      <div className="settings-content-surface flex-1 min-w-0 flex flex-col">
        {/* Content Header - sticky at top */}
        <div className="window-drag-region shrink-0 border-b border-border-100/60 px-5 xl:px-6 py-3.5 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[length:var(--fs-lg)] font-semibold text-text-100">{activeTabMeta.label}</div>
            <div className="text-[length:var(--fs-xs)] text-text-400 mt-0.5 leading-relaxed truncate">
              {activeTabMeta.description}
            </div>
          </div>
        </div>

        {/* Scroll area - single scroll container for all tab content */}
        <div
          id={activePanelId}
          role="tabpanel"
          aria-labelledby={`settings-tab-${tab}`}
          ref={scrollRef}
          className="flex-1 min-h-0 py-5 px-5 xl:px-6 overflow-y-auto custom-scrollbar"
        >
          <TabContent tab={tab} />
        </div>
      </div>
    </div>
  )
}
