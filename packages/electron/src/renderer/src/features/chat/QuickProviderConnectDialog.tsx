import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { Provider, ProviderAuthAuthorization, ProviderAuthMethod } from "../../types/api/legacy-sdk.ts"
import {
  authorizeProviderOAuth,
  completeProviderOAuth,
  disposeInstance,
  getProviderAuthMethods,
  setProviderAuth,
} from '../../api'
import {
  CheckIcon,
  ChevronLeftIcon,
  ExternalLinkIcon,
  KeyIcon,
  SearchIcon,
} from '../../components/Icons'
import { ProviderIcon } from '../../components/ProviderIcon'
import { Button, Dialog } from '../../components/ui'
import { refreshModels } from '../../hooks/useModels'
import { refreshProviders } from '../../api'
import { openUrl } from '../../utils/browserOpen'

type AuthPrompt = NonNullable<ProviderAuthMethod['prompts']>[number]

type QuickProviderConnectDialogProps = {
  isOpen: boolean
  providers: Provider[]
  connected: string[]
  initialProviderID: string | null
  directory?: string
  onClose: () => void
  onConnected: (provider: Provider) => void
  /** 目录刷新成功后由父级重新拉取供应商列表 */
  onProvidersChanged?: () => void
}

export function ProviderMark({ provider, className = 'size-5' }: { provider: Provider; className?: string }) {
  return (
    <ProviderIcon
      id={provider.id}
      role="img"
      aria-label={provider.name || provider.id}
      className={`shrink-0 text-text-300 ${className}`}
    />
  )
}

