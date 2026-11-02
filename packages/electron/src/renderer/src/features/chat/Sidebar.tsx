import { useState, useCallback, useEffect, useRef, memo } from 'react'
import { SidePanel } from './sidebar/SidePanel'
import { ProjectDialog } from './ProjectDialog'
import { useDirectory } from '../../hooks'
import { type ApiSession } from '../../api'
import { useChatViewport } from './chatViewport'

function clampSidebarWidth(width: number, minWidth: number, maxWidth: number) {
  return Math.min(Math.max(width, minWidth), maxWidth)
}

const SIDEBAR_SWIPE_LOCK_PX = 10
const SIDEBAR_SWIPE_HORIZONTAL_BIAS = 1.25
const SIDEBAR_SWIPE_CLOSE_PX = 80

type SidebarSwipeAxis = 'pending' | 'horizontal' | 'vertical'

interface SidebarProps {
  isOpen: boolean
  selectedSessionId: string | null
  onSelectSession: (session: ApiSession) => void
  onNewSession: () => void
  onOpen: () => void
  onClose: () => void
  onOpenSettings?: () => void
  onOpenNotifications?: () => void
  onOpenSearch?: () => void
  onOpenPlugins?: () => void
  onOpenTasks?: () => void
  activeUtilityPage?: 'plugins' | 'tasks' | null
  projectDialogOpen?: boolean
  onProjectDialogClose?: () => void
  mobileInline?: boolean
  previewMode?: boolean
}

