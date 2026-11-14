import { useEffect } from 'react'
import { useTheme } from '../hooks/useTheme'
import { usesCustomDesktopTitlebar } from '../utils/platform'

/**
 * Syncs the native window chrome with the app theme.
 *
 * Desktop chrome no longer has a titlebar row to render: macOS keeps its traffic lights and Windows
 * overlays native caption buttons on the content, so this component only forwards the theme.
 */
export function DesktopTitlebar() {
  const { mode } = useTheme()
  const isDesktopChrome = usesCustomDesktopTitlebar()

  useEffect(() => {
    if (!isDesktopChrome) return
    if (typeof window.customOpenCode?.windowSetTheme !== 'function') return
    void window.customOpenCode.windowSetTheme(mode)
  }, [isDesktopChrome, mode])

  return null
}
