// ============================================
// SDK Client - 基于 @opencode-ai/sdk 的统一客户端
//
// 职责：
// 1. 根据当前活动服务器动态创建 SDK client
// 2. 整合 baseUrl / auth / fetch
// 3. 为上层 API 模块提供统一的 client 获取方式
// ============================================

import { OpenCode } from '@opencode/client'
import { serverStore, makeBasicAuthHeader } from '../store/serverStore'
const _apiRequestGenerations = new Map<string, number>()
const _apiRequestControllers = new Map<AbortController, string>()

function getFetchImpl(): typeof globalThis.fetch {
  return globalThis.fetch
}

function createAbortError(message: string) {
  return new DOMException(message, 'AbortError')
}

function requestGeneration(serverId: string) {
  return _apiRequestGenerations.get(serverId) ?? 0
}

async function trackedFetch(input: RequestInfo | URL, init: RequestInit | undefined, serverId: string, generation: number): Promise<Response> {
  const controller = new AbortController()
  const externalSignal = init?.signal
  const abortFromExternal = () => controller.abort(externalSignal?.reason)

  if (externalSignal?.aborted) {
    abortFromExternal()
  } else {
    externalSignal?.addEventListener('abort', abortFromExternal, { once: true })
  }

  _apiRequestControllers.set(controller, serverId)

  try {
    if (generation !== requestGeneration(serverId)) {
      throw createAbortError('Stale API request')
    }

    return await getFetchImpl()(input, {
      ...init,
      signal: controller.signal,
    })
  } finally {
    externalSignal?.removeEventListener('abort', abortFromExternal)
    _apiRequestControllers.delete(controller)
  }
}

export function abortInFlightApiRequests(reason = 'Server endpoint changed', serverId?: string): void {
  const targets = serverId ? [serverId] : serverStore.getServers().map(server => server.id)
  targets.forEach(id => _apiRequestGenerations.set(id, requestGeneration(id) + 1))
  for (const [controller, requestServerId] of _apiRequestControllers) {
    if (serverId && requestServerId !== serverId) continue
    controller.abort(createAbortError(reason))
    _apiRequestControllers.delete(controller)
  }
}

// Client 缓存：按 "baseUrl + authHash" 缓存实例，避免重复创建
const _cachedClients = new Map<string, { key: string; client: ReturnType<typeof OpenCode.make> }>()

function requireServer(serverId: string) {
  const server = serverStore.getServer(serverId)
  if (server) return server
  throw new Error(`Server not found: ${serverId}`)
}

function buildCacheKey(serverId: string): string {
  const server = requireServer(serverId)
  const auth = server.auth
  const authPart = auth?.password ? `${auth.username}:${auth.password}` : ''
  return `${server.url}|${authPart}`
}

function buildHeaders(serverId: string): Record<string, string> {
  const headers: Record<string, string> = {}
  const auth = requireServer(serverId).auth
  if (auth?.password) {
    headers['Authorization'] = makeBasicAuthHeader(auth)
  }
  return headers
}

/**
 * 同步获取 SDK client
 */
export function getSDKClient(serverId = serverStore.getActiveServerId()): ReturnType<typeof OpenCode.make> {
  const key = buildCacheKey(serverId)
  const cached = _cachedClients.get(serverId)
  if (cached?.key === key) return cached.client

  const server = requireServer(serverId)
  const headers = buildHeaders(serverId)
  const generation = requestGeneration(serverId)
  const fetchImpl = ((input, init) => trackedFetch(input, init, serverId, generation)) as typeof globalThis.fetch

  const client = OpenCode.make({
    baseUrl: server.url,
    headers,
    fetch: fetchImpl,
  })
  _cachedClients.set(serverId, { key, client })
  return client
}

export async function apiFetchJson<T>(path: string, init?: RequestInit, serverId = serverStore.getActiveServerId()): Promise<T> {
  await serverStore.whenCredentialsReady(serverId)

  const url = new URL(path, requireServer(serverId).url)
  const headers = new Headers(init?.headers)
  for (const [key, value] of Object.entries(buildHeaders(serverId))) {
    headers.set(key, value)
  }
  if (init?.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  if (!headers.has('accept')) {
    headers.set('accept', 'application/json')
  }

  const response = await trackedFetch(
    url,
    {
      ...init,
      headers,
    },
    serverId,
    requestGeneration(serverId),
  )
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

/**
 * 异步获取 SDK client（等待凭据初始化后重建缓存）
 */
export async function getSDKClientAsync(serverId = serverStore.getActiveServerId()): Promise<ReturnType<typeof OpenCode.make>> {
  await serverStore.whenCredentialsReady(serverId)
  _cachedClients.delete(serverId)
  return getSDKClient(serverId)
}

/**
 * 强制重建 client（服务器切换时调用）
 */
export function invalidateSDKClient(serverId?: string): void {
  if (serverId) {
    _cachedClients.delete(serverId)
    return
  }
  _cachedClients.clear()
}

/**
 * 从 SDK 返回值中提取 data，如果有 error 则抛出
 *
 * SDK 默认返回 { data, error, request, response }
 * 我们的上层 API 函数期望直接返回数据，所以需要 unwrap
 */
export function unwrap<T>(result: { data?: T; error?: unknown }): T {
  if (result.error != null) {
    const err = result.error
    if (err instanceof Error) throw err
    if (typeof err === 'string') throw new Error(err)
    throw new Error(JSON.stringify(err))
  }
  return result.data as T
}
