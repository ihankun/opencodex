import type { Agent as SDKAgent } from "./legacy-sdk.ts"

export type AgentMode = SDKAgent['mode']

export type AgentPermission = SDKAgent['permission'][number]

export type Agent = SDKAgent
