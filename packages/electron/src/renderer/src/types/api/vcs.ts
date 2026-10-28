import type { VcsDiffData as SDKVcsDiffData, VcsInfo as SDKVcsInfo } from '@opencode/client'

export type VcsInfo = SDKVcsInfo

export type VcsDiffMode = SDKVcsDiffData['query']['mode']
