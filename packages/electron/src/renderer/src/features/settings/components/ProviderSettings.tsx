import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  disposeInstance,
  getProviderAuthKey,
  getProviderAuthMethods,
  getProviders,
  removeProviderAuth,
  setProviderAuth,
  type ProviderListResult,
} from '../../../api'
import { CheckIcon, CopyIcon, KeyIcon, RetryIcon, SearchIcon, TrashIcon } from '../../../components/Icons'
import { Button } from '../../../components/ui/Button'
import { refreshModels } from '../../../hooks/useModels'
import { useServerStore } from '../../../hooks'
import { clipboardErrorHandler, copyTextToClipboard } from '../../../utils'
import { settingsSearchInputClass, SettingsCard, SettingsSection, Toggle } from './SettingsUI'
import type { Provider, ProviderAuthMethod } from '@opencode-ai/sdk/v2/client'

type AuthPrompt = NonNullable<ProviderAuthMethod['prompts']>[number]

function providerModelCount(provider: Provider) {
  return Object.keys(provider.models ?? {}).length
}

function getApiMethod(methods: ProviderAuthMethod[] | undefined) {
  return methods?.find(method => method.type === 'api') ?? (!methods ? { type: 'api' as const, label: 'API key' } : undefined)
}

function promptVisible(prompt: AuthPrompt, values: Record<string, string>) {
  if (!prompt.when) return true
  const value = values[prompt.when.key] ?? ''
  if (prompt.when.op === 'eq') return value === prompt.when.value
  return value !== prompt.when.value
}

function promptDefaultValue(prompt: AuthPrompt) {
  if (prompt.type !== 'select') return ''
  return prompt.options[0]?.value ?? ''
}

