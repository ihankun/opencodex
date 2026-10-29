import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircleIcon, ExternalLinkIcon } from '../../components/Icons'
import { Button, Dialog } from '../../components/ui'

interface FreeLimitDialogProps {
  isOpen: boolean
  resetAt?: number
  onClose: () => void
  onSwitchModel: () => void
  onSubscribe: () => void
  onDontShow: () => void
}

export function FreeLimitDialog({
  isOpen,
  resetAt,
  onClose,
  onSwitchModel,
  onSubscribe,
  onDontShow,
}: FreeLimitDialogProps) {
  const { t, i18n } = useTranslation('chat')
  const reset = useMemo(() => {
    if (!resetAt || !Number.isFinite(resetAt)) return undefined
    return new Intl.DateTimeFormat(i18n.language || 'zh-CN', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(resetAt)
  }, [resetAt, i18n.language])

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={t('freeLimit.title')} width={440}>
      <div className="space-y-4">
        <div className="flex gap-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-warning-100/10 text-warning-100">
            <AlertCircleIcon size={18} />
          </div>
          <p className="text-[length:var(--fs-sm)] leading-6 text-text-300">
            {reset ? t('freeLimit.descriptionReset', { time: reset }) : t('freeLimit.description')}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Button onClick={onSwitchModel}>{t('freeLimit.switchModel')}</Button>
          <Button variant="secondary" onClick={onSubscribe}>
            {t('freeLimit.subscribe')}
            <ExternalLinkIcon size={14} />
          </Button>
        </div>

        <div className="flex items-center justify-between border-t border-border-100/60 pt-3">
          <button
            type="button"
            onClick={onDontShow}
            className="text-[length:var(--fs-xs)] text-text-400 underline-offset-2 transition-colors hover:text-text-200 hover:underline"
          >
            {t('freeLimit.dontShow')}
          </button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('freeLimit.dismiss')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
