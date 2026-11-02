import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import {
  ChevronDownIcon,
  GaugeIcon,
  CogIcon,
  SunIcon,
  MoonIcon,
  SystemIcon,
  SmartphoneIcon,
  GlobeIcon,
  BellIcon,
  QuestionIcon,
} from '../../../components/Icons'
import { getProviders } from '../../../api'
import { useServerStore, useTheme } from '../../../hooks'
import { useDesktopPreferences } from '../../../store/desktopPreferencesStore'
import { useUnreadNotificationCount } from '../../../store/notificationStore'
import { hasUpdateAvailable, updaterHasNewVersion, useUpdateStore } from '../../../store/updateStore'
import { serverStore } from '../../../store/serverStore'
import { ImBridgeDialog } from './ImBridgeDialog'
import { ServerSwitchDialog } from './ServerSwitchDialog'
import { UpdateDialog } from './UpdateDialog'
import { useImBridgeData } from '../../settings/components/imBotShared'
import type { QuotaProviderResult } from '../../../../../shared/quota'

function AccountIndicator({ connectionState, size = 24 }: { connectionState: string; size?: number }) {
  const statusColor =
    connectionState === 'connected'
      ? 'bg-success-100'
      : connectionState === 'connecting'
        ? 'bg-warning-100 animate-pulse'
        : connectionState === 'error'
          ? 'bg-danger-100'
          : 'bg-text-500'

  return (
    <div
      className="relative shrink-0 rounded-full border border-border-200/60 bg-bg-200/70"
      style={{ width: size, height: size }}
    >
      <div className="absolute inset-1.5 rounded-full bg-text-400/25" />
      <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-bg-200 ${statusColor}`} />
    </div>
  )
}

export interface SidebarFooterProps {
  showLabels: boolean
  connectionState: string
  onOpenSettings?: () => void
  onOpenNotifications?: () => void
}

export function SidebarFooter({ showLabels, connectionState, onOpenSettings, onOpenNotifications }: SidebarFooterProps) {
  const { t, i18n } = useTranslation(['chat', 'common'])
  const { mode: themeMode, setThemeWithAnimation: onThemeChange } = useTheme()
  const { activeServer } = useServerStore()
  const preferences = useDesktopPreferences()
  const unreadNotificationCount = useUnreadNotificationCount()
  const updateState = useUpdateStore()
  const updateAvailable = updaterHasNewVersion(updateState) || hasUpdateAvailable(updateState)
  const [isOpen, setIsOpen] = useState(false)
  const [quotaExpanded, setQuotaExpanded] = useState(false)
  const [quotaLoading, setQuotaLoading] = useState(false)
  const [quotaResults, setQuotaResults] = useState<QuotaProviderResult[]>([])
  const [connectedProviders, setConnectedProviders] = useState<Set<string>>(new Set())
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, width: 260, fromBottom: false })
  const [isVisible, setIsVisible] = useState(false)
  const [imDialogOpen, setImDialogOpen] = useState(false)
  const [serverSwitchOpen, setServerSwitchOpen] = useState(false)
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)
  const imBridge = useImBridgeData({ refreshConfigOnEvent: true })
  const prevShowLabelsRef = useRef(showLabels)
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const closeTimeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 菜单中连接状态显示用
  const connectionLabel = activeServer?.name || t(`sidebar.connection.${connectionState}`, {
    defaultValue: t('sidebar.connection.unknown'),
  })

  // 打开菜单
  const openMenu = useCallback(() => {
    if (!buttonRef.current || !containerRef.current) return

    const buttonRect = buttonRef.current.getBoundingClientRect()
    const containerRect = containerRef.current.getBoundingClientRect()
    const menuWidth = showLabels ? containerRect.width : 260

    if (showLabels) {
      // 展开模式：菜单底部在容器上方，留点间隙
      setMenuPos({
        top: containerRect.top - 8,
        left: containerRect.left,
        width: menuWidth,
        fromBottom: true,
      })
    } else {
      // 收起模式：菜单在按钮右侧，底部对齐按钮底部
      setMenuPos({
        top: buttonRect.bottom, // 用作 bottom 计算的参考点
        left: buttonRect.right + 16, // 间距增加到 16px
        width: 260,
        fromBottom: true, // 也用 bottom 定位
      })
    }

    setIsOpen(true)
    requestAnimationFrame(() => setIsVisible(true))
  }, [showLabels])

  // 关闭菜单
  const closeMenu = useCallback(() => {
    setIsVisible(false)
    setQuotaExpanded(false)
    // 使用 ref 追踪 timeout 以便清理
    const closeTimeoutId = setTimeout(() => setIsOpen(false), 150)
    // 保存到 ref 以便清理
    closeTimeoutIdRef.current = closeTimeoutId
  }, [])

  useEffect(() => {
    void getProviders()
      .then(value => setConnectedProviders(new Set(value.connected)))
      .catch(() => setConnectedProviders(new Set()))
  }, [activeServer?.id, isOpen])

  const enabledQuotaProviders = preferences.quotaProviders.filter(item => item.enabled && connectedProviders.has(item.id))

  const toggleQuota = useCallback(() => {
    if (quotaExpanded) {
      setQuotaExpanded(false)
      return
    }
    setQuotaExpanded(true)
    if (!window.customOpenCode?.queryQuota || enabledQuotaProviders.length === 0) return
    setQuotaLoading(true)
    void window.customOpenCode.queryQuota({
      providerIds: enabledQuotaProviders.map(item => item.id),
      localServer: serverStore.isActiveLocalServer(),
    })
      .then(setQuotaResults)
      .catch(error => {
        setQuotaResults(enabledQuotaProviders.map(item => ({
          providerId: item.id,
          label: item.id,
          status: 'error',
          rows: [],
          error: error instanceof Error ? error.message : t('sidebar.quota.loadFailed'),
          fetchedAt: Date.now(),
        })))
      })
      .finally(() => setQuotaLoading(false))
  }, [enabledQuotaProviders, quotaExpanded, t])

  // 切换菜单
  const toggleMenu = useCallback(() => {
    if (isOpen) closeMenu()
    else openMenu()
  }, [isOpen, openMenu, closeMenu])

  // 点击外部关闭
  useEffect(() => {
    if (!isOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (buttonRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      closeMenu()
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen, closeMenu])

  // ESC 关闭
  useEffect(() => {
    if (!isOpen) return
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu()
    }
    document.addEventListener('keydown', handleEsc)
    return () => document.removeEventListener('keydown', handleEsc)
  }, [isOpen, closeMenu])

  // 侧边栏状态变化时关闭
  useEffect(() => {
    const showLabelsChanged = prevShowLabelsRef.current !== showLabels
    prevShowLabelsRef.current = showLabels

    let frameId: number | null = null

    if (showLabelsChanged && isOpen) {
      frameId = requestAnimationFrame(() => closeMenu())
    }

    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId)
    }
  }, [showLabels, isOpen, closeMenu])

  // 清理 closeTimeout 防止内存泄漏
  useEffect(() => {
    return () => {
      if (closeTimeoutIdRef.current) {
        clearTimeout(closeTimeoutIdRef.current)
        closeTimeoutIdRef.current = null
      }
    }
  }, [])

  // 浮动菜单
  const floatingMenu = isOpen
    ? createPortal(
        <div
          ref={menuRef}
          className={`
        fixed z-[9999] max-h-[min(78vh,680px)] overflow-y-auto rounded-lg border border-border-200/60 glass-alt sidebar-footer-popover shadow-lg
        transition-all duration-150 ease-out
        ${isVisible ? 'opacity-100 scale-100' : 'opacity-0 scale-95'}
      `}
          style={{
            bottom: window.innerHeight - menuPos.top,
            left: menuPos.left,
            width: menuPos.width,
            transformOrigin: showLabels ? 'bottom left' : 'bottom left',
          }}
        >
          {/* Theme Selector */}
          <div className="relative p-2">
            <div className="flex bg-bg-200/50 p-1 rounded-md border border-border-200/30 relative isolate">
              <div
                className="absolute top-1 bottom-1 left-1 w-[calc((100%-8px)/3)] bg-bg-000 rounded-sm shadow-sm ring-1 ring-border-200/50 transition-transform duration-300 ease-out -z-10"
                style={{
                  transform:
                    themeMode === 'system'
                      ? 'translateX(0%)'
                      : themeMode === 'light'
                        ? 'translateX(100%)'
                        : 'translateX(200%)',
                }}
              />
              {(['system', 'light', 'dark'] as const).map(m => (
                <button
                  key={m}
                  onClick={e => onThemeChange(m, e)}
                  className={`flex-1 flex items-center justify-center py-1.5 rounded-sm text-[length:var(--fs-sm)] font-medium transition-colors duration-200 ${
                    themeMode === m ? 'text-text-100' : 'text-text-400 hover:text-text-200'
                  }`}
                >
                  {m === 'system' && <SystemIcon size={14} />}
                  {m === 'light' && <SunIcon size={14} />}
                  {m === 'dark' && <MoonIcon size={14} />}
                </button>
              ))}
            </div>
            <div className="pointer-events-none absolute inset-x-3 bottom-0 h-px bg-border-200/30" />
          </div>

          {/* Menu Items */}
          <div className="p-1">
            {/* 切换服务器：弹出服务器列表快速切换 */}
            <button
              type="button"
              onClick={() => {
                closeMenu()
                setServerSwitchOpen(true)
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[length:var(--fs-sm)] text-text-300 transition-colors hover:bg-bg-200/50 hover:text-text-100"
            >
              <GlobeIcon size={14} />
              <span>{t('sidebar.switchServer')}</span>
            </button>
            <div className="my-1 h-px bg-border-200/30" />
            {/* 登录入口先隐藏；供应商 API Key 暂时统一走 设置 -> 供应商 配置。 */}

            {enabledQuotaProviders.length > 0 && (
              <div className="mb-0.5">
                <button
                  type="button"
                  onClick={toggleQuota}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[length:var(--fs-sm)] text-text-300 transition-colors hover:bg-bg-200/50 hover:text-text-100"
                >
                  <GaugeIcon size={14} />
                  <span className="flex-1">{t('sidebar.quota.title')}</span>
                  <ChevronDownIcon
                    size={13}
                    className={`text-text-400 transition-transform ${quotaExpanded ? 'rotate-180' : ''}`}
                  />
                </button>

                {quotaExpanded && (
                  <div className="mx-2 mb-2 mt-1 space-y-2 border-l border-border-200/50 pl-3">
                    {quotaLoading ? (
                      <div className="py-2 text-[length:var(--fs-xs)] text-text-400">
                        {t('sidebar.quota.loading')}
                      </div>
                    ) : quotaResults.length === 0 ? (
                      <div className="py-2 text-[length:var(--fs-xs)] text-text-400">
                        {t('sidebar.quota.empty')}
                      </div>
                    ) : (
                      quotaResults.map(provider => (
                        <div key={provider.providerId} className="space-y-1.5">
                          <div className="truncate text-[length:var(--fs-xs)] font-semibold text-text-200">
                            {provider.label}
                          </div>
                          {provider.status !== 'ok' ? (
                            <div className="rounded-md bg-danger-100/8 px-2 py-1.5 text-[length:var(--fs-xxs)] leading-relaxed text-danger-100">
                              {provider.error || t('sidebar.quota.unavailable')}
                            </div>
                          ) : (
                            provider.rows.map((row, index) => (
                              <div key={`${row.label}-${index}`} className="space-y-1">
                                <div className="flex items-baseline gap-2 text-[length:var(--fs-xs)]">
                                  <span className="min-w-0 flex-1 truncate text-text-300">{row.label}</span>
                                  {row.kind === 'percent' ? (
                                    <span className="font-medium tabular-nums text-text-200">{Math.round(row.percentRemaining ?? 0)}%</span>
                                  ) : (
                                    <span className="max-w-[55%] truncate font-medium tabular-nums text-text-200">{row.value}</span>
                                  )}
                                  {row.resetAt && (
                                    <span className="shrink-0 tabular-nums text-text-500">
                                      {new Intl.DateTimeFormat(i18n.language, {
                                        month: 'short',
                                        day: 'numeric',
                                        hour: '2-digit',
                                        minute: '2-digit',
                                      }).format(new Date(row.resetAt))}
                                    </span>
                                  )}
                                </div>
                                {row.kind === 'percent' && (
                                  <div className="h-1 overflow-hidden rounded-full bg-bg-300/80">
                                    <div
                                      className={`h-full rounded-full ${
                                        (row.percentRemaining ?? 0) <= 10
                                          ? 'bg-danger-100'
                                          : (row.percentRemaining ?? 0) <= 25
                                            ? 'bg-warning-100'
                                            : 'bg-accent-main-100'
                                      }`}
                                      style={{ width: `${Math.max(0, Math.min(100, row.percentRemaining ?? 0))}%` }}
                                    />
                                  </div>
                                )}
                                {row.detail && (
                                  <div className="truncate text-[length:var(--fs-xxs)] text-text-500">{row.detail}</div>
                                )}
                              </div>
                            ))
                          )}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}

            {enabledQuotaProviders.length > 0 && <div className="my-1 h-px bg-border-200/30" />}

            {/* 收起侧边栏时底部没有图标位，通知入口保留在菜单里 */}
            {!showLabels && (
              <button
                onClick={() => {
                  closeMenu()
                  onOpenNotifications?.()
                }}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[length:var(--fs-sm)] text-text-300 hover:text-text-100 hover:bg-bg-200/50 transition-colors text-left"
              >
                <BellIcon size={14} />
                <span className="flex-1">{t('sidebar.notifications')}</span>
                {unreadNotificationCount > 0 && (
                  <span className="rounded-full bg-danger-100 px-1.5 py-0.5 text-[length:var(--fs-xxs)] font-semibold leading-none text-[hsl(var(--always-white))]">
                    {unreadNotificationCount > 99 ? '99+' : unreadNotificationCount}
                  </span>
                )}
              </button>
            )}

            {/* 检查更新：从标题栏移入菜单，点击后打开居中弹窗 */}
            <button
              onClick={() => {
                closeMenu()
                setUpdateDialogOpen(true)
              }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[length:var(--fs-sm)] text-text-300 hover:text-text-100 hover:bg-bg-200/50 transition-colors text-left"
            >
              <QuestionIcon size={14} />
              <span className="flex-1">{t('sidebar.update.check')}</span>
              {updateAvailable && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger-100" />}
            </button>

            {/* 设置入口：展开与收起模式统一收进底部下拉菜单 */}
            <button
              onClick={() => {
                closeMenu()
                onOpenSettings?.()
              }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[length:var(--fs-sm)] text-text-300 hover:text-text-100 hover:bg-bg-200/50 transition-colors text-left"
            >
              <CogIcon size={14} />
              <span>{t('sidebar.settings')}</span>
            </button>
          </div>
        </div>,
        document.body,
      )
    : null

  return (
    <div className="shrink-0 pb-[var(--safe-area-inset-bottom)]">
      <div ref={containerRef} className="flex flex-col gap-0.5 mx-2 py-2">
        <div className="flex items-stretch gap-1">
          {/* 状态/设置触发按钮 */}
          <button
            ref={buttonRef}
            onClick={toggleMenu}
            className={`
              h-8 min-w-0 flex-1 flex items-center rounded-lg transition-all duration-300 group overflow-hidden
              ${isOpen ? 'bg-bg-200 text-text-100 shadow-sm' : 'text-text-300 hover:text-text-100 sidebar-hover-row'}
            `}
            style={{
              paddingLeft: showLabels ? 6 : 4, // 收起时为了对齐中心线(16px)，24px圆环需要4px padding (4+12=16)
              paddingRight: showLabels ? 8 : 4,
            }}
            title={connectionLabel}
          >
            <AccountIndicator connectionState={connectionState} size={24} />

            <span
              className="ml-2 flex-1 flex items-center justify-between min-w-0 transition-opacity duration-300"
              style={{ opacity: showLabels ? 1 : 0 }}
            >
              <span className="text-[length:var(--fs-sm)] text-text-300 truncate">{connectionLabel}</span>
            </span>
          </button>

          {/* 通知入口：从标题栏移到底部，与账号状态并排 */}
          {showLabels && (
            <button
              type="button"
              onClick={onOpenNotifications}
              aria-label={t('sidebar.notifications')}
              title={t('sidebar.notifications')}
              className="relative h-8 w-8 shrink-0 flex items-center justify-center rounded-lg sidebar-hover-row hover:text-text-100 text-text-400 transition-all duration-300"
            >
              <BellIcon size={16} />
              {unreadNotificationCount > 0 && (
                <span className="electron-notification-badge">{unreadNotificationCount > 99 ? '99+' : unreadNotificationCount}</span>
              )}
            </button>
          )}

          {/* IM 机器人入口：点击打开独立配置弹窗 */}
          {showLabels && imBridge.available && (
            <button
              type="button"
              onClick={() => setImDialogOpen(true)}
              aria-label={t('sidebar.imBot.title')}
              title={t('sidebar.imBot.title')}
              className={`
                relative h-8 w-8 shrink-0 flex items-center justify-center rounded-lg transition-all duration-300
                sidebar-hover-row hover:text-text-100
                ${
                  imBridge.state.status === 'running'
                    ? 'text-success-100'
                    : imBridge.state.status === 'error'
                      ? 'text-danger-100'
                      : 'text-text-400'
                }
              `}
            >
              <SmartphoneIcon size={16} />
            </button>
          )}
        </div>
      </div>

      {floatingMenu}

      <ImBridgeDialog isOpen={imDialogOpen} onClose={() => setImDialogOpen(false)} />
      <ServerSwitchDialog isOpen={serverSwitchOpen} onClose={() => setServerSwitchOpen(false)} />
      <UpdateDialog isOpen={updateDialogOpen} onClose={() => setUpdateDialogOpen(false)} />
    </div>
  )
}
