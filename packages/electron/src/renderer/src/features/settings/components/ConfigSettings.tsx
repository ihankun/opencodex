import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircleIcon, CheckIcon, CloseIcon, SettingsIcon, UndoIcon } from '../../../components/Icons'
import { Dialog } from '../../../components/ui/Dialog'
import { SettingsSearch } from '../SettingsSearch'
import { getConfig, getGlobalConfig, getProviderConfigs, listAvailableShells, updateConfig, updateGlobalConfig } from '../../../api'
import type { Config } from '../../../types/api/config'
import { useCurrentDirectory, useIsMobile } from '../../../hooks'
import { SettingsCard, SettingsSection } from './SettingsUI'
import { validateConfig, validationDrillTargetForError, type ValidationDrillTarget, type ValidationError } from './configEditorValidation'
import { ValidationDrillTargetContext } from './configEditorDrillState'
import { JsonDraftErrorContext } from './configEditorJsonDraft'
import { SECTION_IDS, SECTION_META } from './configEditorMeta'
import { buildConfigEditorSearchItems, type ConfigEditorSearchItem } from './configEditorSearch'
import { SectionRouter } from './configEditorSections'
import type { Choice, JsonRecord, SectionID } from './configEditorTypes'
import { clone, createMergePatch, getObject, isRecord, sameValue, tx } from './configEditorUtils'

function ConfigEditorDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation('settings')
  const lang = i18n.language
  const directory = useCurrentDirectory()
  const isMobile = useIsMobile()
  const [section, setSection] = useState<SectionID>('general')
  const [config, setConfig] = useState<Config>({} as Config)
  const [original, setOriginal] = useState<Config>({} as Config)
  const [effective, setEffective] = useState<Config>({} as Config)
  const [globalConfig, setGlobalConfig] = useState<Config>({} as Config)
  const [scope, setScope] = useState<'global' | 'project'>('global')
  const [shells, setShells] = useState<Choice[]>([])
  const [models, setModels] = useState<Choice[]>([])
  const [providerCatalog, setProviderCatalog] = useState<JsonRecord>({})
  const [loading, setLoading] = useState(false)
  const [validating, setValidating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [schemaWarning, setSchemaWarning] = useState<string | null>(null)
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([])
  const [validationDrillTarget, setValidationDrillTarget] = useState<ValidationDrillTarget | null>(null)
  const [jsonDraftErrors, setJsonDraftErrors] = useState<Set<string>>(() => new Set())
  const loadRequestRef = useRef(0)
  const saveRequestRef = useRef(0)
  const scrollRef = useRef<HTMLElement>(null)
  const highlightFrameRef = useRef<number | null>(null)
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirty = !sameValue(config, original)
  const deferredConfig = useDeferredValue(config)
  const searchItems = useMemo(() => buildConfigEditorSearchItems(deferredConfig as JsonRecord, lang), [deferredConfig, lang])

  const reportJsonDraftError = useCallback((id: string, invalid: boolean) => {
    setJsonDraftErrors(prev => {
      const next = new Set(prev)
      if (invalid) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const updateEditorConfig = useCallback((next: Config) => {
    setConfig(next)
    setValidationErrors([])
    setValidationDrillTarget(null)
  }, [])

  const canNavigate = useCallback(() => {
    if (jsonDraftErrors.size === 0) return true
    setError(tx('Fix the current invalid JSON editor before leaving it.', '离开当前页面前，请先修复无效的 JSON 编辑框。', lang))
    return false
  }, [jsonDraftErrors, lang])

  const switchSection = useCallback((next: SectionID) => {
    if (!canNavigate()) return false
    setSection(next)
    setValidationDrillTarget(null)
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: 0 }))
    return true
  }, [canNavigate])

  const load = useCallback(async () => {
    if (!isOpen) return
    const request = ++loadRequestRef.current
    saveRequestRef.current += 1
    setLoading(true)
    setError(null)
    setSchemaWarning(null)
    setValidationErrors([])
    setValidationDrillTarget(null)
    try {
      const [global, nextEffective, shellList, providers] = await Promise.all([
        getGlobalConfig(),
        getConfig(directory),
        listAvailableShells(directory).catch(() => []),
        getProviderConfigs(directory).catch(() => undefined),
      ])
      const modelChoices: Choice[] = []
      const providerCatalog = isRecord(providers) && Array.isArray(providers.providers)
        ? Object.fromEntries(
            providers.providers
              .filter(isRecord)
              .flatMap(provider => (typeof provider.id === 'string' ? [[provider.id, provider]] : [])),
          )
        : {}
      for (const [providerID, provider] of Object.entries(providerCatalog)) {
        if (!isRecord(provider) || !isRecord(provider.models)) continue
        for (const modelID of Object.keys(provider.models)) {
          modelChoices.push({ value: `${providerID}/${modelID}`, label: `${providerID}/${modelID}` })
        }
      }
      if (request !== loadRequestRef.current) return
      const editable = scope === 'project' && directory ? nextEffective : global
      setGlobalConfig(clone(global))
      setOriginal(clone(editable))
      setConfig(clone(editable))
      setJsonDraftErrors(new Set())
      setEffective(nextEffective)
      setProviderCatalog(providerCatalog)
      setShells([
        { value: '', label: t('config.shellAuto') },
        ...shellList.map(shell => ({
          value: shell.name === shell.path ? shell.path : shell.name,
          label: shell.name,
          hint: shell.path,
          disabled: !shell.acceptable,
        })),
      ])
      setModels(modelChoices)
    } catch (err) {
      if (request !== loadRequestRef.current) return
      setError(err instanceof Error ? err.message : t('config.loadFailed'))
    } finally {
      if (request === loadRequestRef.current) setLoading(false)
    }
  }, [directory, isOpen, scope, t])

  useEffect(() => {
    if (isOpen) void load()
    else {
      loadRequestRef.current += 1
      saveRequestRef.current += 1
    }
  }, [isOpen, load])

  useEffect(
    () => () => {
      if (highlightFrameRef.current !== null) cancelAnimationFrame(highlightFrameRef.current)
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    },
    [],
  )

  const save = async () => {
    const request = ++saveRequestRef.current
    setError(null)
    setSchemaWarning(null)
    setValidationErrors([])
    setValidationDrillTarget(null)
    if (jsonDraftErrors.size > 0) {
      setError(tx('Fix invalid JSON editors before saving.', '保存前请先修复无效 JSON 编辑框。', lang))
      return
    }
    const snapshot = clone(config)
    setValidating(true)
    let officialResult: { errors: ValidationError[]; unavailable?: string }
    try {
      const { validateAgainstOfficialConfigSchema } = await import('./configOfficialValidator')
      officialResult = await validateAgainstOfficialConfigSchema(snapshot)
    } catch (error) {
      officialResult = { errors: [], unavailable: error instanceof Error ? error.message : String(error) }
    } finally {
      setValidating(false)
    }
    const schemaUnavailableMessage = officialResult.unavailable
      ? tx('Official schema could not be loaded; this save relies on OpenCode server validation.', '无法加载官方 schema；本次保存将依赖 OpenCode 服务端校验。', lang)
      : null
    if (request !== saveRequestRef.current) return
    const nextValidationErrors = [...officialResult.errors, ...validateConfig(snapshot, lang, original)]
    if (nextValidationErrors.length > 0) {
      if (schemaUnavailableMessage) setSchemaWarning(schemaUnavailableMessage)
      setValidationErrors(nextValidationErrors)
      return
    }
    setSaving(true)
    try {
      const saved = scope === 'project' && directory
        ? await updateConfig(snapshot, directory)
        : await updateGlobalConfig(createMergePatch(original, snapshot) as Config)
      if (request !== saveRequestRef.current) return
      setOriginal(clone(saved))
      setConfig(current => sameValue(current, snapshot) ? clone(saved) : current)
      const nextEffective = await getConfig(directory)
      if (request !== saveRequestRef.current) return
      setEffective(nextEffective)
      if (scope === 'global') setGlobalConfig(saved)
      setSchemaWarning(null)
    } catch (err) {
      if (request !== saveRequestRef.current) return
      if (schemaUnavailableMessage) setSchemaWarning(schemaUnavailableMessage)
      setError(err instanceof Error ? err.message : t('config.saveFailed'))
    } finally {
      if (request === saveRequestRef.current) setSaving(false)
    }
  }
  const effectiveOverrideCount = useMemo(() => Object.keys(createMergePatch(globalConfig, effective)).length, [effective, globalConfig])

  const agents = useMemo(() => {
    const names = new Set([
      'build',
      'plan',
      'general',
      'explore',
      ...Object.keys(getObject(config, 'agent')),
      ...Object.keys(getObject(effective, 'agent')),
    ])
    return Array.from(names)
      .sort()
      .map(value => ({ value, label: value }))
  }, [config, effective])

  const openValidationError = (error: ValidationError) => {
    if (!canNavigate()) return
    const target = validationDrillTargetForError(error)
    setSection(target.section)
    setValidationDrillTarget({ ...target, key: `${error.path}:${Date.now()}` })
  }

  const openSearchItem = useCallback((item: ConfigEditorSearchItem) => {
    if (!canNavigate()) return false
    setSection(item.section)
    setValidationDrillTarget({ section: item.section, stack: item.stack, key: `search:${item.id}:${Date.now()}` })
    if (highlightFrameRef.current !== null) cancelAnimationFrame(highlightFrameRef.current)
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    const locate = (remaining: number) => {
      const fields = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>('[data-config-field]') ?? [])
      const matches = item.fieldKey ? fields.filter(field => field.dataset.configField === item.fieldKey) : []
      const target = matches.at(-1) ?? scrollRef.current?.querySelector<HTMLElement>(`[data-config-section="${item.section}"]`)
      if (!target && remaining > 0) {
        highlightFrameRef.current = requestAnimationFrame(() => locate(remaining - 1))
        return
      }
      highlightFrameRef.current = null
      if (!target) return
      scrollRef.current?.querySelector('.settings-search-highlight')?.classList.remove('settings-search-highlight')
      target.scrollIntoView({ block: 'center', behavior: 'smooth' })
      target.classList.add('settings-search-highlight')
      highlightTimerRef.current = setTimeout(() => {
        target.classList.remove('settings-search-highlight')
        highlightTimerRef.current = null
      }, 1800)
    }
    highlightFrameRef.current = requestAnimationFrame(() => locate(20))
  }, [canNavigate])

  const search = (
    <SettingsSearch
      items={searchItems}
      placeholder={tx('Search config fields or JSON paths', '搜索配置字段或 JSON 路径', lang)}
      clearLabel={tx('Clear search', '清除搜索', lang)}
      noResultsLabel={tx('No matching config', '没有匹配的配置', lang)}
      onSelect={openSearchItem}
    />
  )

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      rawContent
      width={isMobile ? '100%' : 'min(97vw, 1040px)'}
      className={isMobile ? 'h-full' : undefined}
      showCloseButton={false}
      ariaLabel={t('config.editorTitle')}
    >
      <JsonDraftErrorContext.Provider value={reportJsonDraftError}>
        <ValidationDrillTargetContext.Provider value={validationDrillTarget}>
          <div
            className={`flex min-h-0 flex-col ${isMobile ? 'flex-1' : ''}`}
            style={isMobile ? undefined : { height: 'min(90vh, 820px)' }}
          >
            {isMobile ? (
              <div className="shrink-0">
                <div className="flex items-center justify-center px-4 pt-3 pb-2">
                  <div className="text-center">
                    <div className="truncate text-[length:var(--fs-heading-3)] font-semibold text-text-100">{t('config.editorTitle')}</div>
                    {dirty && <div className="mt-0.5 text-[length:var(--fs-xs)] text-warning-100">{t('config.unsaved')}</div>}
                  </div>
                </div>
                <div className="px-4 pb-2">{search}</div>
                <div className="relative">
                  <div
                    role="tablist"
                    aria-label={t('config.editorTitle')}
                    className="flex items-center gap-1.5 overflow-x-auto px-4 pb-3 scrollbar-none"
                  >
                    {SECTION_IDS.map(id => (
                      <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={section === id}
                        onClick={() => switchSection(id)}
                        className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-[length:var(--fs-md)] font-medium transition-colors ${
                          section === id
                            ? 'border-accent-main-100/30 bg-accent-main-100/10 text-accent-main-100'
                            : 'border-transparent text-text-400 active:bg-bg-100/60'
                        }`}
                      >
                        {tx(SECTION_META[id].en, SECTION_META[id].zh, lang)}
                      </button>
                    ))}
                  </div>
                  <div className="absolute bottom-0 left-0 right-0 border-b border-border-100/40" />
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3 border-b border-border-200/50 px-5 xl:px-6 py-3.5">
                <div className="min-w-0 flex-1">
                  <div className="text-[length:var(--fs-heading-3)] font-semibold text-text-100">{t('config.editorTitle')}</div>
                  <div className="mt-0.5 truncate text-[length:var(--fs-xs)] leading-relaxed text-text-400">{t('config.noDeleteHint')}</div>
                </div>
                <div className="flex min-w-0 items-center gap-2">
                  {dirty && <span className="hidden text-[length:var(--fs-xs)] text-warning-100 sm:inline">{t('config.unsaved')}</span>}
                  <button
                    type="button"
                    disabled={!dirty || saving || validating}
                    onClick={() => updateEditorConfig(clone(original))}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border-200/60 px-3 py-1.5 text-[length:var(--fs-xs)] text-text-300 transition-colors hover:bg-bg-100 disabled:opacity-40"
                  >
                    <UndoIcon size={13} />
                    {t('config.reset')}
                  </button>
                  <button
                    type="button"
                    disabled={!dirty || saving || validating}
                    onClick={save}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent-main-100 px-3 py-1.5 text-[length:var(--fs-xs)] font-medium text-white transition-opacity disabled:opacity-40"
                  >
                    <CheckIcon size={13} />
                    {saving ? t('config.saving') : validating ? tx('Validating…', '校验中…', lang) : t('config.saveAll')}
                  </button>
                  <button type="button" onClick={onClose} aria-label={t('closeSettings')} className="-mr-1 shrink-0 rounded-md p-2 text-text-400 transition-colors hover:bg-bg-100 hover:text-text-200">
                    <CloseIcon size={18} />
                  </button>
                </div>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-200/50 bg-bg-100/45 px-4 py-2 text-[length:var(--fs-xs)]">
              <div className="flex items-center gap-2">
                <span className="text-text-400">{tx('Editing scope', '编辑作用域', lang)}</span>
                <div className="inline-flex rounded-lg bg-bg-200/60 p-0.5">
                  <button type="button" onClick={() => { if (!dirty || window.confirm(tx('Discard unsaved changes and switch scope?', '放弃未保存的更改并切换作用域？', lang))) setScope('global') }} className={`rounded-md px-2.5 py-1 ${scope === 'global' ? 'bg-bg-000 text-text-100 shadow-sm' : 'text-text-400'}`}>{tx('Global', '全局', lang)}</button>
                  <button type="button" disabled={!directory} onClick={() => { if (!dirty || window.confirm(tx('Discard unsaved changes and switch scope?', '放弃未保存的更改并切换作用域？', lang))) setScope('project') }} className={`rounded-md px-2.5 py-1 disabled:opacity-40 ${scope === 'project' ? 'bg-bg-000 text-text-100 shadow-sm' : 'text-text-400'}`}>{tx('Current project', '当前项目', lang)}</button>
                </div>
              </div>
              <div className="min-w-0 text-text-400"><span className="font-medium text-text-300">{scope === 'global' ? tx('Global source', '全局配置源', lang) : tx('Project effective config', '项目有效配置', lang)}</span>{scope === 'project' && directory ? <span className="ml-2 max-w-80 truncate font-mono">{directory}</span> : null}<span className="ml-2">{tx(`${effectiveOverrideCount} effective override group(s)`, `有效配置包含 ${effectiveOverrideCount} 组覆盖`, lang)}</span></div>
            </div>
            {error && <div className="break-words border-b border-error-100/20 bg-error-100/10 px-4 py-2 text-[length:var(--fs-xs)] text-error-100">{error}</div>}
            {schemaWarning && <div className="break-words border-b border-warning-100/20 bg-warning-100/10 px-4 py-2 text-[length:var(--fs-xs)] text-warning-100">{schemaWarning}</div>}
            {validationErrors.length > 0 && (
              <div className="max-h-32 overflow-y-auto border-b border-error-100/20 bg-error-100/10 px-4 py-2 text-[length:var(--fs-xs)] text-error-100 custom-scrollbar">
                <div className="mb-1 font-medium">{t('config.validationFailed', { defaultValue: 'Config validation failed' })}</div>
                <div className="space-y-1">
                  {validationErrors.slice(0, 12).map(error => (
                    <button
                      key={`${error.path}:${error.message}`}
                      type="button"
                      onClick={() => openValidationError(error)}
                      className="block min-w-0 text-left break-words hover:underline"
                    >
                      <span className="break-all font-mono">{error.path}</span>: {error.message}
                    </button>
                  ))}
                  {validationErrors.length > 12 && <div>{tx(`${validationErrors.length - 12} more issue(s)…`, `还有 ${validationErrors.length - 12} 个问题…`, lang)}</div>}
                </div>
              </div>
            )}
            {loading && <div className="border-b border-border-200/50 px-4 py-2 text-[length:var(--fs-xs)] text-text-400">{t('config.loading')}</div>}
            {isMobile ? (
              <>
                <main ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-4 custom-scrollbar overscroll-contain">
                  <SectionRouter section={section} config={config} setConfig={updateEditorConfig} lang={lang} shells={shells} models={models} agents={agents} providerCatalog={providerCatalog} />
                </main>
                <div className="relative shrink-0 px-4 py-3">
                  <div className="pointer-events-none absolute inset-x-4 top-0 h-px bg-border-200/30" />
                  <div className="flex min-w-0 gap-2">
                    <button
                      type="button"
                      disabled={!dirty || saving || validating}
                      onClick={() => updateEditorConfig(clone(original))}
                      className="inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border-200/60 px-3 py-2 text-[length:var(--fs-sm)] font-medium text-text-300 transition-colors hover:bg-bg-100 disabled:opacity-40"
                    >
                      <UndoIcon size={14} />
                      {t('config.reset')}
                    </button>
                    <button
                      type="button"
                      disabled={!dirty || saving || validating}
                      onClick={save}
                      className="inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent-main-100 px-3 py-2 text-[length:var(--fs-sm)] font-medium text-white transition-opacity disabled:opacity-40"
                    >
                      <CheckIcon size={14} />
                      {saving ? t('config.saving') : validating ? tx('Validating…', '校验中…', lang) : t('config.saveAll')}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="grid min-h-0 flex-1 grid-cols-[200px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)]">
                <aside className="min-w-0 border-r border-border-200/50 p-2">
                  <div className="mb-2">{search}</div>
                  <div className="space-y-0.5">
                    {SECTION_IDS.map(id => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => switchSection(id)}
                        className={`w-full rounded-lg px-3 py-2 text-left text-[length:var(--fs-sm)] transition-colors ${
                          section === id ? 'bg-accent-main-100/12 font-medium text-accent-main-100' : 'text-text-300 hover:bg-bg-100 hover:text-text-100'
                        }`}
                      >
                        {tx(SECTION_META[id].en, SECTION_META[id].zh, lang)}
                      </button>
                    ))}
                  </div>
                </aside>
                <main ref={scrollRef} className="min-h-0 min-w-0 overflow-y-auto p-5 custom-scrollbar xl:px-6">
                  <SectionRouter section={section} config={config} setConfig={updateEditorConfig} lang={lang} shells={shells} models={models} agents={agents} providerCatalog={providerCatalog} />
                </main>
              </div>
            )}
          </div>
        </ValidationDrillTargetContext.Provider>
      </JsonDraftErrorContext.Provider>
    </Dialog>
  )
}

export function ConfigSettings() {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  return (
    <div>
      <SettingsSection title={t('config.title')}>
        <SettingsCard
          title={t('config.sourceTitle')}
          description={t('config.sourceDesc')}
          actions={
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent-main-100 px-3 py-2 text-[length:var(--fs-sm)] font-medium text-white transition-colors hover:bg-accent-main-100/90"
            >
              <SettingsIcon size={14} />
              {t('config.openEditor')}
            </button>
          }
        >
          <div className="flex items-start gap-2 rounded-lg border border-warning-200/30 bg-warning-100/10 px-3 py-2 text-[length:var(--fs-xs)] text-text-300">
            <AlertCircleIcon size={14} className="mt-0.5 shrink-0 text-warning-100" />
            <span>{t('config.sdkOnlyWarning')}</span>
          </div>
        </SettingsCard>
      </SettingsSection>
      <ConfigEditorDialog isOpen={open} onClose={() => setOpen(false)} />
    </div>
  )
}
