import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { CloseIcon, CopyIcon, MinusIcon, WindowMaximizeIcon } from './Icons'

/**
 * Windows window controls, drawn by the renderer so they match the app's own icons and hover states.
 * The window itself is frameless (titleBarStyle: "hidden"); these buttons float over the top-right corner.
 */
export function ElectronWindowControls() {
  const { t } = useTranslation('common')
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    let disposed = false
    void window.customOpenCode.windowIsMaximized().then((maximized) => {
      if (!disposed) setIsMaximized(maximized)
    })
    const unsubscribe = window.customOpenCode.onWindowMaximizeChange(setIsMaximized)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  const handleMinimize = useCallback(() => {
    void window.customOpenCode.windowMinimize()
  }, [])

  const handleMaximizeToggle = useCallback(() => {
    void window.customOpenCode.windowMaximize()
  }, [])

  const handleClose = useCallback(() => {
    void window.customOpenCode.windowClose()
  }, [])

  return createPortal(
    <div className="electron-window-controls window-no-drag">
      <button
        type="button"
        onClick={handleMinimize}
        title={t('minimize')}
        aria-label={t('minimize')}
        className="electron-window-control"
      >
        <span className="electron-window-control-glyph">
          <MinusIcon size={18} />
        </span>
      </button>
      <button
        type="button"
        onClick={handleMaximizeToggle}
        title={isMaximized ? t('restore') : t('maximize')}
        aria-label={isMaximized ? t('restore') : t('maximize')}
        className="electron-window-control"
      >
        <span className="electron-window-control-glyph">
          {isMaximized ? <CopyIcon size={18} /> : <WindowMaximizeIcon size={18} />}
        </span>
      </button>
      <button
        type="button"
        onClick={handleClose}
        title={t('close')}
        aria-label={t('close')}
        className="electron-window-control electron-window-control-close"
      >
        <span className="electron-window-control-glyph">
          <CloseIcon size={18} />
        </span>
      </button>
    </div>,
    document.body,
  )
}