export const Sidebar = memo(function Sidebar({
  isOpen,
  selectedSessionId,
  onSelectSession,
  onNewSession,
  onOpen,
  onClose,
  onOpenSettings,
  onOpenNotifications,
  onOpenSearch,
  onOpenPlugins,
  onOpenTasks,
  activeUtilityPage,
  projectDialogOpen,
  onProjectDialogClose,
  mobileInline = false,
  previewMode = false,
}: SidebarProps) {
  const [isProjectDialogOpen, setIsProjectDialogOpen] = useState(false)
  const [projectDialogKey, setProjectDialogKey] = useState(0)
  const { addDirectory, pathInfo } = useDirectory()
  const { interaction, layout, actions } = useChatViewport()
  const isOverlay = interaction.sidebarBehavior === 'overlay'
  const touchCapable = interaction.touchCapable
  const isProjectDialogVisible = isProjectDialogOpen || !!projectDialogOpen
  const activeNavigation = activeUtilityPage ?? (selectedSessionId ? null : 'new')

  const [isResizing, setIsResizing] = useState(false)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const currentWidthRef = useRef(layout.sidebar.openWidth)
  const rafRef = useRef<number>(0)

  const handleAddProject = useCallback(
    (path: string) => {
      addDirectory(path)
      if (!isOverlay) {
        onOpen()
      }
    },
    [addDirectory, isOverlay, onOpen],
  )

  const openProjectDialog = useCallback(() => {
    setProjectDialogKey(key => key + 1)
    setIsProjectDialogOpen(true)
  }, [])

  const closeProjectDialog = useCallback(() => {
    setIsProjectDialogOpen(false)
    onProjectDialogClose?.()
  }, [onProjectDialogClose])

  const persistSidebarWidth = useCallback(
    (nextWidth: number) => {
      const finalWidth = clampSidebarWidth(nextWidth, layout.sidebar.hardMinWidth, layout.sidebar.resizeMaxWidth)
      actions.setSidebarRequestedWidth(finalWidth)
      setIsResizing(false)
      return finalWidth
    },
    [actions, layout.sidebar.hardMinWidth, layout.sidebar.resizeMaxWidth],
  )

  const startResizing = useCallback(
    (e: React.MouseEvent) => {
      if (isOverlay) return
      e.preventDefault()

      const sidebar = sidebarRef.current
      if (!sidebar) return

      setIsResizing(true)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current)
        rafRef.current = requestAnimationFrame(() => {
          const newWidth = clampSidebarWidth(
            moveEvent.clientX,
            layout.sidebar.hardMinWidth,
            layout.sidebar.resizeMaxWidth,
          )
          sidebar.style.width = `${newWidth}px`
          currentWidthRef.current = newWidth
        })
      }

      const handleMouseUp = () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        persistSidebarWidth(currentWidthRef.current)
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [isOverlay, layout.sidebar.hardMinWidth, layout.sidebar.resizeMaxWidth, persistSidebarWidth],
  )

  const startTouchResizing = useCallback(
    (e: React.TouchEvent) => {
      if (isOverlay || !touchCapable || e.touches.length !== 1) return
      e.preventDefault()

      const sidebar = sidebarRef.current
      if (!sidebar) return

      setIsResizing(true)
      document.body.style.userSelect = 'none'

      const handleTouchMove = (moveEvent: TouchEvent) => {
        if (moveEvent.touches.length !== 1) return
        moveEvent.preventDefault()
        if (rafRef.current) cancelAnimationFrame(rafRef.current)
        rafRef.current = requestAnimationFrame(() => {
          const newWidth = clampSidebarWidth(
            moveEvent.touches[0].clientX,
            layout.sidebar.hardMinWidth,
            layout.sidebar.resizeMaxWidth,
          )
          sidebar.style.width = `${newWidth}px`
          currentWidthRef.current = newWidth
        })
      }

      const handleTouchEnd = () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current)
        document.body.style.userSelect = ''
        document.removeEventListener('touchmove', handleTouchMove)
        document.removeEventListener('touchend', handleTouchEnd)
        document.removeEventListener('touchcancel', handleTouchEnd)
        persistSidebarWidth(currentWidthRef.current)
      }

      document.addEventListener('touchmove', handleTouchMove, { passive: false })
      document.addEventListener('touchend', handleTouchEnd)
      document.addEventListener('touchcancel', handleTouchEnd)
    },
    [isOverlay, layout.sidebar.hardMinWidth, layout.sidebar.resizeMaxWidth, persistSidebarWidth, touchCapable],
  )

  useEffect(() => {
    currentWidthRef.current = layout.sidebar.openWidth
  }, [layout.sidebar.openWidth])

  const handleBackdropClick = useCallback(() => {
    if (isOverlay && isOpen) {
      onClose()
    }
  }, [isOverlay, isOpen, onClose])

  const handleSelectSession = useCallback(
    (session: ApiSession) => {
      onSelectSession(session)
      if (isOverlay) {
        onClose()
      }
    },
    [onClose, onSelectSession, isOverlay],
  )

  const touchStartX = useRef(0)
  const touchStartY = useRef(0)
  const touchDeltaX = useRef(0)
  const touchSwipeAxis = useRef<SidebarSwipeAxis>('pending')
  const [swipeX, setSwipeX] = useState(0)
  const isSwiping = useRef(false)
  const [isSwipingActive, setIsSwipingActive] = useState(false)

  const handleSidebarTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length !== 1) return
    touchStartX.current = e.touches[0].clientX
    touchStartY.current = e.touches[0].clientY
    touchDeltaX.current = 0
    touchSwipeAxis.current = 'pending'
    isSwiping.current = false
    setIsSwipingActive(false)
  }, [])

  const handleSidebarTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length !== 1) return

    const deltaX = e.touches[0].clientX - touchStartX.current
    const deltaY = e.touches[0].clientY - touchStartY.current
    const absX = Math.abs(deltaX)
    const absY = Math.abs(deltaY)

    if (touchSwipeAxis.current === 'pending') {
      if (Math.max(absX, absY) < SIDEBAR_SWIPE_LOCK_PX) return

      touchSwipeAxis.current = absX > absY * SIDEBAR_SWIPE_HORIZONTAL_BIAS ? 'horizontal' : 'vertical'
      if (touchSwipeAxis.current === 'vertical') {
        isSwiping.current = false
        setIsSwipingActive(false)
        touchDeltaX.current = 0
        setSwipeX(0)
        return
      }
    }

    if (touchSwipeAxis.current !== 'horizontal') return

    e.preventDefault()
    isSwiping.current = true
    setIsSwipingActive(true)
    const nextDeltaX = Math.min(0, deltaX)
    touchDeltaX.current = nextDeltaX
    setSwipeX(nextDeltaX)
  }, [])

  const handleSidebarTouchEnd = useCallback(() => {
    if (touchSwipeAxis.current === 'horizontal' && isSwiping.current && touchDeltaX.current < -SIDEBAR_SWIPE_CLOSE_PX) {
      onClose()
    }
    touchSwipeAxis.current = 'pending'
    isSwiping.current = false
    setIsSwipingActive(false)
    touchDeltaX.current = 0
    setSwipeX(0)
  }, [onClose])

  if (isOverlay) {
    if (mobileInline) {
      return (
        <>
          <div className="sidebar-surface relative flex h-full w-full flex-col overflow-hidden [contain:strict]">
            <SidePanel
              onNewSession={onNewSession}
              onSelectSession={handleSelectSession}
              onCloseMobile={onClose}
              selectedSessionId={selectedSessionId}
              onAddProject={openProjectDialog}
              isMobile={true}
              isExpanded={true}
              onOpenSettings={onOpenSettings}
              onOpenNotifications={onOpenNotifications}
              onOpenSearch={onOpenSearch}
              onOpenPlugins={onOpenPlugins}
              onOpenTasks={onOpenTasks}
              onExpandSidebar={onOpen}
              activeNavigation={activeNavigation}
            />
          </div>

          <ProjectDialog
            key={`mobile-${projectDialogKey}-${Number(isProjectDialogVisible)}`}
            isOpen={isProjectDialogVisible}
            onClose={closeProjectDialog}
            onSelect={handleAddProject}
            initialPath={pathInfo?.home}
          />
        </>
      )
    }

    return (
      <>
        <div
          className={`
            fixed left-0 right-0 bg-[hsl(var(--always-black)/0.4)] z-30
            transition-opacity duration-300
            ${isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}
          `}
          style={{ top: 'calc(var(--safe-area-inset-top) + var(--desktop-titlebar-height, 0px))', height: 'calc(100% - var(--safe-area-inset-top) - var(--desktop-titlebar-height, 0px))' }}
          onClick={handleBackdropClick}
        />

        <div
          onTouchStart={handleSidebarTouchStart}
          onTouchMove={handleSidebarTouchMove}
          onTouchEnd={handleSidebarTouchEnd}
          onTouchCancel={handleSidebarTouchEnd}
          className={`
            fixed left-0 z-40
            flex flex-col sidebar-surface shadow-lg
            ${isSwipingActive ? '' : 'transition-transform duration-300 ease-out'}
            ${isOpen ? 'translate-x-0' : '-translate-x-full'}
          `}
          style={{
            width: `${layout.sidebar.overlayWidth}px`,
            transform: isOpen ? `translateX(${Math.min(0, swipeX)}px)` : 'translateX(-100%)',
            top: 'calc(var(--safe-area-inset-top) + var(--desktop-titlebar-height, 0px))',
            height: 'calc(100% - var(--safe-area-inset-top) - var(--desktop-titlebar-height, 0px))',
          }}
        >
          <SidePanel
            onNewSession={onNewSession}
            onSelectSession={handleSelectSession}
            onCloseMobile={onClose}
            selectedSessionId={selectedSessionId}
            onAddProject={openProjectDialog}
            isMobile={true}
            isExpanded={true}
            onOpenSettings={onOpenSettings}
            onOpenNotifications={onOpenNotifications}
            onOpenSearch={onOpenSearch}
            onOpenPlugins={onOpenPlugins}
            onOpenTasks={onOpenTasks}
            onExpandSidebar={onOpen}
            activeNavigation={activeNavigation}
          />
        </div>

        <ProjectDialog
          key={`mobile-${projectDialogKey}-${Number(isProjectDialogVisible)}`}
          isOpen={isProjectDialogVisible}
          onClose={closeProjectDialog}
          onSelect={handleAddProject}
          initialPath={pathInfo?.home}
        />
      </>
    )
  }

  return (
    <>
      <div
        ref={sidebarRef}
        style={{ width: `${previewMode ? layout.sidebar.openWidth : layout.sidebar.dockedWidth}px` }}
        className={`
          sidebar-surface relative flex flex-col h-full overflow-hidden shrink-0 min-w-0
          ${previewMode ? 'shadow-xl shadow-black/10' : ''}
          ${isResizing ? 'transition-none' : 'transition-[width] duration-300 ease-out'}
        `}
      >
        <SidePanel
          onNewSession={onNewSession}
          onSelectSession={onSelectSession}
          onCloseMobile={onClose}
          selectedSessionId={selectedSessionId}
          onAddProject={openProjectDialog}
          isMobile={false}
          isExpanded={isOpen}
          onOpenSettings={onOpenSettings}
          onOpenNotifications={onOpenNotifications}
          onOpenSearch={onOpenSearch}
          onOpenPlugins={onOpenPlugins}
          onOpenTasks={onOpenTasks}
          onExpandSidebar={onOpen}
          activeNavigation={activeNavigation}
        />

        {isOpen && !previewMode && (
          <div
            className={`
              absolute top-0 right-0 h-full cursor-col-resize z-50 touch-none bg-transparent
              ${touchCapable ? 'w-4' : 'w-1'}
            `}
            onMouseDown={startResizing}
            onTouchStart={startTouchResizing}
          >
            <div
              aria-hidden="true"
              className={`absolute top-0 bottom-0 right-0 transition-colors ${touchCapable ? 'w-1 rounded-full' : 'w-full'} ${
                isResizing ? 'bg-accent-main-100' : 'bg-transparent hover:bg-accent-main-100/50'
              }`}
            />
          </div>
        )}
      </div>

      <ProjectDialog
        key={`desktop-${projectDialogKey}-${Number(isProjectDialogVisible)}`}
        isOpen={isProjectDialogVisible}
        onClose={closeProjectDialog}
        onSelect={handleAddProject}
        initialPath={pathInfo?.home}
      />
    </>
  )
})
