import type { Agent as SDKAgent } from '@opencode/client'

export type AgentMode = SDKAgent['mode']

export type AgentPermission = SDKAgent['permission'][number]

export type Agent = SDKAgent
