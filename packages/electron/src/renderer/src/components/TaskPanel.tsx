import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { CheckIcon, ClockIcon, DownloadIcon, MessageSquareIcon, PencilIcon, PlusIcon, RetryIcon, SearchIcon, SpinnerIcon, TrashIcon, UploadIcon } from './Icons'
import { useDirectory, useModels, useServerStore } from '../hooks'
import { getProjects } from '../api'
import { executionTargetStore } from '../store/executionTargetStore'
import { serverStore, type ServerConfig } from '../store/serverStore'
import { saveData } from '../utils/downloadUtils'
import { ConfirmDialog } from './ui/ConfirmDialog'
import { Dialog } from './ui/Dialog'
import { Button } from './ui/Button'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Cron } from 'croner'

type Task = Awaited<ReturnType<typeof window.customOpenCode.listTasks>>[number]
type TaskInput = Parameters<typeof window.customOpenCode.createTask>[0]
type TaskRun = Awaited<ReturnType<typeof window.customOpenCode.listTaskRunPage>>['data'][number]
type TaskSettings = Awaited<ReturnType<typeof window.customOpenCode.taskSettings>>
type Frequency = 'daily' | 'weekdays' | 'weekly' | 'advanced'
type TaskTemplate = { id: string; name: string; input: TaskInput }
const taskTemplateStorageKey = 'opencodex.automation.templates.v1'
const handledRunStorageKey = 'opencodex.automation.handled-runs.v1'
const TASK_RUN_PAGE_SIZE = 50

