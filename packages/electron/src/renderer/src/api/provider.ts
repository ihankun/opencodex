import { getSDKClient, unwrap } from './sdk'
import { formatPathForApi } from '../utils/directoryUtils'
import type { Auth, Provider, ProviderAuthAuthorization, ProviderAuthMethod } from '@opencode-ai/sdk/v2/client'

export interface ProviderListResult {
  all: Provider[]
  connected: string[]
  default: Record<string, string>
}

export async function getProviders(directory?: string): Promise<ProviderListResult> {
  const sdk = getSDKClient()
  return unwrap(await sdk.provider.list({ directory: formatPathForApi(directory) }))
}

/** 强制服务端重新拉取 models.dev 目录，并返回更新后的供应商列表 */
export async function refreshProviders(directory?: string): Promise<ProviderListResult> {
  const sdk = getSDKClient()
  return unwrap(await sdk.provider.refresh({ directory: formatPathForApi(directory) }))
}

export async function getProviderAuthMethods(directory?: string): Promise<Record<string, ProviderAuthMethod[]>> {
  const sdk = getSDKClient()
  return unwrap(await sdk.provider.auth({ directory: formatPathForApi(directory) }))
}

export async function setProviderAuth(providerID: string, auth: Auth): Promise<boolean> {
  const sdk = getSDKClient()
  return unwrap(await sdk.auth.set({ providerID, auth }))
}

export async function removeProviderAuth(providerID: string): Promise<boolean> {
  const sdk = getSDKClient()
  return unwrap(await sdk.auth.remove({ providerID }))
}

/**
 * 从本地 opencode auth 存储读回明文 Key（仅本地 Runner 的 api/wellknown 凭证）。
 * 远程 Runner 的凭据不在本机，OAuth 访问令牌也会在此返回 undefined。
 */
export async function getProviderAuthKey(providerID: string): Promise<string | undefined> {
  if (typeof window.customOpenCode?.providerAuthKey !== 'function') return undefined
  return window.customOpenCode.providerAuthKey(providerID)
}

export async function authorizeProviderOAuth(
  providerID: string,
  method: number,
  inputs?: Record<string, string>,
  directory?: string,
): Promise<ProviderAuthAuthorization> {
  const sdk = getSDKClient()
  return unwrap(
    await sdk.provider.oauth.authorize({
      providerID,
      method,
      inputs,
      directory: formatPathForApi(directory),
    }),
  )
}

export async function completeProviderOAuth(
  providerID: string,
  method: number,
  code?: string,
  directory?: string,
): Promise<boolean> {
  const sdk = getSDKClient()
  return unwrap(
    await sdk.provider.oauth.callback({
      providerID,
      method,
      code,
      directory: formatPathForApi(directory),
    }),
  )
}