export function QuickProviderConnectDialog({
  isOpen,
  providers,
  connected,
  initialProviderID,
  directory,
  onClose,
  onConnected,
  onProvidersChanged,
}: QuickProviderConnectDialogProps) {
  const { t } = useTranslation(['chat', 'common'])
  const [selectedProviderID, setSelectedProviderID] = useState<string | null>(initialProviderID)
  const [methodsByProvider, setMethodsByProvider] = useState<Record<string, ProviderAuthMethod[]>>({})
  const [methodIndex, setMethodIndex] = useState<number | null>(null)
  const [promptValues, setPromptValues] = useState<Record<string, string>>({})
  const [apiKey, setApiKey] = useState('')
  const [authorization, setAuthorization] = useState<ProviderAuthAuthorization | null>(null)
  const [oauthCode, setOauthCode] = useState('')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const provider = useMemo(
    () => providers.find(item => item.id === selectedProviderID) ?? null,
    [providers, selectedProviderID],
  )
  const methods = useMemo(() => {
    if (!selectedProviderID) return []
    return methodsByProvider[selectedProviderID] ?? [{ type: 'api' as const, label: t('providerConnect.apiKey') }]
  }, [methodsByProvider, selectedProviderID, t])
  const method = methodIndex === null ? null : methods[methodIndex] ?? null
  const connectedSet = useMemo(() => new Set(connected), [connected])
  const filteredProviders = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return providers
      .filter(item => !normalized || `${item.name} ${item.id}`.toLowerCase().includes(normalized))
      .toSorted((left, right) => {
        const connectedDiff = Number(connectedSet.has(right.id)) - Number(connectedSet.has(left.id))
        if (connectedDiff) return connectedDiff
        return (left.name || left.id).localeCompare(right.name || right.id, undefined, {
          sensitivity: 'base',
          numeric: true,
        })
      })
  }, [connectedSet, providers, query])
  const visiblePrompts = useMemo(
    () => (method?.prompts ?? []).filter(prompt => promptVisible(prompt, promptValues)),
    [method, promptValues],
  )

  useEffect(() => {
    if (!isOpen) return
    setSelectedProviderID(initialProviderID)
    setMethodIndex(null)
    setPromptValues({})
    setApiKey('')
    setAuthorization(null)
    setOauthCode('')
    setQuery('')
    setError(null)
    setBusy(false)
    setLoading(true)
    void getProviderAuthMethods(directory)
      .then(setMethodsByProvider)
      .catch(cause => setError(formatError(cause, t('providerConnect.loadFailed'))))
      .finally(() => setLoading(false))
  }, [directory, initialProviderID, isOpen, t])

  useEffect(() => {
    if (!selectedProviderID || loading || methodIndex !== null) return
    if (methods.length === 1) setMethodIndex(0)
  }, [loading, methodIndex, methods, selectedProviderID])

  useEffect(() => {
    if (!method) return
    setPromptValues(
      Object.fromEntries(
        (method.prompts ?? []).flatMap(prompt =>
          prompt.type === 'select' && prompt.options[0] ? [[prompt.key, prompt.options[0].value]] : [],
        ),
      ),
    )
    setApiKey('')
    setAuthorization(null)
    setOauthCode('')
    setError(null)
  }, [method])

  const selectProvider = (providerID: string) => {
    setSelectedProviderID(providerID)
    setMethodIndex(null)
    setError(null)
  }

  const refreshCatalog = async () => {
    setRefreshing(true)
    setError(null)
    try {
      // 顺序：强制刷新目录 → dispose 实例（Provider 服务用新目录重建）→ 通知父级 + 刷新前端模型列表
      await refreshProviders(directory)
      await disposeInstance(directory)
      onProvidersChanged?.()
      await refreshModels()
    } catch (cause) {
      setError(formatError(cause, t('providerConnect.refreshCatalogFailed')))
    } finally {
      setRefreshing(false)
    }
  }

  const finish = async () => {
    if (!provider) return
    await disposeInstance(directory)
    await refreshModels()
    onConnected(provider)
  }

  const promptInputs = () =>
    Object.fromEntries(
      visiblePrompts
        .map(prompt => [prompt.key, promptValues[prompt.key]?.trim() ?? ''] as const)
        .filter((entry): entry is readonly [string, string] => !!entry[1]),
    )

  const validatePrompts = () => {
    const missing = visiblePrompts.find(prompt => prompt.type === 'text' && !promptValues[prompt.key]?.trim())
    if (!missing) return true
    setError(t('providerConnect.fieldRequired', { field: missing.message }))
    return false
  }

  const connectApiKey = async (event: FormEvent) => {
    event.preventDefault()
    if (!provider || !method || method.type !== 'api') return
    if (!validatePrompts()) return
    if (!apiKey.trim()) {
      setError(t('providerConnect.apiKeyRequired'))
      return
    }

    setBusy(true)
    setError(null)
    try {
      const metadata = promptInputs()
      await setProviderAuth(provider.id, {
        type: 'api',
        key: apiKey.trim(),
        metadata: Object.keys(metadata).length ? metadata : undefined,
      })
      await finish()
    } catch (cause) {
      setError(formatError(cause, t('providerConnect.connectFailed')))
    } finally {
      setBusy(false)
    }
  }

  const startOAuth = async (event: FormEvent) => {
    event.preventDefault()
    if (!provider || !method || method.type !== 'oauth' || methodIndex === null) return
    if (!validatePrompts()) return

    setBusy(true)
    setError(null)
    try {
      const inputs = promptInputs()
      const result = await authorizeProviderOAuth(
        provider.id,
        methodIndex,
        Object.keys(inputs).length ? inputs : undefined,
        directory,
      )
      setAuthorization(result)
      await openUrl(result.url)
      if (result.method === 'code') return
      await completeProviderOAuth(provider.id, methodIndex, undefined, directory)
      await finish()
    } catch (cause) {
      setError(formatError(cause, t('providerConnect.connectFailed')))
    } finally {
      setBusy(false)
    }
  }

  const submitOAuthCode = async (event: FormEvent) => {
    event.preventDefault()
    if (!provider || methodIndex === null) return
    if (!oauthCode.trim()) {
      setError(t('providerConnect.codeRequired'))
      return
    }

    setBusy(true)
    setError(null)
    try {
      await completeProviderOAuth(provider.id, methodIndex, oauthCode.trim(), directory)
      await finish()
    } catch (cause) {
      setError(formatError(cause, t('providerConnect.connectFailed')))
    } finally {
      setBusy(false)
    }
  }

  const back = () => {
    if (authorization) {
      setAuthorization(null)
      setOauthCode('')
      setError(null)
      return
    }
    if (methodIndex !== null && methods.length > 1) {
      setMethodIndex(null)
      setError(null)
      return
    }
    setSelectedProviderID(null)
    setMethodIndex(null)
    setError(null)
  }

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      width={520}
      title={
        selectedProviderID ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={back}
              className="rounded-md p-1 text-text-400 transition-colors hover:bg-bg-200 hover:text-text-100"
              aria-label={t('providerConnect.back')}
            >
              <ChevronLeftIcon size={16} />
            </button>
            <span>{t('providerConnect.connectTitle', { provider: provider?.name || selectedProviderID })}</span>
          </div>
        ) : (
          t('providerConnect.title')
        )
      }
    >
      <div className="min-h-0">
        {!selectedProviderID ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-xl border border-border-200/60 bg-bg-100/60 px-3 py-2 transition-colors focus-within:border-accent-main-100 focus-within:ring-1 focus-within:ring-accent-main-100/30">
              <SearchIcon size={14} className="shrink-0 text-text-400" />
              <input
                autoFocus
                data-provider-connect-input
                data-provider-search-input
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder={t('providerConnect.search')}
                className="min-w-0 flex-1 bg-transparent text-[length:var(--fs-md)] text-text-100 placeholder:text-text-400 outline-none focus-visible:outline-none"
              />
            </div>
            <div className="max-h-[min(460px,60vh)] space-y-1 overflow-y-auto pr-1 custom-scrollbar">
              {filteredProviders.map(item => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => selectProvider(item.id)}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-text-200 transition-colors hover:bg-bg-200/60 hover:text-text-100"
                >
                  <ProviderMark provider={item} />
                  <span className="min-w-0 flex-1 truncate text-[length:var(--fs-md)] font-medium">
                    {item.name || item.id}
                  </span>
                  {Object.keys(item.models ?? {}).length > 0 && (
                    <span className="text-[length:var(--fs-xs)] text-text-500">
                      {Object.keys(item.models ?? {}).length} {t('providerConnect.models')}
                    </span>
                  )}
                  {connectedSet.has(item.id) && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-success-bg px-2 py-0.5 text-[length:var(--fs-xxs)] text-success-100">
                      <CheckIcon size={10} />
                      {t('providerConnect.connected')}
                    </span>
                  )}
                </button>
              ))}
              {!loading && filteredProviders.length === 0 && (
                <div className="py-10 text-center text-[length:var(--fs-sm)] text-text-400">
                  {t('providerConnect.noProviders')}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => void refreshCatalog()}
              disabled={refreshing}
              className="flex h-9 w-full items-center justify-center gap-2 rounded-lg text-[length:var(--fs-sm)] text-text-400 transition-colors hover:bg-bg-200/70 hover:text-text-100 disabled:cursor-wait disabled:opacity-60"
            >
              {refreshing ? t('providerConnect.refreshingCatalog') : t('providerConnect.refreshCatalog')}
            </button>
          </div>
        ) : loading ? (
          <div className="py-10 text-center text-[length:var(--fs-sm)] text-text-400">
            {t('providerConnect.loading')}
          </div>
        ) : !provider ? (
          <div className="py-10 text-center text-[length:var(--fs-sm)] text-danger-100">
            {t('providerConnect.providerUnavailable')}
          </div>
        ) : methodIndex === null && methods.length > 1 ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3 rounded-xl bg-bg-100/50 px-3 py-3">
              <ProviderMark provider={provider} className="size-7" />
              <div>
                <div className="text-[length:var(--fs-md)] font-medium text-text-100">{provider.name}</div>
                <div className="text-[length:var(--fs-xs)] text-text-400">{t('providerConnect.chooseMethod')}</div>
              </div>
            </div>
            <div className="space-y-1">
              {methods.map((item, index) => (
                <button
                  key={`${item.type}-${item.label}-${index}`}
                  type="button"
                  onClick={() => setMethodIndex(index)}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-text-200 transition-colors hover:bg-bg-200/60 hover:text-text-100"
                >
                  {item.type === 'api' ? <KeyIcon size={15} /> : <ExternalLinkIcon size={15} />}
                  <span className="text-[length:var(--fs-md)] font-medium">
                    {item.type === 'api' ? t('providerConnect.apiKey') : item.label}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : !method ? (
          <div className="py-10 text-center text-[length:var(--fs-sm)] text-text-400">
            {t('providerConnect.noMethods')}
          </div>
        ) : authorization?.method === 'code' ? (
          <form onSubmit={submitOAuthCode} className="space-y-4">
            <p className="text-[length:var(--fs-sm)] leading-relaxed text-text-300">
              {t('providerConnect.codeDescription', { provider: provider.name })}
            </p>
            <Button type="button" variant="secondary" size="sm" onClick={() => void openUrl(authorization.url)}>
              <ExternalLinkIcon size={13} />
              {t('providerConnect.openAuthorization')}
            </Button>
            <label className="block space-y-1.5">
              <span className="text-[length:var(--fs-xs)] font-medium text-text-300">{t('providerConnect.code')}</span>
              <input
                data-provider-connect-input
                value={oauthCode}
                onChange={event => setOauthCode(event.target.value)}
                placeholder={t('providerConnect.codePlaceholder')}
                className="h-10 w-full rounded-lg border border-border-200 bg-bg-000 px-3 font-mono text-[length:var(--fs-md)] text-text-100 outline-none placeholder:text-text-400 focus:border-accent-main-100/50"
              />
            </label>
            {error && <ErrorMessage message={error} />}
            <Button type="submit" isLoading={busy}>{t('providerConnect.finish')}</Button>
          </form>
        ) : (
          <form onSubmit={method.type === 'api' ? connectApiKey : startOAuth} className="space-y-4">
            <div className="flex items-center gap-3 rounded-xl bg-bg-100/50 px-3 py-3">
              <ProviderMark provider={provider} className="size-7" />
              <div className="min-w-0">
                <div className="truncate text-[length:var(--fs-md)] font-medium text-text-100">{provider.name}</div>
                <div className="truncate text-[length:var(--fs-xs)] text-text-400">
                  {method.type === 'api' ? t('providerConnect.apiKeyDescription') : method.label}
                </div>
              </div>
            </div>

            {visiblePrompts.map(prompt => (
              <label key={prompt.key} className="block space-y-1.5">
                <span className="text-[length:var(--fs-xs)] font-medium text-text-300">{prompt.message}</span>
                {prompt.type === 'select' ? (
                  <select
                    data-provider-connect-input
                    value={promptValues[prompt.key] ?? prompt.options[0]?.value ?? ''}
                    onChange={event =>
                      setPromptValues(current => ({ ...current, [prompt.key]: event.target.value }))
                    }
                    className="h-10 w-full rounded-lg border border-border-200 bg-bg-000 px-3 text-[length:var(--fs-md)] text-text-100 outline-none focus:border-accent-main-100/50"
                  >
                    {prompt.options.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    data-provider-connect-input
                    value={promptValues[prompt.key] ?? ''}
                    onChange={event =>
                      setPromptValues(current => ({ ...current, [prompt.key]: event.target.value }))
                    }
                    placeholder={prompt.placeholder}
                    className="h-10 w-full rounded-lg border border-border-200 bg-bg-000 px-3 text-[length:var(--fs-md)] text-text-100 outline-none placeholder:text-text-400 focus:border-accent-main-100/50"
                  />
                )}
              </label>
            ))}

            {method.type === 'api' && (
              <label className="block space-y-1.5">
                <span className="text-[length:var(--fs-xs)] font-medium text-text-300">{t('providerConnect.apiKey')}</span>
                <div className="flex h-10 items-center gap-2 rounded-lg border border-border-200 bg-bg-000 px-3 transition-colors focus-within:border-accent-main-100/50">
                  <KeyIcon size={14} className="shrink-0 text-text-400" />
                  <input
                    data-provider-connect-input
                    type="password"
                    value={apiKey}
                    onChange={event => setApiKey(event.target.value)}
                    placeholder={t('providerConnect.apiKeyPlaceholder')}
                    autoComplete="off"
                    className="min-w-0 flex-1 bg-transparent text-[length:var(--fs-md)] text-text-100 outline-none placeholder:text-text-400"
                  />
                </div>
              </label>
            )}

            {authorization?.method === 'auto' && (
              <div className="rounded-lg border border-border-200/60 bg-bg-100/50 px-3 py-3 text-[length:var(--fs-sm)] text-text-300">
                {t('providerConnect.waiting')}
                {authorization.instructions && (
                  <div className="mt-2 select-all font-mono text-text-100">{confirmationCode(authorization.instructions)}</div>
                )}
              </div>
            )}
            {error && <ErrorMessage message={error} />}
            <Button type="submit" isLoading={busy}>
              {method.type === 'api' ? t('providerConnect.connect') : t('providerConnect.authorize')}
            </Button>
          </form>
        )}
      </div>
    </Dialog>
  )
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-danger-100/25 bg-danger-100/10 px-3 py-2 text-[length:var(--fs-sm)] text-danger-100">
      {message}
    </div>
  )
}

function promptVisible(prompt: AuthPrompt, values: Record<string, string>) {
  if (!prompt.when) return true
  const value = values[prompt.when.key] ?? ''
  if (prompt.when.op === 'eq') return value === prompt.when.value
  return value !== prompt.when.value
}

function confirmationCode(instructions: string) {
  if (!instructions.includes(':')) return instructions
  return instructions.split(':').at(-1)?.trim() ?? instructions
}

function formatError(value: unknown, fallback: string): string {
  if (value && typeof value === 'object' && 'data' in value) {
    const data = (value as { data?: { message?: unknown } }).data
    if (typeof data?.message === 'string' && data.message) return data.message
  }
  if (value && typeof value === 'object' && 'error' in value) {
    const nested = formatError((value as { error?: unknown }).error, '')
    if (nested) return nested
  }
  if (value instanceof Error && value.message) return value.message
  if (typeof value === 'string' && value) return value
  return fallback
}