const weekdays = [
  ['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['0', 'Sun'],
] as const

export const TaskPanel = memo(function TaskPanel({ onOpenSession }: { onOpenSession: (sessionID: string, directory: string) => void }) {
  const { t } = useTranslation(['components', 'common'])
  const { currentDirectory, savedDirectories, pathInfo } = useDirectory()
  const { servers, activeServer } = useServerStore()
  const [tasks, setTasks] = useState<Task[]>([])
  const [runs, setRuns] = useState<TaskRun[]>([])
  const [runTotal, setRunTotal] = useState(0)
  const [runHasMore, setRunHasMore] = useState(false)
  const [runLoadingMore, setRunLoadingMore] = useState(false)
  const [runLogs, setRunLogs] = useState<Record<string, string>>({})
  const [runLogLoadingID, setRunLogLoadingID] = useState<string | null>(null)
  const [view, setView] = useState<'tasks' | 'attention' | 'runs' | 'artifacts'>('tasks')
  const [handledRunIDs, setHandledRunIDs] = useState<string[]>(() => readStringList(handledRunStorageKey))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<'all' | 'enabled' | 'paused'>('all')
  const [editing, setEditing] = useState<Task | 'new' | null>(null)
  const [draftInput, setDraftInput] = useState<TaskInput | undefined>()
  const [templates, setTemplates] = useState<TaskTemplate[]>(readTaskTemplates)
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [busy, setBusy] = useState('')
  const [settings, setSettings] = useState<TaskSettings>({ maxConcurrency: 3, historyRetentionDays: 90, maxHistory: 1000, webhookPort: 49832 })
  const [deleteTask, setDeleteTask] = useState<Task | null>(null)
  const [deleteTemplate, setDeleteTemplate] = useState<TaskTemplate | null>(null)
  const importInput = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [nextTasks, nextRunPage, nextSettings] = await Promise.all([
        window.customOpenCode.listTasks(),
        window.customOpenCode.listTaskRunPage({ limit: TASK_RUN_PAGE_SIZE, offset: 0 }),
        window.customOpenCode.taskSettings(),
      ])
      setTasks(nextTasks)
      setRuns(nextRunPage.data)
      setRunTotal(nextRunPage.total)
      setRunHasMore(nextRunPage.hasMore)
      setRunLogs({})
      setSettings(nextSettings)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('taskPanel.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  const loadMoreRuns = useCallback(async () => {
    if (runLoadingMore || !runHasMore) return
    setRunLoadingMore(true)
    try {
      const page = await window.customOpenCode.listTaskRunPage({ limit: TASK_RUN_PAGE_SIZE, offset: runs.length })
      setRuns(current => {
        const existing = new Set(current.map(run => run.id))
        return [...current, ...page.data.filter(run => !existing.has(run.id))]
      })
      setRunTotal(page.total)
      setRunHasMore(page.hasMore)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('taskPanel.loadFailed'))
    } finally {
      setRunLoadingMore(false)
    }
  }, [runHasMore, runLoadingMore, runs.length, t])

  const loadRunLog = useCallback(async (runID: string) => {
    if (Object.prototype.hasOwnProperty.call(runLogs, runID)) return runLogs[runID]
    setRunLogLoadingID(runID)
    try {
      const log = await window.customOpenCode.taskRunLog(runID)
      const value = log ?? ''
      setRunLogs(current => ({ ...current, [runID]: value }))
      return value
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('taskPanel.loadFailed'))
      return ''
    } finally {
      setRunLogLoadingID(current => current === runID ? null : current)
    }
  }, [runLogs, t])

  const clearRunLog = useCallback((runID: string) => {
    setRunLogs(current => {
      if (!Object.prototype.hasOwnProperty.call(current, runID)) return current
      const next = { ...current }
      delete next[runID]
      return next
    })
  }, [])

  const exportRunLog = useCallback(async (runID: string, fallback = '') => {
    const log = await loadRunLog(runID)
    saveData(new TextEncoder().encode(log || fallback), `automation-${runID}.log`, 'text/plain;charset=utf-8')
  }, [loadRunLog])

  useEffect(() => {
    void load()
    return window.customOpenCode.onTasksChanged(() => void load())
  }, [load, t])
  const visible = useMemo(() => tasks.filter(task => filter === 'all' || (filter === 'enabled' ? task.enabled : !task.enabled)), [filter, tasks])
  const attentionRuns = useMemo(() => runs.filter(run => ['failed', 'timed_out', 'blocked', 'recovering'].includes(run.status) && !handledRunIDs.includes(run.id)), [handledRunIDs, runs])
  const artifacts = useMemo(() => collectAutomationArtifacts(runs, runLogs), [runLogs, runs])
  const directories = useMemo(() => Array.from(new Map([
    ...(currentDirectory ? [{ path: currentDirectory, name: savedDirectories.find(item => item.path === currentDirectory)?.name ?? currentDirectory }] : []),
    ...(pathInfo?.directory ? [{ path: pathInfo.directory, name: savedDirectories.find(item => item.path === pathInfo.directory)?.name ?? pathInfo.directory }] : []),
    ...savedDirectories,
  ].map(item => [item.path, item])).values()), [currentDirectory, pathInfo?.directory, savedDirectories])

  const update = useCallback(async (task: Task, input: TaskInput) => {
    setBusy(task.id)
    try {
      await window.customOpenCode.updateTask(task.id, input)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('taskPanel.actionFailed'))
    } finally {
      setBusy('')
    }
  }, [load, t])

  const performTaskAction = useCallback(async (taskID: string, action: () => Promise<unknown>) => {
    setBusy(taskID)
    try {
      await action()
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('taskPanel.actionFailed'))
    } finally {
      setBusy('')
    }
  }, [load, t])

  const exportTasks = useCallback(() => {
    saveData(new TextEncoder().encode(JSON.stringify({
      format: 'opencodex.automation',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings,
      tasks: tasks.map(taskInputFromTask),
    }, null, 2)), `opencodex-automation-${new Date().toISOString().slice(0, 10)}.json`, 'application/json;charset=utf-8')
  }, [settings, tasks])

  const importTasks = useCallback(async (file: File) => {
    setBusy('import')
    try {
      const value: unknown = JSON.parse(await file.text())
      if (!isTaskExport(value)) throw new Error(t('taskPanel.invalidImport'))
      await Promise.all(value.tasks.map(task => window.customOpenCode.createTask(normalizeImportedTask(task))))
      if (value.settings) await window.customOpenCode.updateTaskSettings({ ...settings, ...value.settings })
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? t('taskPanel.importFailedWithError', { error: cause.message }) : t('taskPanel.importFailed'))
    } finally {
      setBusy('')
      if (importInput.current) importInput.current.value = ''
    }
  }, [load, settings, t])

  const storeTemplates = useCallback((next: TaskTemplate[]) => {
    setTemplates(next)
    localStorage.setItem(taskTemplateStorageKey, JSON.stringify(next))
  }, [])

  return (
    <div className="flex h-full flex-col bg-bg-100">
      <div className="window-drag-region window-caption-inset flex h-14 shrink-0 items-center justify-between border-b border-border-200/50 px-6">
        <div>
          <h1 className="text-[length:var(--fs-lg)] font-semibold text-text-100">{t('taskPanel.title')}</h1>
        </div>
        <div className="flex gap-1.5">
          <input ref={importInput} type="file" accept="application/json,.json" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void importTasks(file) }} />
          {view === 'tasks' && templates.length > 0 ? <select aria-label={t('taskPanel.templates')} value={selectedTemplateId} onChange={event => {
            const template = templates.find(item => item.id === event.target.value)
            setSelectedTemplateId(event.target.value)
            if (!template) return
            setDraftInput({ ...template.input, title: template.input.title, enabled: true })
            setEditing('new')
          }} className="h-8 max-w-40 rounded-lg border border-border-200 bg-bg-100 px-2 text-[length:var(--fs-sm)] text-text-300"><option value="">{t('taskPanel.templates')}</option>{templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}</select> : null}
          {view === 'tasks' && selectedTemplateId ? <button aria-label={t('taskPanel.deleteTemplate')} title={t('taskPanel.deleteTemplate')} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-400 hover:bg-danger-100/10 hover:text-danger-100" onClick={() => setDeleteTemplate(templates.find(item => item.id === selectedTemplateId) ?? null)}><TrashIcon size={13} /></button> : null}
          {view === 'tasks' && <button disabled={busy === 'import'} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[length:var(--fs-sm)] text-text-300 hover:bg-bg-200 disabled:opacity-50" onClick={() => importInput.current?.click()} title={t('taskPanel.import')}><UploadIcon size={13} />{t('taskPanel.import')}</button>}
          {view === 'tasks' && <button disabled={!tasks.length} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[length:var(--fs-sm)] text-text-300 hover:bg-bg-200 disabled:opacity-50" onClick={exportTasks} title={t('taskPanel.export')}><DownloadIcon size={13} />{t('taskPanel.export')}</button>}
          <button className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-300 hover:bg-bg-200" onClick={() => void load()} title={t('common:refresh')} aria-label={t('common:refresh')}><RetryIcon size={14} className={loading ? 'animate-spin' : ''} /></button>
          {view === 'tasks' && <button data-codex-btn="new-task" className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent-main-100 px-3 text-[length:var(--fs-sm)] text-oncolor-100 transition-colors hover:bg-accent-main-200" onClick={() => { setDraftInput(undefined); setEditing('new') }}><PlusIcon size={13} />{t('taskPanel.newTask')}</button>}
        </div>
      </div>
      <div role="tablist" aria-label={t('taskPanel.title')} className="flex shrink-0 gap-1 border-b border-border-200/40 px-6 py-2">
         {([['tasks', t('taskPanel.taskList'), tasks.length], ['attention', '需要处理', attentionRuns.length], ['runs', t('taskPanel.runHistory'), runTotal], ['artifacts', t('taskPanel.artifacts'), artifacts.length]] as const).map(item => <button role="tab" aria-selected={view === item[0]} key={item[0]} onClick={() => setView(item[0])} className={`rounded-md px-3 py-1.5 text-[length:var(--fs-sm)] transition-colors ${view === item[0] ? 'bg-bg-200 text-text-100' : 'text-text-400 hover:text-text-200'}`}>{item[1]}<span className={`ml-1.5 text-[length:var(--fs-xs)] ${item[0] === 'attention' && item[2] > 0 ? 'text-danger-100' : 'text-text-500'}`}>{item[2]}</span></button>)}
      </div>
      <div className="flex-1 overflow-auto px-6 py-5">
         {view === 'artifacts' ? <><AutomationArtifacts artifacts={artifacts} /><RunHistoryLoadMore hasMore={runHasMore} loading={runLoadingMore} onLoadMore={loadMoreRuns} /></> : view === 'runs' ? <TaskRunList runs={runs} loading={loading} onOpenSession={onOpenSession} onChanged={load} runLogs={runLogs} runLogLoadingID={runLogLoadingID} onLoadLog={loadRunLog} onClearLog={clearRunLog} onExportLog={exportRunLog} hasMore={runHasMore} loadingMore={runLoadingMore} onLoadMore={loadMoreRuns} /> : view === 'attention' ? <div><div className="mb-3 flex items-center justify-between"><p className="text-[length:var(--fs-sm)] text-text-400">集中处理失败、超时、阻塞和恢复中的后台任务。</p><button disabled={!attentionRuns.length} onClick={() => { const next = [...new Set([...handledRunIDs, ...attentionRuns.map(run => run.id)])]; setHandledRunIDs(next); localStorage.setItem(handledRunStorageKey, JSON.stringify(next.slice(-2000))) }} className="rounded-lg px-3 py-1.5 text-[length:var(--fs-sm)] text-text-300 hover:bg-bg-200 disabled:opacity-40">全部标记为已处理</button></div><TaskRunList runs={attentionRuns} loading={loading} onOpenSession={onOpenSession} onChanged={load} runLogs={runLogs} runLogLoadingID={runLogLoadingID} onLoadLog={loadRunLog} onClearLog={clearRunLog} onExportLog={exportRunLog} hasMore={runHasMore} loadingMore={runLoadingMore} onLoadMore={loadMoreRuns} /></div> : <>
        <details className="mb-4 rounded-lg border border-border-200/50 bg-bg-200/20 px-3 py-2 text-[length:var(--fs-xs)] text-text-300"><summary className="cursor-pointer select-none">{t('taskPanel.schedulerSettings')}</summary><div className="mt-3 grid grid-cols-4 gap-3"><label>{t('taskPanel.globalConcurrency')}<input type="number" min={1} max={20} value={settings.maxConcurrency} onChange={event => setSettings(current => ({ ...current, maxConcurrency: Number(event.target.value) }))} onBlur={() => void window.customOpenCode.updateTaskSettings(settings).then(setSettings).catch(cause => setError(cause instanceof Error ? cause.message : t('taskPanel.saveFailed')))} className="mt-1 h-8 w-full rounded border border-border-200 bg-bg-100 px-2" /></label><label>{t('taskPanel.retentionDays')}<input type="number" min={1} max={365} value={settings.historyRetentionDays} onChange={event => setSettings(current => ({ ...current, historyRetentionDays: Number(event.target.value) }))} onBlur={() => void window.customOpenCode.updateTaskSettings(settings).then(setSettings).catch(cause => setError(cause instanceof Error ? cause.message : t('taskPanel.saveFailed')))} className="mt-1 h-8 w-full rounded border border-border-200 bg-bg-100 px-2" /></label><label>{t('taskPanel.maxHistory')}<input type="number" min={100} max={10000} value={settings.maxHistory} onChange={event => setSettings(current => ({ ...current, maxHistory: Number(event.target.value) }))} onBlur={() => void window.customOpenCode.updateTaskSettings(settings).then(setSettings).catch(cause => setError(cause instanceof Error ? cause.message : t('taskPanel.saveFailed')))} className="mt-1 h-8 w-full rounded border border-border-200 bg-bg-100 px-2" /></label><label>{t('taskPanel.webhookPort')}<input type="number" min={1024} max={65535} value={settings.webhookPort} onChange={event => setSettings(current => ({ ...current, webhookPort: Number(event.target.value) }))} onBlur={() => void window.customOpenCode.updateTaskSettings(settings).then(setSettings).catch(cause => setError(cause instanceof Error ? cause.message : t('taskPanel.saveFailed')))} className="mt-1 h-8 w-full rounded border border-border-200 bg-bg-100 px-2" /></label></div></details>
        <div role="group" aria-label={t('taskPanel.taskFilter')} className="mb-5 flex gap-1 rounded-lg bg-bg-200/50 p-1 w-fit">
          {([['all', t('taskPanel.all')], ['enabled', t('taskPanel.enabled')], ['paused', t('taskPanel.paused')]] as const).map(item => (
            <button aria-pressed={filter === item[0]} key={item[0]} onClick={() => setFilter(item[0])} className={`rounded-md px-3 py-1 text-[length:var(--fs-sm)] ${filter === item[0] ? 'bg-bg-100 text-text-100 shadow-sm' : 'text-text-400'}`}>{item[1]}</button>
          ))}
        </div>
        {error && <div role="alert" className="mb-3 rounded-lg bg-danger-100/10 p-3 text-danger-100 text-[length:var(--fs-sm)]">{error}</div>}
        {loading && !tasks.length ? <div className="flex justify-center py-20 text-text-400"><SpinnerIcon size={20} className="animate-spin" /></div> : null}
        {!loading && !visible.length ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border-200 py-20 text-text-400">
            <ClockIcon size={28} /><div className="mt-3 text-text-200">{t('taskPanel.empty')}</div><div className="mt-1 text-[length:var(--fs-sm)]">{t('taskPanel.emptyHint')}</div>
          </div>
        ) : (
          <div className="space-y-2">
            {visible.map(task => (
              <div key={task.id} className="group rounded-xl border border-border-200/60 bg-bg-100 p-4 transition-colors hover:bg-bg-200/20">
                <div className="flex items-start gap-3">
                  <button role="switch" aria-checked={task.enabled} disabled={busy === task.id} onClick={() => void update(task, { ...task, enabled: !task.enabled })} className={`mt-0.5 inline-flex h-5 w-9 items-center rounded-full p-0.5 transition-colors ${task.enabled ? 'bg-success-100' : 'bg-bg-300'}`} title={task.enabled ? t('taskPanel.pause') : t('taskPanel.enable')} aria-label={task.enabled ? t('taskPanel.pause') : t('taskPanel.enable')}><span className={`h-4 w-4 rounded-full bg-white transition-transform ${task.enabled ? 'translate-x-4' : ''}`} /></button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2"><span className="font-medium text-text-100">{task.title}</span><Status task={task} /></div>
                    <div className="mt-1 truncate text-[length:var(--fs-sm)] text-text-300">{task.prompt}</div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[length:var(--fs-xs)] text-text-400"><span>{describeTrigger(task, tasks, t)}</span><span>{t('taskPanel.serverValue', { name: task.serverName })}</span><span>{t('taskPanel.projectValue', { name: task.directory || t('taskPanel.global') })}</span><span>{task.executionMode === 'worktree' ? t('taskPanel.isolatedWorktree') : t('taskPanel.currentDirectory')}{task.branch ? ` · ${task.branch}` : ''}</span><span>{t('taskPanel.modelValue', { model: `${task.modelProviderID}/${task.modelID}` })}</span><span>{t('taskPanel.permissionValue', { value: permissionLabel(task.permissionProfile, t) })}</span><span>{t('taskPanel.retryValue', { count: task.retryCount })}</span><span>{t('taskPanel.overlapValue', { value: task.overlapPolicy === 'queue' ? t('taskPanel.queued') : task.overlapPolicy === 'parallel' ? t('taskPanel.parallelValue', { count: task.maxConcurrentRuns }) : t('taskPanel.skip') })}</span>{task.dependencyTaskIds.length ? <span>{t('taskPanel.dependencyCount', { count: task.dependencyTaskIds.length })}</span> : null}<span>{t('taskPanel.notificationCount', { count: task.notificationChannels.length })}</span>{task.triggerType === 'schedule' ? <><span>{t('taskPanel.missedValue', { value: task.missedRunPolicy === 'run-once' ? t('taskPanel.catchUpValue', { count: task.catchUpWindowMinutes }) : t('taskPanel.skip') })}</span><span>{task.timezone}</span></> : null}{task.nextRunAt && <span>{t('taskPanel.nextRun', { date: new Date(task.nextRunAt).toLocaleString() })}</span>}{task.lastRunAt && <span>{t('taskPanel.lastRun', { date: new Date(task.lastRunAt).toLocaleString() })}</span>}</div>
                    {task.lastError && <div className="mt-2 text-[length:var(--fs-xs)] text-danger-100">{task.lastError}</div>}
                  </div>
                  <div className="flex opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    {task.status === 'running' ? <button disabled={busy === task.id} className="h-7 rounded-md px-2 text-[length:var(--fs-xs)] text-danger-100 hover:bg-danger-100/10 disabled:opacity-50" onClick={() => void performTaskAction(task.id, () => window.customOpenCode.cancelTask(task.id))}>{t('taskPanel.stop')}</button> : <button disabled={busy === task.id} className="h-7 rounded-md px-2 text-[length:var(--fs-xs)] text-text-300 hover:bg-bg-200 disabled:opacity-50" onClick={() => void performTaskAction(task.id, () => window.customOpenCode.runTask(task.id))}>{t('taskPanel.runNow')}</button>}
                    <button className="h-7 rounded-md px-2 text-[length:var(--fs-xs)] text-text-300 hover:bg-bg-200" onClick={() => { setDraftInput({ ...taskInputFromTask(task), title: t('taskPanel.copyName', { name: task.title }), enabled: true }); setEditing('new') }}>{t('taskPanel.copy')}</button>
                    <button className="h-7 w-7 rounded-md text-text-300 hover:bg-bg-200" onClick={() => setEditing(task)} title={t('taskPanel.editTask')} aria-label={t('taskPanel.editTask')}><PencilIcon size={12} /></button>
                    <button className="h-7 w-7 rounded-md text-text-300 hover:bg-danger-100/10 hover:text-danger-100" onClick={() => setDeleteTask(task)} title={t('common:delete')} aria-label={t('common:delete')}><TrashIcon size={12} /></button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}</>}
      </div>
      {editing && <TaskDialog task={editing === 'new' ? undefined : editing} initialInput={editing === 'new' ? draftInput : undefined} tasks={tasks} directory={currentDirectory ?? pathInfo?.directory ?? ''} directories={directories} servers={servers} activeServer={activeServer} onSaveTemplate={input => { const existing = templates.find(item => item.name === input.title); storeTemplates(existing ? templates.map(item => item.id === existing.id ? { ...item, input } : item) : [...templates, { id: crypto.randomUUID(), name: input.title, input }]) }} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await load() }} />}
      <ConfirmDialog isOpen={deleteTask !== null} onClose={() => setDeleteTask(null)} onConfirm={() => {
        if (!deleteTask) return
        void window.customOpenCode.removeTask(deleteTask.id).then(async () => { setDeleteTask(null); await load() }).catch(cause => setError(cause instanceof Error ? cause.message : t('taskPanel.deleteFailed')))
      }} title={t('taskPanel.deleteTitle')} description={deleteTask ? t('taskPanel.deleteDescription', { title: deleteTask.title }) : ''} confirmText={t('common:delete')} variant="danger" />
      <ConfirmDialog isOpen={deleteTemplate !== null} onClose={() => setDeleteTemplate(null)} onConfirm={() => {
        if (!deleteTemplate) return
        storeTemplates(templates.filter(item => item.id !== deleteTemplate.id))
        setSelectedTemplateId('')
        setDeleteTemplate(null)
      }} title={t('taskPanel.deleteTemplateTitle')} description={deleteTemplate ? t('taskPanel.deleteTemplateDescription', { name: deleteTemplate.name }) : ''} confirmText={t('common:delete')} variant="danger" />
    </div>
  )
})

type AutomationArtifact = { id: string; runID: string; taskTitle: string; type: 'log' | 'image' | 'video' | 'pull-request' | 'link'; value: string; createdAt: number }

function collectAutomationArtifacts(runs: TaskRun[], runLogs: Record<string, string>): AutomationArtifact[] {
  return runs.flatMap(run => {
    const log = runLogs[run.id] ?? run.logPreview
    const text = `${log}\n${run.error ?? ''}`
    const links = [...new Set(text.match(/https?:\/\/[^\s<>'"\])]+/g) ?? [])]
    return [
      ...(log || run.error ? [{ id: `${run.id}:log`, runID: run.id, taskTitle: run.taskTitle, type: 'log' as const, value: log || run.error || '', createdAt: run.createdAt }] : []),
      ...links.map((value, index) => ({ id: `${run.id}:url:${index}`, runID: run.id, taskTitle: run.taskTitle, type: classifyArtifact(value), value, createdAt: run.createdAt })),
    ]
  }).toSorted((left, right) => right.createdAt - left.createdAt)
}

function classifyArtifact(value: string): AutomationArtifact['type'] {
  if (/\.(png|jpe?g|gif|webp)(?:\?|$)/i.test(value)) return 'image'
  if (/\.(mp4|webm|mov)(?:\?|$)/i.test(value)) return 'video'
  if (/github\.com\/[^/]+\/[^/]+\/pull\/\d+|gitlab\.[^/]+\/.+\/merge_requests\/\d+/i.test(value)) return 'pull-request'
  return 'link'
}

function AutomationArtifacts({ artifacts }: { artifacts: AutomationArtifact[] }) {
  const { t } = useTranslation('components')
  const [filter, setFilter] = useState<'all' | AutomationArtifact['type']>('all')
  const visible = artifacts.filter(artifact => filter === 'all' || artifact.type === filter)
  return <div><div className="mb-4 flex items-center justify-between gap-3"><div className="flex gap-1">{(['all', 'log', 'image', 'video', 'pull-request', 'link'] as const).map(type => <button key={type} onClick={() => setFilter(type)} className={`rounded-md px-2.5 py-1.5 text-[length:var(--fs-xs)] ${filter === type ? 'bg-bg-200 text-text-100' : 'text-text-400 hover:text-text-200'}`}>{type}</button>)}</div><Button size="sm" variant="ghost" disabled={!artifacts.length} onClick={() => saveData(new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), artifacts }, null, 2)), 'automation-artifacts.json', 'application/json')}>{t('taskPanel.exportManifest')}</Button></div>{visible.length === 0 ? <div className="rounded-xl border border-dashed border-border-200 py-20 text-center text-[length:var(--fs-sm)] text-text-400">{t('taskPanel.noArtifacts')}</div> : <div className="grid gap-2 md:grid-cols-2">{visible.map(artifact => <div key={artifact.id} className="rounded-xl border border-border-200/60 bg-bg-100 p-3"><div className="flex items-center justify-between"><span className="rounded bg-bg-200 px-2 py-0.5 text-[length:var(--fs-xxs)] text-text-300">{artifact.type}</span><span className="text-[length:var(--fs-xxs)] text-text-500">{new Date(artifact.createdAt).toLocaleString()}</span></div><div className="mt-2 truncate text-[length:var(--fs-sm)] font-medium text-text-200">{artifact.taskTitle}</div>{artifact.type === 'image' ? <img src={artifact.value} className="mt-2 max-h-44 w-full rounded-lg object-contain bg-bg-200" /> : artifact.type === 'video' ? <video src={artifact.value} controls className="mt-2 max-h-44 w-full rounded-lg bg-black" /> : <div className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-[length:var(--fs-xxs)] text-text-400">{artifact.value}</div>}<div className="mt-2 flex justify-end">{artifact.type === 'log' ? <Button size="sm" variant="ghost" onClick={() => saveData(new TextEncoder().encode(artifact.value), `automation-${artifact.runID}.log`, 'text/plain')}>{t('taskPanel.exportLog')}</Button> : <Button size="sm" variant="ghost" onClick={() => void window.customOpenCode.openExternalUrl(artifact.value)}>{t('taskPanel.openArtifact')}</Button>}</div></div>)}</div>}</div>
}

function RunHistoryLoadMore({ hasMore, loading, onLoadMore }: { hasMore: boolean; loading: boolean; onLoadMore: () => Promise<void> }) {
  if (!hasMore) return null
  return <div className="flex justify-center py-4"><Button size="sm" variant="ghost" disabled={loading} onClick={() => void onLoadMore()}>{loading ? '加载中...' : '加载更多记录'}</Button></div>
}

function TaskRunList({
  runs,
  loading,
  onOpenSession,
  onChanged,
  runLogs,
  runLogLoadingID,
  onLoadLog,
  onClearLog,
  onExportLog,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  runs: TaskRun[]
  loading: boolean
  onOpenSession: (sessionID: string, directory: string) => void
  onChanged: () => Promise<void>
  runLogs: Record<string, string>
  runLogLoadingID: string | null
  onLoadLog: (runID: string) => Promise<string>
  onClearLog: (runID: string) => void
  onExportLog: (runID: string, fallback?: string) => Promise<void>
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => Promise<void>
}) {
  const { t } = useTranslation(['components'])
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'all' | 'active' | 'success' | 'error'>('all')
  const [busy, setBusy] = useState('')
  const [actionError, setActionError] = useState('')
  const deferredSearch = useDeferredValue(search.trim().toLowerCase())
  const searchIndex = useMemo(() => {
    if (!deferredSearch) return null
    return new Map(runs.map(run => [run.id, `${run.taskTitle} ${run.prompt} ${run.directory} ${run.modelProviderID} ${run.modelID} ${run.logPreview} ${runLogs[run.id] ?? ''}`.toLowerCase()]))
  }, [deferredSearch, runLogs, runs])
  const perform = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id)
    setActionError('')
    try {
      await action()
      await onChanged()
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t('taskPanel.actionFailed'))
    } finally {
      setBusy('')
    }
  }
  const filtered = useMemo(() => runs.filter(run => {
    const active = run.status === 'queued' || run.status === 'running' || run.status === 'submitted' || run.status === 'recovering'
    if (status === 'active' && !active) return false
    if (status === 'success' && run.status !== 'completed') return false
    if (status === 'error' && !['failed', 'timed_out', 'cancelled', 'blocked'].includes(run.status)) return false
    return !deferredSearch || searchIndex?.get(run.id)?.includes(deferredSearch) === true
  }), [deferredSearch, runs, searchIndex, status])
  const groups = useMemo(() => Array.from(filtered.reduce((result, run) => {
    const group = result.get(run.taskID) ?? { title: run.taskTitle, runs: [] as TaskRun[] }
    group.runs.push(run)
    result.set(run.taskID, group)
    return result
  }, new Map<string, { title: string; runs: TaskRun[] }>()).values()), [filtered])

  return <div>
    <div className="mb-5 flex gap-2"><div className="relative flex-1"><SearchIcon size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-400" /><input value={search} onChange={event => setSearch(event.target.value)} placeholder={t('taskPanel.searchRuns')} aria-label={t('taskPanel.searchRuns')} className="h-9 w-full rounded-lg border border-border-200/60 bg-bg-200/30 pl-9 pr-3 text-[length:var(--fs-sm)] text-text-100 outline-none transition-colors placeholder:text-text-500 focus:border-border-100 focus:bg-bg-100" /></div><select value={status} onChange={event => setStatus(event.target.value as typeof status)} aria-label={t('taskPanel.statusFilter')} className="h-9 rounded-lg border border-border-200/60 bg-bg-100 px-3 text-[length:var(--fs-sm)] text-text-200"><option value="all">{t('taskPanel.allStatuses')}</option><option value="active">{t('taskPanel.active')}</option><option value="success">{t('taskPanel.success')}</option><option value="error">{t('taskPanel.failedOrCancelled')}</option></select></div>
    {actionError && <div role="alert" className="mb-3 rounded-lg bg-danger-100/10 p-3 text-[length:var(--fs-xs)] text-danger-100">{actionError}</div>}
    {loading && runs.length === 0 ? <div className="flex justify-center py-20 text-text-400"><SpinnerIcon size={20} className="animate-spin" /></div> : null}
    {!loading && groups.length === 0 ? <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border-200 py-20 text-text-400"><MessageSquareIcon size={28} /><div className="mt-3 text-text-200">{t('taskPanel.noRuns')}</div><div className="mt-1 text-[length:var(--fs-sm)]">{t('taskPanel.noRunsHint')}</div></div> : null}
    <div className="space-y-5">{groups.map(group => <section key={group.runs[0].taskID}>
      <div className="mb-2 flex items-center gap-2 px-1"><span className="text-[length:var(--fs-sm)] font-medium text-text-200">{group.title}</span><span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-bg-200 px-1.5 text-[length:var(--fs-xxs)] text-text-400">{group.runs.length}</span></div>
      <div className="overflow-hidden rounded-xl border border-border-200/60 bg-bg-100">{group.runs.map((run, index) => {
        const active = run.status === 'queued' || run.status === 'running' || run.status === 'submitted' || run.status === 'recovering'
        const canOpen = !run.sessionID.startsWith('pending:') && serverStore.getServers().some(server => server.id === run.serverId)
        const log = runLogs[run.id] ?? run.logPreview
        return <div key={run.id} className={index > 0 ? 'border-t border-border-200/45' : ''} style={{ contentVisibility: 'auto', containIntrinsicSize: '92px' }}>
          <div className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-200/35">
            <span className={`h-2 w-2 shrink-0 rounded-full ${run.status === 'failed' || run.status === 'timed_out' || run.status === 'blocked' ? 'bg-danger-100' : active ? 'bg-warning-100' : run.status === 'cancelled' ? 'bg-text-500' : 'bg-success-100'}`} />
            <button type="button" disabled={!canOpen} onClick={() => { serverStore.setActiveServer(run.serverId); executionTargetStore.bindSession(run.sessionID, { serverId: run.serverId, directory: run.executionDirectory, sourceDirectory: run.directory, executionMode: run.executionMode, branch: run.branch || undefined, permissionProfile: run.permissionProfile }); onOpenSession(run.sessionID, run.executionDirectory) }} className="min-w-0 flex-1 text-left disabled:cursor-not-allowed disabled:opacity-60">
              <div className="flex items-center gap-2"><span className="truncate text-[length:var(--fs-sm)] font-medium text-text-100">{run.prompt}</span><span className={`shrink-0 rounded px-1.5 py-0.5 text-[length:var(--fs-xxs)] ${run.status === 'failed' || run.status === 'timed_out' || run.status === 'blocked' ? 'bg-danger-100/10 text-danger-100' : active ? 'bg-warning-100/10 text-warning-100' : run.status === 'cancelled' ? 'bg-bg-200 text-text-400' : 'bg-success-100/10 text-success-100'}`}>{runStatusLabel(run.status, t)}</span></div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[length:var(--fs-xs)] text-text-400"><span>{new Date(run.createdAt).toLocaleString()}</span><span>{run.serverName}</span><span>{run.executionDirectory || run.directory || t('taskPanel.global')}</span><span>{run.executionMode === 'worktree' ? 'Worktree' : t('taskPanel.currentDirectory')}{run.branch ? ` · ${run.branch}` : ''}</span><span>{t('taskPanel.attempt', { count: run.attempt })}</span><span>{run.modelProviderID}/{run.modelID}</span></div>{run.error && <div className="mt-1 text-[length:var(--fs-xs)] text-danger-100">{run.error}</div>}
            </button>
             {active ? <button type="button" disabled={busy === run.id} onClick={() => void perform(run.id, () => window.customOpenCode.cancelTaskRun(run.id))} className="rounded-md px-2 py-1 text-[length:var(--fs-xs)] text-danger-100 hover:bg-danger-100/10 disabled:opacity-50">{t('taskPanel.stop')}</button> : <><button type="button" disabled={busy === run.id} onClick={() => void perform(run.id, () => window.customOpenCode.runTask(run.taskID))} className="rounded-md px-2 py-1 text-[length:var(--fs-xs)] text-text-300 hover:bg-bg-200 disabled:opacity-50">{t('taskPanel.runAgain')}</button><button type="button" onClick={() => void onExportLog(run.id, run.error ?? '')} className="rounded-md px-2 py-1 text-[length:var(--fs-xs)] text-text-300 hover:bg-bg-200">{t('taskPanel.exportLog')}</button><button type="button" disabled={busy === run.id} onClick={() => void perform(run.id, () => window.customOpenCode.setTaskRunArchived(run.sessionID, true))} className="rounded-md px-2 py-1 text-[length:var(--fs-xs)] text-text-400 hover:bg-bg-200 disabled:opacity-50">{t('taskPanel.archive')}</button></>}
          </div>
           {log ? <details className="border-t border-border-200/30 bg-bg-200/15 px-4 py-2" onToggle={event => { if (event.currentTarget.open) void onLoadLog(run.id); else onClearLog(run.id) }}><summary className="cursor-pointer text-[length:var(--fs-xs)] text-text-400">{t('taskPanel.runLog')}</summary>{runLogLoadingID === run.id ? <div className="mt-2 text-[length:var(--fs-xxs)] text-text-400">加载日志中...</div> : <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap text-[length:var(--fs-xxs)] leading-5 text-text-300">{log}</pre>}</details> : null}
        </div>
      })}</div>
    </section>)}</div>
    <RunHistoryLoadMore hasMore={hasMore} loading={loadingMore} onLoadMore={onLoadMore} />
  </div>
}

function Status({ task }: { task: Task }) {
  const { t } = useTranslation('components')
  const label = task.status === 'running' ? t('taskPanel.running') : task.status === 'error' ? t('taskPanel.error') : task.enabled ? t('taskPanel.enabled') : t('taskPanel.paused')
  return <span role="status" className={`rounded-full px-2 py-0.5 text-[length:var(--fs-xxs)] ${task.status === 'running' ? 'bg-warning-100/10 text-warning-100' : task.status === 'error' ? 'bg-danger-100/10 text-danger-100' : task.enabled ? 'bg-success-100/10 text-success-100' : 'bg-bg-200 text-text-400'}`}>{label}</span>
}

function TaskDialog({ task, initialInput, tasks, directory, directories, servers, activeServer, onSaveTemplate, onClose, onSaved }: { task?: Task; initialInput?: TaskInput; tasks: Task[]; directory: string; directories: Array<{ path: string; name: string }>; servers: ServerConfig[]; activeServer: ServerConfig | null; onSaveTemplate: (input: TaskInput) => void; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation(['components', 'common'])
  const inputClass = 'rounded-lg border border-border-200/70 bg-bg-100 px-3 text-[length:var(--fs-sm)] text-text-100 outline-none transition-colors placeholder:text-text-500 focus:border-border-100'
  const source = task ?? initialInput
  const initial = source ? cronParts(source.cron) : { frequency: 'daily' as Frequency, time: '18:00', day: '1' }
  const [title, setTitle] = useState(source?.title ?? '')
  const [prompt, setPrompt] = useState(source?.prompt ?? '')
  const [frequency, setFrequency] = useState<Frequency>(initial.frequency)
  const [time, setTime] = useState(initial.time)
  const [day, setDay] = useState(initial.day)
  const [expression, setExpression] = useState(source?.cron ?? '0 18 * * *')
  const [timezone, setTimezone] = useState(source?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [selectedDirectory, setSelectedDirectory] = useState(source?.directory ?? directory)
  const [selectedServerId, setSelectedServerId] = useState(source?.serverId ?? activeServer?.id ?? '')
  const { models, isLoading: modelsLoading } = useModels(selectedServerId || undefined)
  const [serverDirectories, setServerDirectories] = useState<Array<{ path: string; name: string }>>([])
  const [executionMode, setExecutionMode] = useState<'current' | 'worktree'>(source?.executionMode ?? 'current')
  const [worktreeCleanup, setWorktreeCleanup] = useState<'always' | 'on-success' | 'never'>(source?.worktreeCleanup ?? 'on-success')
  const [branch, setBranch] = useState(source?.branch ?? '')
  const [permissionProfile, setPermissionProfile] = useState<'ask' | 'writes' | 'risk' | 'full'>(source?.permissionProfile ?? 'risk')
  const [retryCount, setRetryCount] = useState(source?.retryCount ?? 1)
  const [retryDelaySeconds, setRetryDelaySeconds] = useState(source?.retryDelaySeconds ?? 30)
  const [completionTimeoutMinutes, setCompletionTimeoutMinutes] = useState(source?.completionTimeoutMinutes ?? 60)
  const [overlapPolicy, setOverlapPolicy] = useState<'skip' | 'queue' | 'parallel'>(source?.overlapPolicy ?? 'skip')
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState(source?.maxConcurrentRuns ?? 1)
  const [missedRunPolicy, setMissedRunPolicy] = useState<'skip' | 'run-once'>(source?.missedRunPolicy ?? 'run-once')
  const [catchUpWindowMinutes, setCatchUpWindowMinutes] = useState(source?.catchUpWindowMinutes ?? 60)
  const [triggerType, setTriggerType] = useState<TaskInput['triggerType']>(source?.triggerType ?? 'schedule')
  const [triggerTaskId, setTriggerTaskId] = useState(source?.triggerTaskId ?? '')
  const [dependencyTaskIds, setDependencyTaskIds] = useState(source?.dependencyTaskIds ?? [])
  const [notificationChannels, setNotificationChannels] = useState<TaskInput['notificationChannels']>(source?.notificationChannels ?? ['desktop'])
  const [notificationWebhookUrl, setNotificationWebhookUrl] = useState(source?.notificationWebhookUrl ?? '')
  const [selectedModelKey, setSelectedModelKey] = useState(source?.modelProviderID && source.modelID ? taskModelKey(source.modelProviderID, source.modelID) : '')
  const [variant, setVariant] = useState(source?.variant ?? '')
  const [error, setError] = useState('')
  const [templateSaved, setTemplateSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [preflight, setPreflight] = useState<{ ok: boolean; messages: string[]; nextRuns: Date[] }>()
  const selectedModel = models.find(model => taskModelKey(model.providerId, model.id) === selectedModelKey)
  const selectedServer = servers.find(server => server.id === selectedServerId)
  const selectedCapabilities = selectedServer ? serverStore.getHealth(selectedServer.id)?.capabilities : undefined
  const referenceTasks = tasks.filter(item => item.id !== task?.id)
  const availableDirectories = useMemo(() => Array.from(new Map([
    ...(selectedServerId === activeServer?.id ? directories : []),
    ...serverDirectories,
    ...(selectedDirectory ? [{ path: selectedDirectory, name: selectedDirectory }] : []),
  ].map(item => [item.path, item])).values()), [activeServer?.id, directories, selectedDirectory, selectedServerId, serverDirectories])

  useEffect(() => {
    if (!selectedServerId) return
    let disposed = false
    void getProjects(undefined, selectedServerId).then(projects => {
      if (disposed) return
      setServerDirectories(projects.filter(project => project.worktree).map(project => ({ path: project.worktree, name: project.name || project.worktree })))
    }).catch(() => {
      if (!disposed) setServerDirectories([])
    })
    return () => { disposed = true }
  }, [selectedServerId])

  useEffect(() => {
    if (selectedModelKey || models.length === 0) return
    setSelectedModelKey(taskModelKey(models[0].providerId, models[0].id))
  }, [models, selectedModelKey])

  const currentInput = (): TaskInput => {
    if (!selectedModel) throw new Error(t('taskPanel.selectModelError'))
    if (!selectedServer) throw new Error(t('taskPanel.selectServerError'))
    return {
      title,
      prompt,
      cron: frequency === 'advanced' ? expression : buildCron(frequency, time, day),
      timezone,
      serverId: selectedServer.id,
      serverName: selectedServer.name,
      serverUrl: selectedServer.url,
      directory: selectedDirectory,
      executionMode,
      worktreeCleanup,
      branch,
      permissionProfile,
      retryCount,
      retryDelaySeconds,
      completionTimeoutMinutes,
      overlapPolicy,
      maxConcurrentRuns,
      missedRunPolicy,
      catchUpWindowMinutes,
      triggerType,
      triggerTaskId,
      dependencyTaskIds,
      notificationChannels,
      notificationWebhookUrl,
      modelProviderID: selectedModel.providerId,
      modelID: selectedModel.id,
      variant,
      enabled: task?.enabled ?? true,
    }
  }

  const save = async () => {
    setSaving(true); setError('')
    try {
      const input = currentInput()
      const health = await serverStore.checkHealth(input.serverId)
      if (health.status !== 'online') throw new Error(health.error || t('taskPanel.serverUnavailable'))
      if (executionMode === 'worktree' && !health.capabilities?.worktree) throw new Error(t('taskPanel.worktreeUnsupported'))
      if (branch && !health.capabilities?.vcsMutations) throw new Error(t('taskPanel.branchUnsupported'))
      if (task) await window.customOpenCode.updateTask(task.id, input)
      else await window.customOpenCode.createTask(input)
      onSaved()
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('taskPanel.saveFailed')) } finally { setSaving(false) }
  }
  const preview = async () => {
    setSaving(true)
    setError('')
    try {
      const input = currentInput()
      const messages: string[] = []
      const health = await serverStore.checkHealth(input.serverId)
      if (health.status !== 'online') throw new Error(health.error || t('taskPanel.serverUnavailable'))
      messages.push(`服务器在线${health.latency !== undefined ? ` · ${health.latency}ms` : ''}${health.version ? ` · OpenCode ${health.version}` : ''}`)
      if (!input.directory) messages.push('未配置项目目录，将使用服务器默认目录。')
      if (input.executionMode === 'worktree' && !health.capabilities?.worktree) throw new Error(t('taskPanel.worktreeUnsupported'))
      if (input.branch && !health.capabilities?.vcsMutations) throw new Error(t('taskPanel.branchUnsupported'))
      if (input.executionMode === 'worktree') messages.push(`将从 ${input.branch || '当前分支'} 创建隔离 Worktree`)
      if (input.dependencyTaskIds.some(id => id === task?.id)) throw new Error('任务不能依赖自身。')
      const nextRuns = input.triggerType === 'schedule' ? new Cron(input.cron, { timezone: input.timezone, paused: true }).nextRuns(5) : []
      if (input.triggerType === 'schedule' && nextRuns.length === 0) throw new Error('Cron 表达式没有可执行的未来时间。')
      messages.push(`模型 ${input.modelProviderID}/${input.modelID}${input.variant ? ` · ${input.variant}` : ''}`)
      messages.push(`权限 ${input.permissionProfile} · 超时 ${input.completionTimeoutMinutes} 分钟 · 最多重试 ${input.retryCount} 次`)
      setPreflight({ ok: true, messages, nextRuns })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t('taskPanel.actionFailed')
      setPreflight({ ok: false, messages: [message], nextRuns: [] })
      setError(message)
    } finally {
      setSaving(false)
    }
  }
  return <Dialog isOpen onClose={onClose} title={t(task ? 'taskPanel.editTask' : 'taskPanel.newTask')} width={576}>
      <div className="space-y-4">
        <div><Label>{t('taskPanel.name')}</Label><input aria-label={t('taskPanel.name')} value={title} onChange={e => setTitle(e.target.value)} className={`${inputClass} h-9 w-full`} placeholder={t('taskPanel.namePlaceholder')} /></div>
        <div><Label>{t('taskPanel.prompt')}</Label><textarea aria-label={t('taskPanel.prompt')} value={prompt} onChange={e => setPrompt(e.target.value)} className={`${inputClass} min-h-24 w-full resize-y py-2`} placeholder={t('taskPanel.promptPlaceholder')} /></div>
        <div><Label>{t('taskPanel.server')}</Label><select aria-label={t('taskPanel.server')} value={selectedServerId} onChange={e => { setSelectedServerId(e.target.value); setSelectedDirectory(''); setSelectedModelKey(''); setVariant('') }} className={`${inputClass} h-9 w-full`}>{servers.map(server => <option key={server.id} value={server.id}>{server.name} — {server.url}</option>)}</select></div>
        <div><Label>{t('taskPanel.project')}</Label><input aria-label={t('taskPanel.project')} list="scheduled-task-directories" value={selectedDirectory} onChange={e => setSelectedDirectory(e.target.value)} className={`${inputClass} h-9 w-full`} placeholder={t('taskPanel.projectPlaceholder')} /><datalist id="scheduled-task-directories">{availableDirectories.map(item => <option key={item.path} value={item.path}>{item.name}</option>)}</datalist></div>
        <div className="grid grid-cols-2 gap-2"><div><Label>{t('taskPanel.executionLocation')}</Label><select aria-label={t('taskPanel.executionLocation')} value={executionMode} onChange={e => setExecutionMode(e.target.value as 'current' | 'worktree')} className={`${inputClass} h-9 w-full`}><option value="current">{t('taskPanel.currentDirectory')}</option><option value="worktree" disabled={!selectedDirectory || selectedCapabilities?.worktree === false}>{t('taskPanel.isolatedWorktree')}</option></select></div><div><Label>{t('taskPanel.baseBranch')}</Label><input aria-label={t('taskPanel.baseBranch')} value={branch} onChange={e => setBranch(e.target.value)} disabled={!selectedDirectory || selectedCapabilities?.vcsMutations === false} className={`${inputClass} h-9 w-full`} placeholder={t('taskPanel.branchPlaceholder')} /></div></div>
        {executionMode === 'worktree' ? <div><Label>{t('taskPanel.worktreeCleanup')}</Label><select aria-label={t('taskPanel.worktreeCleanup')} value={worktreeCleanup} onChange={event => setWorktreeCleanup(event.target.value as 'always' | 'on-success' | 'never')} className={`${inputClass} h-9 w-full`}><option value="on-success">{t('taskPanel.cleanupSuccess')}</option><option value="always">{t('taskPanel.cleanupAlways')}</option><option value="never">{t('taskPanel.cleanupNever')}</option></select></div> : null}
        <div className="grid grid-cols-2 gap-2"><div><Label>{t('taskPanel.permissions')}</Label><select aria-label={t('taskPanel.permissions')} value={permissionProfile} onChange={e => setPermissionProfile(e.target.value as 'ask' | 'writes' | 'risk' | 'full')} className={`${inputClass} h-9 w-full`}><option value="ask">{t('taskPanel.permissionAsk')}</option><option value="writes">{t('taskPanel.permissionWrites')}</option><option value="risk">{t('taskPanel.permissionRisk')}</option><option value="full">{t('taskPanel.permissionFull')}</option></select></div><div><Label>{t('taskPanel.timeout')}</Label><input aria-label={t('taskPanel.timeout')} type="number" min={1} max={1440} value={completionTimeoutMinutes} onChange={e => setCompletionTimeoutMinutes(Number(e.target.value))} className={`${inputClass} h-9 w-full`} /></div></div>
        <div className="grid grid-cols-2 gap-2"><div><Label>{t('taskPanel.retryCount')}</Label><input aria-label={t('taskPanel.retryCount')} type="number" min={0} max={10} value={retryCount} onChange={e => setRetryCount(Number(e.target.value))} className={`${inputClass} h-9 w-full`} /></div><div><Label>{t('taskPanel.retryDelay')}</Label><input aria-label={t('taskPanel.retryDelay')} type="number" min={1} max={3600} value={retryDelaySeconds} onChange={e => setRetryDelaySeconds(Number(e.target.value))} className={`${inputClass} h-9 w-full`} /></div></div>
        <div className="grid grid-cols-2 gap-2"><div><Label>{t('taskPanel.overlap')}</Label><select aria-label={t('taskPanel.overlap')} value={overlapPolicy} onChange={e => setOverlapPolicy(e.target.value as 'skip' | 'queue' | 'parallel')} className={`${inputClass} h-9 w-full`}><option value="skip">{t('taskPanel.overlapSkip')}</option><option value="queue">{t('taskPanel.overlapQueue')}</option><option value="parallel">{t('taskPanel.overlapParallel')}</option></select></div><div><Label>{t('taskPanel.maxTaskConcurrency')}</Label><input aria-label={t('taskPanel.maxTaskConcurrency')} type="number" min={1} max={5} disabled={overlapPolicy !== 'parallel'} value={maxConcurrentRuns} onChange={e => setMaxConcurrentRuns(Number(e.target.value))} className={`${inputClass} h-9 w-full disabled:opacity-50`} /></div></div>
        <div className="grid grid-cols-2 gap-2"><div><Label>{t('taskPanel.missedRun')}</Label><select aria-label={t('taskPanel.missedRun')} value={missedRunPolicy} onChange={e => setMissedRunPolicy(e.target.value as 'skip' | 'run-once')} className={`${inputClass} h-9 w-full`}><option value="skip">{t('taskPanel.skip')}</option><option value="run-once">{t('taskPanel.catchUpOnce')}</option></select></div><div><Label>{t('taskPanel.catchUpWindow')}</Label><input aria-label={t('taskPanel.catchUpWindow')} type="number" min={1} max={10080} disabled={missedRunPolicy !== 'run-once'} value={catchUpWindowMinutes} onChange={e => setCatchUpWindowMinutes(Number(e.target.value))} className={`${inputClass} h-9 w-full disabled:opacity-50`} /></div></div>
        <div className="grid grid-cols-2 gap-2"><div><Label>{t('taskPanel.model')}</Label><select aria-label={t('taskPanel.model')} value={selectedModelKey} disabled={modelsLoading} onChange={e => { setSelectedModelKey(e.target.value); setVariant('') }} className={`${inputClass} h-9 w-full`}><option value="">{modelsLoading ? t('taskPanel.loadingModels') : t('taskPanel.selectModel')}</option>{models.map(model => <option key={taskModelKey(model.providerId, model.id)} value={taskModelKey(model.providerId, model.id)}>{model.name} · {model.providerName}</option>)}</select></div><div><Label>{t('taskPanel.reasoning')}</Label><select aria-label={t('taskPanel.reasoning')} value={variant} onChange={e => setVariant(e.target.value)} disabled={!selectedModel} className={`${inputClass} h-9 w-full`}><option value="">{t('taskPanel.default')}</option>{selectedModel?.variants.map(item => <option key={item} value={item}>{item}</option>)}</select></div></div>
        <div><Label>{t('taskPanel.trigger')}</Label><select aria-label={t('taskPanel.trigger')} value={triggerType} onChange={event => setTriggerType(event.target.value as TaskInput['triggerType'])} className={`${inputClass} h-9 w-full`}><option value="schedule">{t('taskPanel.triggerSchedule')}</option><option value="task-success">{t('taskPanel.triggerSuccess')}</option><option value="task-failure">{t('taskPanel.triggerFailure')}</option><option value="webhook">{t('taskPanel.triggerWebhook')}</option></select></div>
        {(triggerType === 'task-success' || triggerType === 'task-failure') ? <div><Label>{t('taskPanel.sourceTask')}</Label><select aria-label={t('taskPanel.sourceTask')} value={triggerTaskId} onChange={event => setTriggerTaskId(event.target.value)} className={`${inputClass} h-9 w-full`}><option value="">{t('taskPanel.selectSourceTask')}</option>{referenceTasks.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div> : null}
        {triggerType === 'schedule' ? <div><Label>{t('taskPanel.schedule')}</Label><div className="grid grid-cols-[1fr_1fr] gap-2"><select aria-label={t('taskPanel.schedule')} value={frequency} onChange={e => setFrequency(e.target.value as Frequency)} className={`${inputClass} h-9`}><option value="daily">{t('taskPanel.daily')}</option><option value="weekdays">{t('taskPanel.weekdays')}</option><option value="weekly">{t('taskPanel.weekly')}</option><option value="advanced">{t('taskPanel.advancedCron')}</option></select>{frequency === 'advanced' ? <input aria-label={t('taskPanel.advancedCron')} value={expression} onChange={e => setExpression(e.target.value)} className={`${inputClass} h-9 font-mono`} placeholder="0 18 * * *" /> : <div className="flex gap-2">{frequency === 'weekly' && <select aria-label={t('taskPanel.weekly')} value={day} onChange={e => setDay(e.target.value)} className={`${inputClass} h-9 flex-1`}>{weekdays.map(item => <option value={item[0]} key={item[0]}>{t(`taskPanel.weekday${item[0]}`)}</option>)}</select>}<input aria-label={t('taskPanel.scheduleTime')} type="time" value={time} onChange={e => setTime(e.target.value)} className={`${inputClass} h-9 flex-1`} /></div>}</div><input aria-label="Timezone" value={timezone} onChange={event => setTimezone(event.target.value)} className={`${inputClass} mt-2 h-9 w-full font-mono`} placeholder="Asia/Shanghai" />{frequency === 'advanced' && <p className="mt-1 text-[length:var(--fs-xs)] text-text-400">{t('taskPanel.cronHint')}</p>}</div> : null}
        {triggerType === 'webhook' ? <div><Label>{t('taskPanel.incomingWebhook')}</Label><input aria-label={t('taskPanel.incomingWebhook')} readOnly value={task?.webhookUrl ?? ''} className={`${inputClass} h-9 w-full font-mono text-[length:var(--fs-xs)]`} placeholder={t('taskPanel.webhookAfterSave')} />{task?.webhookUrl ? <button type="button" onClick={() => void navigator.clipboard.writeText(task.webhookUrl)} className="mt-1 text-[length:var(--fs-xs)] text-accent-main-100">{t('taskPanel.copyWebhook')}</button> : null}</div> : null}
        <details className="rounded-lg border border-border-200/60 px-3 py-2"><summary className="cursor-pointer text-[length:var(--fs-xs)] font-medium text-text-300">{t('taskPanel.dependencies')}</summary><div className="mt-2 grid grid-cols-2 gap-2">{referenceTasks.length ? referenceTasks.map(item => <label key={item.id} className="flex items-center gap-2 text-[length:var(--fs-xs)] text-text-300"><input type="checkbox" checked={dependencyTaskIds.includes(item.id)} onChange={event => setDependencyTaskIds(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} />{item.title}</label>) : <span className="text-text-500">{t('taskPanel.noDependencies')}</span>}</div></details>
        <details className="rounded-lg border border-border-200/60 px-3 py-2" open={notificationChannels.includes('webhook')}><summary className="cursor-pointer text-[length:var(--fs-xs)] font-medium text-text-300">{t('taskPanel.notifications')}</summary><div className="mt-2 flex gap-4"><label className="flex items-center gap-2 text-[length:var(--fs-xs)]"><input type="checkbox" checked={notificationChannels.includes('desktop')} onChange={event => setNotificationChannels(current => event.target.checked ? [...new Set([...current, 'desktop' as const])] : current.filter(item => item !== 'desktop'))} />{t('taskPanel.desktopNotification')}</label><label className="flex items-center gap-2 text-[length:var(--fs-xs)]"><input type="checkbox" checked={notificationChannels.includes('webhook')} onChange={event => setNotificationChannels(current => event.target.checked ? [...new Set([...current, 'webhook' as const])] : current.filter(item => item !== 'webhook'))} />Webhook</label></div>{notificationChannels.includes('webhook') ? <input aria-label={t('taskPanel.notificationWebhook')} value={notificationWebhookUrl} onChange={event => setNotificationWebhookUrl(event.target.value)} className={`${inputClass} mt-2 h-9 w-full`} placeholder="https://example.com/hooks/automation" /> : null}</details>
        {error && <div role="alert" className="text-[length:var(--fs-xs)] text-danger-100">{error}</div>}
        {templateSaved && <div role="status" className="text-[length:var(--fs-xs)] text-success-100">{t('taskPanel.templateSaved')}</div>}
        {preflight ? <div className={`rounded-lg border px-3 py-2 text-[length:var(--fs-xs)] ${preflight.ok ? 'border-success-100/30 bg-success-100/5 text-text-300' : 'border-danger-100/30 bg-danger-100/5 text-danger-100'}`}><div className="mb-1 font-medium">{preflight.ok ? '预检通过' : '预检失败'}</div>{preflight.messages.map(message => <div key={message}>• {message}</div>)}{preflight.nextRuns.length ? <div className="mt-2 border-t border-border-200/50 pt-2"><div className="mb-1 font-medium">未来 5 次运行</div>{preflight.nextRuns.map(date => <div key={date.toISOString()}>{date.toLocaleString()} · {timezone}</div>)}</div> : null}</div> : null}
      </div>
      <div className="mt-5 flex justify-end gap-2 border-t border-border-200/60 pt-4"><button disabled={!title.trim() || !prompt.trim() || !selectedModel || !selectedServer} onClick={() => { try { onSaveTemplate(currentInput()); setError(''); setTemplateSaved(true) } catch (cause) { setTemplateSaved(false); setError(cause instanceof Error ? cause.message : t('taskPanel.saveFailed')) } }} className="mr-auto rounded-lg px-3 py-2 text-[length:var(--fs-sm)] text-text-300 disabled:opacity-50">{t('taskPanel.saveTemplate')}</button><button disabled={saving || !selectedModel || !selectedServer} onClick={() => void preview()} className="rounded-lg border border-border-200 px-3 py-2 text-[length:var(--fs-sm)] text-text-200 hover:bg-bg-200 disabled:opacity-50">预检 / 试运行</button><button onClick={onClose} className="rounded-lg px-3 py-2 text-[length:var(--fs-sm)] text-text-300">{t('common:cancel')}</button><button disabled={saving || !title.trim() || !prompt.trim() || !selectedModel || (triggerType === 'task-success' || triggerType === 'task-failure') && !triggerTaskId} onClick={() => void save()} className="inline-flex items-center gap-1.5 rounded-lg bg-accent-main-100 px-4 py-2 text-[length:var(--fs-sm)] text-oncolor-100 transition-colors hover:bg-accent-main-200 disabled:opacity-50">{saving ? <SpinnerIcon size={12} className="animate-spin" /> : <CheckIcon size={12} />}{t('common:save')}</button></div>
  </Dialog>
}

function Label({ children }: { children: string }) { return <div className="mb-1.5 text-[length:var(--fs-xs)] font-medium text-text-300">{children}</div> }
function taskInputFromTask(task: Task): TaskInput {
  return {
    title: task.title,
    prompt: task.prompt,
    cron: task.cron,
    timezone: task.timezone,
    serverId: task.serverId,
    serverName: task.serverName,
    serverUrl: task.serverUrl,
    directory: task.directory,
    executionMode: task.executionMode,
    worktreeCleanup: task.worktreeCleanup,
    branch: task.branch,
    permissionProfile: task.permissionProfile,
    retryCount: task.retryCount,
    retryDelaySeconds: task.retryDelaySeconds,
    completionTimeoutMinutes: task.completionTimeoutMinutes,
    overlapPolicy: task.overlapPolicy,
    maxConcurrentRuns: task.maxConcurrentRuns,
    missedRunPolicy: task.missedRunPolicy,
    catchUpWindowMinutes: task.catchUpWindowMinutes,
    triggerType: task.triggerType,
    triggerTaskId: task.triggerTaskId,
    dependencyTaskIds: task.dependencyTaskIds,
    notificationChannels: task.notificationChannels,
    notificationWebhookUrl: task.notificationWebhookUrl,
    modelProviderID: task.modelProviderID,
    modelID: task.modelID,
    variant: task.variant,
    enabled: task.enabled,
  }
}
type LegacyTaskInput = Omit<TaskInput, 'triggerType' | 'triggerTaskId' | 'dependencyTaskIds' | 'notificationChannels' | 'notificationWebhookUrl'>
function isTaskExport(value: unknown): value is { format: 'opencodex.automation'; version: 1; settings?: Partial<TaskSettings>; tasks: Array<TaskInput | LegacyTaskInput> } {
  if (!value || typeof value !== 'object') return false
  const config = value as Record<string, unknown>
  if (config.format !== 'opencodex.automation' || config.version !== 1 || !Array.isArray(config.tasks)) return false
  if (config.settings !== undefined && !isTaskSettings(config.settings)) return false
  return config.tasks.every(task => isTaskInput(task) || isLegacyTaskInput(task))
}
function isTaskSettings(value: unknown): value is Partial<TaskSettings> {
  if (!value || typeof value !== 'object') return false
  const settings = value as Record<string, unknown>
  return Number.isInteger(settings.maxConcurrency) && Number.isInteger(settings.historyRetentionDays) && Number.isInteger(settings.maxHistory) && (settings.webhookPort === undefined || Number.isInteger(settings.webhookPort))
}
function isTaskInput(value: unknown): value is TaskInput {
  if (!value || typeof value !== 'object') return false
  const task = value as Record<string, unknown>
  const strings = ['title', 'prompt', 'cron', 'timezone', 'serverId', 'serverName', 'serverUrl', 'directory', 'branch', 'triggerTaskId', 'notificationWebhookUrl', 'modelProviderID', 'modelID', 'variant']
  const integers = ['retryCount', 'retryDelaySeconds', 'completionTimeoutMinutes', 'maxConcurrentRuns', 'catchUpWindowMinutes']
  if (!strings.every(key => typeof task[key] === 'string') || !integers.every(key => Number.isInteger(task[key]))) return false
  if (task.executionMode !== 'current' && task.executionMode !== 'worktree') return false
  if (task.worktreeCleanup !== 'always' && task.worktreeCleanup !== 'on-success' && task.worktreeCleanup !== 'never') return false
  if (task.permissionProfile !== 'ask' && task.permissionProfile !== 'writes' && task.permissionProfile !== 'risk' && task.permissionProfile !== 'full') return false
  if (task.overlapPolicy !== 'skip' && task.overlapPolicy !== 'queue' && task.overlapPolicy !== 'parallel') return false
  if (task.missedRunPolicy !== 'skip' && task.missedRunPolicy !== 'run-once') return false
  if (task.triggerType !== 'schedule' && task.triggerType !== 'task-success' && task.triggerType !== 'task-failure' && task.triggerType !== 'webhook') return false
  if (!Array.isArray(task.dependencyTaskIds) || !task.dependencyTaskIds.every(item => typeof item === 'string')) return false
  if (!Array.isArray(task.notificationChannels) || !task.notificationChannels.every(item => item === 'desktop' || item === 'webhook')) return false
  return typeof task.enabled === 'boolean'
}
function isLegacyTaskInput(value: unknown): value is LegacyTaskInput {
  if (!value || typeof value !== 'object') return false
  const task = value as Record<string, unknown>
  const strings = ['title', 'prompt', 'cron', 'timezone', 'serverId', 'serverName', 'serverUrl', 'directory', 'branch', 'modelProviderID', 'modelID', 'variant']
  const integers = ['retryCount', 'retryDelaySeconds', 'completionTimeoutMinutes', 'maxConcurrentRuns', 'catchUpWindowMinutes']
  if (!strings.every(key => typeof task[key] === 'string') || !integers.every(key => Number.isInteger(task[key]))) return false
  if (task.executionMode !== 'current' && task.executionMode !== 'worktree') return false
  if (task.worktreeCleanup !== 'always' && task.worktreeCleanup !== 'on-success' && task.worktreeCleanup !== 'never') return false
  if (task.permissionProfile !== 'ask' && task.permissionProfile !== 'writes' && task.permissionProfile !== 'risk' && task.permissionProfile !== 'full') return false
  if (task.overlapPolicy !== 'skip' && task.overlapPolicy !== 'queue' && task.overlapPolicy !== 'parallel') return false
  if (task.missedRunPolicy !== 'skip' && task.missedRunPolicy !== 'run-once') return false
  return typeof task.enabled === 'boolean'
}
function normalizeImportedTask(task: TaskInput | LegacyTaskInput): TaskInput {
  if (isTaskInput(task)) return task
  return { ...task, triggerType: 'schedule', triggerTaskId: '', dependencyTaskIds: [], notificationChannels: ['desktop'], notificationWebhookUrl: '' }
}
function buildCron(frequency: Frequency, time: string, day: string) { const [hour, minute] = time.split(':'); if (frequency === 'weekdays') return `${minute} ${hour} * * 1-5`; if (frequency === 'weekly') return `${minute} ${hour} * * ${day}`; return `${minute} ${hour} * * *` }
function cronParts(cron: string) { const [minute, hour, , , day] = cron.split(' '); if (!minute || !hour || !day) return { frequency: 'advanced' as Frequency, time: '18:00', day: '1' }; if (day === '*') return { frequency: 'daily' as Frequency, time: `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`, day: '1' }; if (day === '1-5') return { frequency: 'weekdays' as Frequency, time: `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`, day: '1' }; if (/^[0-6]$/.test(day)) return { frequency: 'weekly' as Frequency, time: `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`, day }; return { frequency: 'advanced' as Frequency, time: '18:00', day: '1' } }
function describeCron(cron: string, t: TFunction) { const value = cronParts(cron); if (value.frequency === 'advanced') return `Cron ${cron}`; if (value.frequency === 'weekdays') return t('taskPanel.weekdaysAt', { time: value.time }); if (value.frequency === 'weekly') return t('taskPanel.weeklyAt', { day: t(`taskPanel.weekday${value.day}`), time: value.time }); return t('taskPanel.dailyAt', { time: value.time }) }
function describeTrigger(task: Task, tasks: Task[], t: TFunction) { if (task.triggerType === 'schedule') return describeCron(task.cron, t); if (task.triggerType === 'webhook') return t('taskPanel.triggerWebhook'); const source = tasks.find(item => item.id === task.triggerTaskId)?.title ?? task.triggerTaskId; return t(task.triggerType === 'task-success' ? 'taskPanel.triggerSuccessValue' : 'taskPanel.triggerFailureValue', { name: source }) }
function taskModelKey(providerID: string, modelID: string) { return `${providerID}\u0000${modelID}` }
function permissionLabel(value: Task['permissionProfile'], t: TFunction) { return t(`taskPanel.permission_${value}`) }
function runStatusLabel(value: TaskRun['status'], t: TFunction) { return t(`taskPanel.status_${value}`) }

function readTaskTemplates(): TaskTemplate[] {
  const value = localStorage.getItem(taskTemplateStorageKey)
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is TaskTemplate => Boolean(item && typeof item === 'object' && typeof item.id === 'string' && typeof item.name === 'string' && isTaskInput(item.input)))
  } catch {
    return []
  }
}

function readStringList(key: string) {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}
