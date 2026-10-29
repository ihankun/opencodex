import type { VcsDiffData as SDKVcsDiffData, VcsInfo as SDKVcsInfo } from "./legacy-sdk.ts"

export type VcsInfo = SDKVcsInfo

export type VcsDiffMode = SDKVcsDiffData['query']['mode']
