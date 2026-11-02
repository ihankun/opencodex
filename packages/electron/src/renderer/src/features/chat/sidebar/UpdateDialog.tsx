import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/Button'
import { Dialog } from '../../../components/ui/Dialog'
import { DownloadIcon, ExternalLinkIcon, RetryIcon, SpinnerIcon } from '../../../components/Icons'
import { RELEASES_PAGE_URL, hasUpdateAvailable, updaterHasNewVersion, updateStore, useUpdateStore } from '../../../store/updateStore'
import { openUrl } from '../../../utils/browserOpen'

export function UpdateDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { t } = useTranslation(['chat', 'common'])
  const updateState = useUpdateStore()
  const updater = updateState.updater
  const latestRelease = updateState.latestRelease
  const version = updater.version ?? latestRelease?.version ?? null
  const notes = updater.releaseNotes ?? latestRelease?.body ?? null
  const updateAvailable = updaterHasNewVersion(updateState) || hasUpdateAvailable(updateState)
  const percent = updater.progress?.percent

  useEffect(() => {
    if (isOpen) void updateStore.checkForUpdates()
  }, [isOpen])

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={t('sidebar.update.title')} width={420}>
      <div className="space-y-3">
        {updater.status === 'checking' && (
          <div className="flex items-center gap-2 text-[length:var(--fs-sm)] text-text-300">
            <SpinnerIcon size={14} className="animate-spin" />
            {t('sidebar.update.checking')}
          </div>
        )}

        {updater.status === 'available' && version && (
          <div className="text-[length:var(--fs-sm)] text-text-200">
            {t('sidebar.update.newVersion')} <span className="font-semibold text-text-100">v{version}</span>
          </div>
        )}

        {(updater.status === 'downloading' || updater.status === 'downloaded') && version && (
          <div className="space-y-1">
            <div className="text-[length:var(--fs-sm)] text-text-200">
              {t('sidebar.update.newVersion')} <span className="font-semibold text-text-100">v{version}</span>
            </div>
            {updater.status === 'downloading' ? (
              <>
                <div className="h-1.5 overflow-hidden rounded-full bg-bg-300/80">
                  <div
                    className="h-full rounded-full bg-accent-main-100 transition-[width] duration-300"
                    style={{ width: `${Math.max(0, Math.min(100, percent ?? 0))}%` }}
                  />
                </div>
                <div className="text-[length:var(--fs-xs)] text-text-400">
                  {t('sidebar.update.downloading', { percent: Math.round(percent ?? 0) })}
                </div>
              </>
            ) : (
              <div className="text-[length:var(--fs-xs)] font-medium text-success-100">
                {t('sidebar.update.downloaded')}
              </div>
            )}
          </div>
        )}

        {updater.status === 'error' && (
          <div className="text-[length:var(--fs-xs)] leading-relaxed text-danger-100">
            {t('sidebar.update.error', { error: updater.error ?? '' })}
          </div>
        )}

        {updater.status === 'not-available' && (
          <div className="text-[length:var(--fs-sm)] text-text-300">{t('sidebar.update.upToDate')}</div>
        )}

        {updater.status === 'idle' && (
          <div className="text-[length:var(--fs-sm)] text-text-300">
            {updateAvailable ? t('sidebar.update.available') : t('sidebar.update.upToDate')}
          </div>
        )}

        {notes && (
          <div>
            <div className="mb-1 text-[length:var(--fs-xxs)] font-semibold uppercase tracking-wide text-text-400">
              {t('sidebar.update.releaseNotes')}
            </div>
            <div className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border-200/40 bg-bg-000/40 p-2 text-[length:var(--fs-xs)] leading-relaxed text-text-300">
              {notes}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {updater.status === 'available' && version && (
            <Button size="sm" onClick={() => updateStore.downloadUpdate()}>
              <DownloadIcon size={12} />
              {t('sidebar.update.download')}
            </Button>
          )}
          {updater.status === 'downloaded' && (
            <Button size="sm" onClick={() => updateStore.installUpdate()}>
              <DownloadIcon size={12} />
              {t('sidebar.update.restartAndInstall')}
            </Button>
          )}
          {updater.status === 'error' && (
            <Button size="sm" variant="secondary" onClick={() => updateStore.retryUpdaterCheck()}>
              <RetryIcon size={12} />
              {t('sidebar.update.retry')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => void openUrl(RELEASES_PAGE_URL, 'system')}>
            <ExternalLinkIcon size={12} />
            {t('sidebar.update.viewReleasePage')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
