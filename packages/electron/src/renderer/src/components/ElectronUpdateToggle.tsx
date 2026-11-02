import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { QuestionIcon } from './Icons'
import { UpdatePanel } from '../features/chat/sidebar/UpdatePanel'
import { hasUpdateAvailable, updaterHasNewVersion, updaterReadyToInstall, useUpdateStore } from '../store/updateStore'

interface ElectronUpdateToggleProps {
  /** `titlebar` participates in the Windows titlebar's inline icon row. */
  variant?: 'floating' | 'titlebar'
}

// 顶部条带的软件更新入口：原位于左下角底部栏，随布局调整移到历史导航之后。
// 弹窗在按钮下方展开（UpdatePanel placement="down"）。
export function ElectronUpdateToggle({ variant = 'floating' }: ElectronUpdateToggleProps) {
  const { t } = useTranslation(['chat', 'common'])
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [isVisible, setIsVisible] = useState(false)
  const [panelPos, setPanelPos] = useState({ top: 0, left: 0, width: 340 })
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const updateState = useUpdateStore()
  const newVersionFound = updaterHasNewVersion(updateState) || hasUpdateAvailable(updateState)
  const readyToInstall = updaterReadyToInstall(updateState)
  const updateVersion = updateState.updater.version ?? updateState.latestRelease?.version ?? null
  const updateTooltip = readyToInstall
    ? t('sidebar.update.downloaded')
    : newVersionFound
      ? `${t('sidebar.update.available')}${updateVersion ? ` v${updateVersion}` : ''}`
      : t('sidebar.update.title')

  const openPanel = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    setPanelPos({ top: rect.bottom + 8, left: Math.max(8, rect.left - 8), width: 340 })
    setIsOpen(true)
    requestAnimationFrame(() => setIsVisible(true))
  }, [])

  const closePanel = useCallback(() => {
    setIsVisible(false)
    if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current)
    closeTimerRef.current = setTimeout(() => setIsOpen(false), 150)
  }, [])

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!isOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (buttonRef.current?.contains(target)) return
      if (panelRef.current?.contains(target)) return
      closePanel()
    }
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePanel()
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [isOpen, closePanel])

  const button = (
    <button
      ref={buttonRef}
      type="button"
      onClick={isOpen ? closePanel : openPanel}
      aria-label={updateTooltip}
      title={updateTooltip}
      className={
        variant === 'titlebar'
          ? `electron-windows-titlebar-btn window-no-drag relative ${readyToInstall ? 'text-success-100' : ''}`
          : `electron-update-toggle window-no-drag ${readyToInstall ? 'text-success-100' : ''}`
      }
    >
      <QuestionIcon size={variant === 'titlebar' ? 18 : 16} />
      {!readyToInstall && newVersionFound && <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-danger-100" />}
    </button>
  )

  const panel = isOpen ? (
    <UpdatePanel ref={panelRef} position={panelPos} visible={isVisible} onClose={closePanel} placement="down" />
  ) : null

  // The floating variant is fixed-positioned by its own CSS; the titlebar variant renders inline
  // and only portals the dropdown.
  if (variant === 'titlebar') {
    return (
      <>
        {button}
        {panel ? createPortal(panel, document.body) : null}
      </>
    )
  }

  return createPortal(
    <>
      {button}
      {panel}
    </>,
    document.body,
  )
}
