import { useCallback, useEffect, useState } from 'react'
import { ChevronLeftIcon, ChevronRightIcon, SearchIcon, SidebarIcon, BellIcon, CirclePlusIcon } from './Icons'
import { ElectronUpdateToggle } from './ElectronUpdateToggle'
import { DESKTOP_TITLEBAR_HEIGHT, DESKTOP_TITLEBAR_Z_INDEX } from '../constants/desktopWindow'
import { useTranslation } from 'react-i18next'
import { canGoBack, canGoForward, subscribe } from '../store/navigationHistoryStore'
import { useUnreadNotificationCount } from '../store/notificationStore'

interface ElectronWindowsTitlebarProps {
  sidebarExpanded: boolean
  onToggleSidebar: () => void
  onNewTask: () => void
  onOpenSidebarPreview: () => void
  onCloseSidebarPreview: () => void
  onOpenSearch: () => void
  onOpenNotifications: () => void
  sidebarTitle: string
  newTaskTitle: string
  searchTitle: string
  notificationsTitle: string
  backTitle: string
  forwardTitle: string
  onGoBack: () => void
  onGoForward: () => void
}

export function ElectronWindowsTitlebar({
  sidebarExpanded,
  onToggleSidebar,
  onNewTask,
  onOpenSidebarPreview,
  onCloseSidebarPreview,
  onOpenSearch,
  onOpenNotifications,
  sidebarTitle,
  newTaskTitle,
  searchTitle,
  notificationsTitle,
  backTitle,
  forwardTitle,
  onGoBack,
  onGoForward,
}: ElectronWindowsTitlebarProps) {
  const { t } = useTranslation('common')
  const [isMaximized, setIsMaximized] = useState(false)
  const [navState, setNavState] = useState(() => ({ back: canGoBack(), forward: canGoForward() }))
  const unreadNotificationCount = useUnreadNotificationCount()
  useEffect(() => subscribe(() => setNavState({ back: canGoBack(), forward: canGoForward() })), [])

  useEffect(() => {
    const checkMaximized = async () => {
      if (window.customOpenCode) {
        const maximized = await window.customOpenCode.windowIsMaximized()
        setIsMaximized(maximized)
      }
    }
    checkMaximized()

    const handleMaximize = () => setIsMaximized(true)
    const handleUnmaximize = () => setIsMaximized(false)
    window.addEventListener('electron:window-maximize', handleMaximize)
    window.addEventListener('electron:window-unmaximize', handleUnmaximize)

    return () => {
      window.removeEventListener('electron:window-maximize', handleMaximize)
      window.removeEventListener('electron:window-unmaximize', handleUnmaximize)
    }
  }, [])

  const handleMinimize = useCallback(async () => {
    if (window.customOpenCode) await window.customOpenCode.windowMinimize()
  }, [])

  const handleMaximizeToggle = useCallback(async () => {
    if (window.customOpenCode) await window.customOpenCode.windowMaximize()
  }, [])

  const handleClose = useCallback(async () => {
    if (window.customOpenCode) await window.customOpenCode.windowClose()
  }, [])

  return (
    <header
      className="electron-windows-titlebar window-drag-region relative flex shrink-0 items-center"
      style={{
        height: DESKTOP_TITLEBAR_HEIGHT,
        zIndex: DESKTOP_TITLEBAR_Z_INDEX,
        backgroundColor: 'hsl(var(--sidebar-bg))',
        // The rounded chat panel draws its own edge; a titlebar underline would add a second frame.
        backgroundImage: 'none',
        // The panel starts below a small gutter; balance it with the same visual margin on top.
        paddingTop: 4,
      }}
    >
      <div className="flex items-center gap-2 pl-3">
        <button
          type="button"
          onPointerEnter={onOpenSidebarPreview}
          onPointerLeave={onCloseSidebarPreview}
          onPointerDownCapture={event => event.stopPropagation()}
          onMouseDownCapture={event => event.stopPropagation()}
          onClickCapture={event => {
            event.stopPropagation()
            onToggleSidebar()
          }}
          aria-label={sidebarTitle}
          aria-pressed={sidebarExpanded}
          title={sidebarTitle}
          className="electron-windows-titlebar-btn window-no-drag"
        >
          <SidebarIcon size={18} />
        </button>
        {!sidebarExpanded && (
          <button
            type="button"
            onClick={onNewTask}
            aria-label={newTaskTitle}
            title={newTaskTitle}
            className="electron-windows-titlebar-btn window-no-drag"
          >
            <CirclePlusIcon size={18} />
          </button>
        )}
        <button
          type="button"
          onClick={onOpenSearch}
          aria-label={searchTitle}
          title={searchTitle}
          className="electron-windows-titlebar-btn window-no-drag"
        >
          <SearchIcon size={18} />
        </button>
        <button
          type="button"
          onClick={onOpenNotifications}
          aria-label={notificationsTitle}
          title={notificationsTitle}
          className="electron-windows-titlebar-btn window-no-drag"
        >
          <span className="relative flex items-center justify-center">
            <BellIcon size={18} />
            {unreadNotificationCount > 0 && (
              <span className="electron-notification-badge">{unreadNotificationCount > 99 ? '99+' : unreadNotificationCount}</span>
            )}
          </span>
        </button>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            disabled={!navState.back}
            onClick={onGoBack}
            aria-label={backTitle}
            title={backTitle}
            className="electron-windows-titlebar-btn window-no-drag"
          >
            <ChevronLeftIcon size={18} />
          </button>
          <button
            type="button"
            disabled={!navState.forward}
            onClick={onGoForward}
            aria-label={forwardTitle}
            title={forwardTitle}
            className="electron-windows-titlebar-btn window-no-drag"
          >
            <ChevronRightIcon size={18} />
          </button>
        </div>
        <ElectronUpdateToggle variant="titlebar" />
      </div>

      <div className="flex-1" />

      <div className="flex items-stretch h-full window-no-drag">
        <button
          type="button"
          onClick={handleMinimize}
          title={t('minimize')}
          aria-label={t('minimize')}
          className="electron-windows-titlebar-ctrl-btn window-no-drag"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
        <button
          type="button"
          onClick={handleMaximizeToggle}
          title={isMaximized ? t('restore') : t('maximize')}
          aria-label={isMaximized ? t('restore') : t('maximize')}
          className="electron-windows-titlebar-ctrl-btn window-no-drag"
        >
          {isMaximized ? (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <rect x="2.5" y="3" width="6" height="6" stroke="currentColor" strokeWidth="1.2" fill="none" />
              <line x1="2.5" y1="3.5" x2="2.5" y2="1.5" stroke="currentColor" strokeWidth="1.2" />
              <line x1="2.5" y1="1.5" x2="9.5" y2="1.5" stroke="currentColor" strokeWidth="1.2" />
              <line x1="9.5" y1="1.5" x2="9.5" y2="3" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <rect x="2" y="2" width="8" height="8" stroke="currentColor" strokeWidth="1.2" fill="none" />
            </svg>
          )}
        </button>
        <button
          type="button"
          onClick={handleClose}
          title={t('close')}
          aria-label={t('close')}
          className="electron-windows-titlebar-ctrl-btn electron-windows-titlebar-close window-no-drag"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <line x1="2.5" y1="2.5" x2="9.5" y2="9.5" stroke="currentColor" strokeWidth="1.2" />
            <line x1="9.5" y1="2.5" x2="2.5" y2="9.5" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>
    </header>
  )
}
