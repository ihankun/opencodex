import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getProviders } from '../../../api'
import { GripVerticalIcon } from '../../../components/Icons'
import { useServerStore } from '../../../hooks'
import { uiErrorHandler } from '../../../utils'
import { desktopPreferencesStore, useDesktopPreferences } from '../../../store/desktopPreferencesStore'
import { SettingsSection, Toggle } from './SettingsUI'
import { canonicalQuotaProviderId, supportsQuotaProvider, type OpenCodeGoQuotaConfig } from '../../../../../shared/quota'
import type { Provider } from '@opencode/client'

export function QuotaSettings() {
  const { t } = useTranslation(['settings'])
  const preferences = useDesktopPreferences()
  const { activeServer } = useServerStore()
  const [providers, setProviders] = useState<Provider[]>([])
  const [loading, setLoading] = useState(true)
  const [draggingId, setDraggingId] = useState<string>()
  const [openCodeGoConfig, setOpenCodeGoConfig] = useState<OpenCodeGoQuotaConfig>()
  const [openCodeGoApiKey, setOpenCodeGoApiKey] = useState('')
  const [openCodeGoSaving, setOpenCodeGoSaving] = useState(false)
  const [openCodeGoNotice, setOpenCodeGoNotice] = useState<{ kind: 'success' | 'error'; message: string }>()

  useEffect(() => {
    void getProviders()
      .then(value => {
        const connected = new Set(value.connected)
        setProviders(value.all.filter(provider => connected.has(provider.id)))
      })
      .catch(error => uiErrorHandler('load quota providers', error))
      .finally(() => setLoading(false))
  }, [activeServer?.id])

  useEffect(() => {
    if (!window.customOpenCode?.openCodeGoQuotaConfig) return
    void window.customOpenCode.openCodeGoQuotaConfig()
      .then(config => setOpenCodeGoConfig(config))
      .catch(error => uiErrorHandler('load OpenCode Go quota config', error))
  }, [])

  const ordered = useMemo(() => {
    const positions = new Map(preferences.quotaProviders.map((item, index) => [item.id, index]))
    return providers.toSorted((left, right) => {
      const leftIndex = positions.get(left.id)
      const rightIndex = positions.get(right.id)
      if (leftIndex !== undefined || rightIndex !== undefined) {
        if (leftIndex === undefined) return 1
        if (rightIndex === undefined) return -1
        return leftIndex - rightIndex
      }
      return (left.name || left.id).localeCompare(right.name || right.id, undefined, { numeric: true })
    })
  }, [preferences.quotaProviders, providers])

  const saveVisibleOrder = (visible: Array<{ id: string; enabled: boolean }>) => {
    const visibleIds = new Set(visible.map(item => item.id))
    void desktopPreferencesStore.update({
      quotaProviders: [
        ...visible,
        ...preferences.quotaProviders.filter(item => !visibleIds.has(item.id)),
      ],
    }).catch(error => uiErrorHandler('update quota provider preferences', error))
  }

  const toggle = (providerId: string) => {
    saveVisibleOrder(ordered.map(provider => ({
      id: provider.id,
      enabled: provider.id === providerId
        ? !(preferences.quotaProviders.find(item => item.id === provider.id)?.enabled ?? false)
        : (preferences.quotaProviders.find(item => item.id === provider.id)?.enabled ?? false),
    })))
  }

  const moveBefore = (targetId: string) => {
    if (!draggingId || draggingId === targetId) return
    const next = ordered.map(provider => ({
      id: provider.id,
      enabled: preferences.quotaProviders.find(item => item.id === provider.id)?.enabled ?? false,
    }))
    const sourceIndex = next.findIndex(item => item.id === draggingId)
    const targetIndex = next.findIndex(item => item.id === targetId)
    if (sourceIndex < 0 || targetIndex < 0) return
    const [moved] = next.splice(sourceIndex, 1)
    next.splice(targetIndex, 0, moved)
    saveVisibleOrder(next)
  }

  const saveOpenCodeGoConfig = () => {
    if (!window.customOpenCode?.updateOpenCodeGoQuotaConfig) return
    if (!openCodeGoApiKey.trim()) {
      setOpenCodeGoNotice({ kind: 'error', message: t('general.openCodeGoApiKeyRequired') })
      return
    }
    setOpenCodeGoSaving(true)
    setOpenCodeGoNotice(undefined)
    void window.customOpenCode.updateOpenCodeGoQuotaConfig({
      apiKey: openCodeGoApiKey,
    })
      .then(config => {
        setOpenCodeGoConfig(config)
        setOpenCodeGoApiKey('')
        setOpenCodeGoNotice({ kind: 'success', message: t('general.openCodeGoSaved') })
      })
      .catch(error => {
        uiErrorHandler('save OpenCode Go quota config', error)
        setOpenCodeGoNotice({ kind: 'error', message: t('general.openCodeGoSaveFailed') })
      })
      .finally(() => setOpenCodeGoSaving(false))
  }

  const clearOpenCodeGoApiKey = () => {
    if (!window.customOpenCode?.updateOpenCodeGoQuotaConfig) return
    setOpenCodeGoSaving(true)
    setOpenCodeGoNotice(undefined)
    void window.customOpenCode.updateOpenCodeGoQuotaConfig({
      clearApiKey: true,
    })
      .then(config => {
        setOpenCodeGoConfig(config)
        setOpenCodeGoApiKey('')
        setOpenCodeGoNotice({ kind: 'success', message: t('general.openCodeGoDisconnected') })
      })
      .catch(error => {
        uiErrorHandler('clear OpenCode Go quota API key', error)
        setOpenCodeGoNotice({ kind: 'error', message: t('general.openCodeGoSaveFailed') })
      })
      .finally(() => setOpenCodeGoSaving(false))
  }

  const localServer = !activeServer || activeServer.id === 'local'
  const openCodeGoManagedByEnvironment = openCodeGoConfig?.source === 'environment'

  return (
    <SettingsSection title={t('general.quotaDisplay')}>
      <p className="-mt-2 text-[length:var(--fs-sm)] leading-relaxed text-text-400">
        {t('general.quotaDisplayDesc')}
      </p>
      {loading ? (
        <div className="py-3 text-[length:var(--fs-sm)] text-text-400">{t('general.quotaLoading')}</div>
      ) : ordered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-200 px-3 py-5 text-center text-[length:var(--fs-sm)] text-text-400">
          {t('general.quotaEmpty')}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border-200/55 bg-bg-050/35">
          {ordered.map(provider => {
            const supported = supportsQuotaProvider(provider.id)
            const enabled = preferences.quotaProviders.find(item => item.id === provider.id)?.enabled ?? false
            const openCodeGo = canonicalQuotaProviderId(provider.id) === 'opencode-go'
            return (
              <div
                key={provider.id}
                onDragOver={event => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                }}
                onDrop={event => {
                  event.preventDefault()
                  moveBefore(provider.id)
                  setDraggingId(undefined)
                }}
                className={`border-b border-border-200/40 last:border-b-0 ${draggingId === provider.id ? 'opacity-45' : ''}`}
              >
                <div className="flex items-center gap-3 px-3 py-3">
                  <span
                    draggable
                    onDragStart={event => {
                      setDraggingId(provider.id)
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData('text/plain', provider.id)
                    }}
                    onDragEnd={() => setDraggingId(undefined)}
                    className="shrink-0 cursor-grab text-text-500 active:cursor-grabbing"
                    title={t('general.quotaDrag')}
                  >
                    <GripVerticalIcon size={15} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[length:var(--fs-md)] font-medium text-text-100">
                      {provider.name || provider.id}
                    </div>
                    <div className="truncate text-[length:var(--fs-xs)] text-text-500">{provider.id}</div>
                  </div>
                  {supported ? (
                    <div className="flex items-center gap-2.5">
                      <span className="text-[length:var(--fs-xs)] text-text-300">{t('general.showQuota')}</span>
                      <Toggle
                        enabled={enabled}
                        onChange={() => toggle(provider.id)}
                        ariaLabel={`${provider.name || provider.id} ${t('general.showQuota')}`}
                      />
                    </div>
                  ) : (
                    <span className="text-[length:var(--fs-xs)] text-danger-100">
                      {t('general.quotaUnsupported')}
                    </span>
                  )}
                </div>
                {openCodeGo && openCodeGoConfig?.source !== 'auth-file' && (
                  <div className="mx-3 mb-3 rounded-lg border border-border-200/45 bg-bg-100/45 p-3">
                    <div className="text-[length:var(--fs-sm)] font-medium text-text-100">
                      {t('general.openCodeGoSetup')}
                    </div>
                    <p className="mt-1 text-[length:var(--fs-xs)] leading-relaxed text-text-400">
                      {t('general.openCodeGoSetupDesc')}
                    </p>
                    {openCodeGoConfig?.hasApiKey && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="text-[length:var(--fs-xs)] text-text-400">
                          {t('general.openCodeGoConnected')}
                        </span>
                        {openCodeGoConfig.source === 'secure-storage' && (
                          <button
                            type="button"
                            disabled={openCodeGoSaving}
                            onClick={clearOpenCodeGoApiKey}
                            className="h-8 rounded-lg border border-border-200 px-3 text-[length:var(--fs-xs)] text-text-300 hover:bg-bg-200 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {t('general.openCodeGoDisconnect')}
                          </button>
                        )}
                        {openCodeGoNotice && (
                          <span className={`text-[length:var(--fs-xs)] ${openCodeGoNotice.kind === 'error' ? 'text-danger-100' : 'text-success-100'}`}>
                            {openCodeGoNotice.message}
                          </span>
                        )}
                      </div>
                    )}
                    {!openCodeGoManagedByEnvironment && (
                      <div className="mt-3 flex flex-col gap-2 border-t border-border-200/35 pt-2">
                        <label className="grid gap-1.5 text-[length:var(--fs-xs)] text-text-300">
                          <span>{t('general.openCodeGoApiKey')}</span>
                          <input
                            type="password"
                            value={openCodeGoApiKey}
                            disabled={!localServer}
                            onChange={event => {
                              setOpenCodeGoApiKey(event.target.value)
                              setOpenCodeGoNotice(undefined)
                            }}
                            placeholder={openCodeGoConfig?.hasApiKey
                              ? t('general.openCodeGoApiKeySaved')
                              : t('general.openCodeGoApiKeyPlaceholder')}
                            className="h-9 rounded-lg border border-border-200 bg-bg-000 px-2.5 text-[length:var(--fs-sm)] text-text-100 outline-none placeholder:text-text-500 focus:border-accent-main-100 disabled:cursor-not-allowed disabled:opacity-55"
                          />
                        </label>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={!localServer || openCodeGoSaving}
                            onClick={saveOpenCodeGoConfig}
                            className="h-8 rounded-lg border border-border-200 px-3 text-[length:var(--fs-xs)] font-medium text-text-200 hover:bg-bg-200 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {openCodeGoSaving ? t('general.openCodeGoSaving') : t('general.openCodeGoSave')}
                          </button>
                          {!openCodeGoConfig?.hasApiKey && openCodeGoNotice && (
                            <span className={`text-[length:var(--fs-xs)] ${openCodeGoNotice.kind === 'error' ? 'text-danger-100' : 'text-success-100'}`}>
                              {openCodeGoNotice.message}
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                    {!localServer && (
                      <p className="mt-2 text-[length:var(--fs-xs)] text-danger-100">
                        {t('general.openCodeGoRemoteUnsupported')}
                      </p>
                    )}
                    {openCodeGoManagedByEnvironment && (
                      <p className="mt-2 text-[length:var(--fs-xs)] text-text-400">
                        {t('general.openCodeGoManagedByEnvironment')}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </SettingsSection>
  )
}