export function ProviderSettings() {
  const { t } = useTranslation(['settings', 'common'])
  const { activeServer } = useServerStore()
  const localServer = !activeServer || activeServer.id === 'local'
  const [query, setQuery] = useState('')
  const [configuredOnly, setConfiguredOnly] = useState(false)
  const [providersResult, setProvidersResult] = useState<ProviderListResult | null>(null)
  const [authMethods, setAuthMethods] = useState<Record<string, ProviderAuthMethod[]>>({})
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [promptValues, setPromptValues] = useState<Record<string, Record<string, string>>>({})
  const [busyProvider, setBusyProvider] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savedProvider, setSavedProvider] = useState<string | null>(null)
  const [copiedProvider, setCopiedProvider] = useState<string | null>(null)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    }
  }, [])

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const [providers, methods] = await Promise.all([getProviders(), getProviderAuthMethods()])
      setProvidersResult(providers)
      setAuthMethods(methods)
      setPromptValues(current =>
        Object.fromEntries(
          providers.all.map(provider => {
            const apiMethod = getApiMethod(methods[provider.id])
            const currentValues = current[provider.id] ?? {}
            return [
              provider.id,
              Object.fromEntries(
                (apiMethod?.prompts ?? []).map(prompt => [
                  prompt.key,
                  currentValues[prompt.key] ?? promptDefaultValue(prompt),
                ]),
              ),
            ]
          }),
        ),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : t('providers.loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const connected = useMemo(() => new Set(providersResult?.connected ?? []), [providersResult])
  const providers = useMemo(() => providersResult?.all ?? [], [providersResult])
  const filteredProviders = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return providers
      .filter(provider => {
        if (configuredOnly && !connected.has(provider.id)) return false
        if (!normalizedQuery) return true
        const haystack = `${provider.id} ${provider.name} ${provider.source}`.toLowerCase()
        return haystack.includes(normalizedQuery)
      })
      .toSorted(
        (a, b) =>
          (a.name || a.id).localeCompare(b.name || b.id, undefined, { sensitivity: 'base', numeric: true }) ||
          a.id.localeCompare(b.id, undefined, { sensitivity: 'base', numeric: true }),
      )
  }, [configuredOnly, connected, providers, query])

  const save = async (provider: Provider) => {
    const key = apiKeys[provider.id]?.trim() ?? ''
    if (!key) {
      setError(t('providers.apiKeyRequired'))
      return
    }

    const apiMethod = getApiMethod(authMethods[provider.id])
    const metadata = Object.fromEntries(
      (apiMethod?.prompts ?? [])
        .filter(prompt => promptVisible(prompt, promptValues[provider.id] ?? {}))
        .map(prompt => [prompt.key, promptValues[provider.id]?.[prompt.key]?.trim() ?? ''])
        .filter((entry): entry is [string, string] => !!entry[1]),
    )

    setBusyProvider(provider.id)
    setError(null)
    setSavedProvider(null)
    setCopiedProvider(null)
    try {
      await setProviderAuth(provider.id, {
        type: 'api',
        key,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      })
      await disposeInstance()
      setApiKeys(current => ({ ...current, [provider.id]: '' }))
      setSavedProvider(provider.id)
      await load()
      await refreshModels()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('providers.saveFailed'))
    } finally {
      setBusyProvider(null)
    }
  }

  const copyKey = async (provider: Provider) => {
    setError(null)
    try {
      const key = await getProviderAuthKey(provider.id)
      if (!key) {
        setError(t('providers.copyKeyUnavailable'))
        return
      }
      await copyTextToClipboard(key)
      setCopiedProvider(provider.id)
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = setTimeout(() => setCopiedProvider(null), 2000)
    } catch (err) {
      clipboardErrorHandler('copy provider api key', err)
    }
  }

  const disconnect = async (provider: Provider) => {
    setBusyProvider(provider.id)
    setError(null)
    setSavedProvider(null)
    setCopiedProvider(null)
    try {
      await removeProviderAuth(provider.id)
      await disposeInstance()
      await load()
      await refreshModels()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('providers.disconnectFailed'))
    } finally {
      setBusyProvider(null)
    }
  }

  return (
    <div>
      <SettingsSection title={t('providers.title')}>
        <p className="text-[length:var(--fs-sm)] text-text-400 leading-relaxed">{t('providers.desc')}</p>

        <div className="relative">
          <SearchIcon size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-400" />
          <input
            type="text"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('providers.searchPlaceholder')}
            spellCheck={false}
            autoCorrect="off"
            autoComplete="off"
            autoCapitalize="off"
            className={settingsSearchInputClass}
          />
          <button
            type="button"
            onClick={() => void load()}
            className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-text-400 transition-colors hover:bg-bg-200/60 hover:text-text-100"
            aria-label={t('providers.refresh')}
          >
            <RetryIcon size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border-200/45 bg-bg-100/35 px-3 py-2">
          <div className="min-w-0">
            <div className="text-[length:var(--fs-sm)] font-medium text-text-200">{t('providers.configuredOnly')}</div>
            <div className="text-[length:var(--fs-xs)] text-text-500">{t('providers.configuredOnlyDesc')}</div>
          </div>
          <Toggle
            enabled={configuredOnly}
            onChange={() => setConfiguredOnly(value => !value)}
            ariaLabel={t('providers.configuredOnly')}
          />
        </div>

        {error && (
          <div className="rounded-lg border border-danger-100/25 bg-danger-100/10 px-3 py-2 text-[length:var(--fs-sm)] text-danger-100">
            {error}
          </div>
        )}

        {loading && !providersResult ? (
          <div className="py-8 text-[length:var(--fs-sm)] text-text-400">{t('providers.loading')}</div>
        ) : filteredProviders.length === 0 ? (
          <div className="py-8 text-[length:var(--fs-sm)] text-text-400">
            {query || configuredOnly ? t('providers.noResults') : t('providers.empty')}
          </div>
        ) : (
          <div className="space-y-3">
            {filteredProviders.map(provider => {
              const isConnected = connected.has(provider.id)
              const apiMethod = getApiMethod(authMethods[provider.id])
              const values = promptValues[provider.id] ?? {}
              const prompts = (apiMethod?.prompts ?? []).filter(prompt => promptVisible(prompt, values))
              const busy = busyProvider === provider.id

              return (
                <SettingsCard
                  key={provider.id}
                  title={provider.name || provider.id}
                  description={t('providers.providerMeta', {
                    id: provider.id,
                    count: providerModelCount(provider),
                  })}
                  actions={
                    <span
                      className={`rounded-full px-2 py-0.5 text-[length:var(--fs-xxs)] font-medium ${
                        isConnected
                          ? 'bg-success-bg text-success-100'
                          : 'bg-bg-200/70 text-text-400'
                      }`}
                    >
                      {isConnected ? t('providers.connected') : t('providers.notConnected')}
                    </span>
                  }
                >
                  {apiMethod ? (
                    <div className="space-y-3">
                      <label className="block">
                        <span className="mb-1 block text-[length:var(--fs-xs)] font-medium text-text-300">
                          {t('providers.apiKey')}
                        </span>
                        <div className="flex items-center gap-2 rounded-lg border border-border-200 bg-bg-000 px-3 transition-colors focus-within:border-accent-main-100/50">
                          <KeyIcon size={14} className="shrink-0 text-text-400" />
                          <input
                            type="password"
                            value={apiKeys[provider.id] ?? ''}
                            onChange={event => {
                              setApiKeys(current => ({ ...current, [provider.id]: event.target.value }))
                              setError(null)
                              setSavedProvider(null)
                              setCopiedProvider(null)
                            }}
                            placeholder={isConnected ? t('providers.apiKeyConnectedPlaceholder') : t('providers.apiKeyPlaceholder')}
                            className="h-9 min-w-0 flex-1 bg-transparent text-[length:var(--fs-md)] text-text-100 outline-none placeholder:text-text-400 focus-visible:outline-none"
                            autoComplete="off"
                          />
                        </div>
                      </label>

                      {prompts.map(prompt => (
                        <label key={prompt.key} className="block">
                          <span className="mb-1 block text-[length:var(--fs-xs)] font-medium text-text-300">
                            {prompt.message}
                          </span>
                          {prompt.type === 'select' ? (
                            <select
                              value={values[prompt.key] ?? promptDefaultValue(prompt)}
                              onChange={event =>
                                setPromptValues(current => ({
                                  ...current,
                                  [provider.id]: { ...(current[provider.id] ?? {}), [prompt.key]: event.target.value },
                                }))
                              }
                              className="h-9 w-full rounded-lg border border-border-200 bg-bg-000 px-3 text-[length:var(--fs-md)] text-text-100 outline-none focus:border-accent-main-100/50"
                            >
                              {prompt.options.map(option => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type="text"
                              value={values[prompt.key] ?? ''}
                              onChange={event =>
                                setPromptValues(current => ({
                                  ...current,
                                  [provider.id]: { ...(current[provider.id] ?? {}), [prompt.key]: event.target.value },
                                }))
                              }
                              placeholder={prompt.placeholder}
                              className="h-9 w-full rounded-lg border border-border-200 bg-bg-000 px-3 text-[length:var(--fs-md)] text-text-100 outline-none placeholder:text-text-400 focus:border-accent-main-100/50"
                            />
                          )}
                        </label>
                      ))}

                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 text-[length:var(--fs-xs)] text-text-400">
                          {savedProvider === provider.id ? t('providers.saved') : t('providers.saveHint')}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {isConnected && (
                            <>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                isLoading={busy}
                                onClick={() => void disconnect(provider)}
                                className="text-danger-100 hover:text-danger-100"
                              >
                                <TrashIcon size={13} />
                                {t('providers.disconnect')}
                              </Button>
                              <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                disabled={!localServer}
                                title={!localServer ? t('providers.copyKeyRemoteUnsupported') : undefined}
                                onClick={() => void copyKey(provider)}
                              >
                                {copiedProvider === provider.id ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                                {copiedProvider === provider.id ? t('common:copied') : t('common:copy')}
                              </Button>
                            </>
                          )}
                          <Button type="button" size="sm" isLoading={busy} onClick={() => void save(provider)}>
                            {t('common:save')}
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-lg border border-border-200/60 bg-bg-100/45 px-3 py-2 text-[length:var(--fs-sm)] text-text-400">
                      {t('providers.apiUnsupported')}
                    </div>
                  )}
                </SettingsCard>
              )
            })}
          </div>
        )}
      </SettingsSection>
    </div>
  )
}
