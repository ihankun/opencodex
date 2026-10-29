// V2 client 的旧接口兼容层。
//
// Electron renderer 的 API 模块是按 V1 SDK 的方法名和参数写的。这里把同样的方法
// 映射到 V2 client（/api/...），少量 V2 尚未提供的端点走 fork 路由，等待服务端
// 迁移完成。返回统一是 { data } 形状，兼容现有的 unwrap()。

import { OpenCode } from "@opencode/client"
import type {
  FormInfo,
  McpServer,
  ProviderInfo,
  SessionMessageAssistant,
} from "@opencode/client"
import type { McpServerConfig } from "../../types/api/mcp"
import type { MessageWithParts } from "../../types/api/message"
import type { Skill } from "../../types/api/skill"
import type {
  Agent,
  AssistantMessage,
  Auth,
  Config,
  File,
  FileContent,
  FileNode,
  FormatterStatus,
  LspStatus,
  McpStatusResponse,
  PermissionRequest,
  Provider,
  ProviderAuthAuthorization,
  ProviderAuthMethod,
  Pty as LegacyPty,
  QuestionRequest,
  Session,
  SnapshotFileDiff,
  Symbol,
  Todo,
  ToolList,
  VcsInfo,
  Worktree,
} from "../../types/api/legacy-sdk"
import { createEventProjector } from "./events"
import {
  projectAgent,
  projectMcpResponse,
  projectMessages,
  projectProject,
  projectForm,
  projectProvider,
  projectSession,
  projectSkill,
  projectVcsInfo,
} from "./project"

type Json = Record<string, unknown>
type Location = { location?: { directory?: string } }
type RequestJson = <T>(path: string, init?: RequestInit) => Promise<T>

export interface LegacyClientOptions {
  baseUrl: string
  headers: Record<string, string>
  fetch: typeof globalThis.fetch
  requestJson: RequestJson
}

const mergeConfig = (entries: Array<{ type: string; info?: Json }>): Config =>
  entries.reduce<Json>((acc, entry) => {
    if (entry.type !== "document" || !entry.info) return acc
    return { ...acc, ...entry.info }
  }, {}) as Config

const toLocation = (directory?: string): Location => (directory ? { location: { directory } } : {})

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

function toFileUrl(path: string): string {
  if (!path) return ""
  if (path.startsWith("file://") || path.startsWith("data:")) return path
  const normalized = path.replaceAll("\\", "/")
  if (/^[a-zA-Z]:/.test(normalized)) return `file:///${normalized}`
  if (normalized.startsWith("/")) return `file://${normalized}`
  return `file:///${normalized}`
}

function joinPath(directory: string, relative: string): string {
  if (!relative || relative === ".") return directory
  if (/^[a-zA-Z]:[\\/]/.test(relative) || relative.startsWith("/")) return relative
  return `${directory.replace(/[\\/]+$/, "")}/${relative}`
}

function fileNode(entry: { path: string; type: "file" | "directory" }, directory: string): FileNode {
  const relative = entry.path
  const name = relative.split(/[\\/]/).filter(Boolean).at(-1) ?? relative
  return {
    name,
    path: relative,
    absolute: joinPath(directory, relative),
    type: entry.type,
    ignored: false,
  }
}


export function makeLegacyClient(options: LegacyClientOptions) {
  const v2 = OpenCode.make({
    baseUrl: options.baseUrl,
    headers: options.headers,
    fetch: options.fetch,
  })

  const projectEvent = createEventProjector()
  const formCache = new Map<string, FormInfo>()
  const permissionSessions = new Map<string, string>()
  const oauthAttempts = new Map<string, { integrationID: string; attemptID: string; methodID: string }>()
  const integrationMethods = new Map<string, Array<{ id?: string; type: string; label?: string }>>()

  async function projectLocation(directory?: string) {
    const info = await v2.location.get(toLocation(directory))
    return info
  }

  async function projectByDirectory(directory?: string) {
    const info = await projectLocation(directory)
    return v2.project.list().then((projects) => projects.find((project) => project.id === info.project.id))
  }

  async function buildPromptInput(input: Json) {
    const parts = Array.isArray(input.parts) ? (input.parts as Json[]) : []
    const texts = parts.filter((part) => part.type === "text" && typeof part.text === "string")
    const files = parts
      .filter((part) => part.type === "file")
      .flatMap((part) => {
        const source = part.source as Json | undefined
        const path = typeof source?.path === "string" ? source.path : undefined
        const uri = typeof part.url === "string" ? part.url : path ? toFileUrl(path) : undefined
        if (!uri) return []
        const sourceText = source?.text as Json | undefined
        return [
          {
            uri,
            name: typeof part.filename === "string" ? part.filename : undefined,
            mention:
              sourceText && typeof sourceText.value === "string"
                ? {
                    text: sourceText.value,
                    start: Number(sourceText.start ?? 0),
                    end: Number(sourceText.end ?? 0),
                  }
                : undefined,
          },
        ]
      })
    const agents = parts
      .filter((part) => part.type === "agent" && typeof part.name === "string")
      .map((part) => {
        const source = part.source as Json | undefined
        return {
          name: part.name as string,
          mention:
            source && typeof source.value === "string"
              ? {
                  text: source.value,
                  start: Number(source.start ?? 0),
                  end: Number(source.end ?? 0),
                }
              : undefined,
        }
      })
    const syntheticParts = texts.filter((part) => part.synthetic === true)
    const displayParts = texts.filter((part) => part.synthetic !== true)
    return {
      text: texts.map((part) => String(part.text)).join("\n"),
      files,
      agents,
      metadata:
        syntheticParts.length > 0
          ? ({
              opencodex: {
                parts: [
                  ...syntheticParts.map((part) => ({
                    type: "text",
                    text: part.text,
                    synthetic: true,
                    metadata: part.metadata,
                  })),
                  ...displayParts.map((part) => ({ type: "text", text: part.text })),
                ],
              },
            } as never)
          : undefined,
    }
  }

  async function switchModelAndAgent(input: Json, sessionID: string) {
    if (typeof input.agent === "string" && input.agent) {
      await v2.session.switchAgent({ sessionID, agent: input.agent })
    }
    const model = input.model as Json | undefined
    if (model && typeof model.providerID === "string" && typeof model.modelID === "string") {
      await v2.session.switchModel({
        sessionID,
        model: {
          id: model.modelID,
          providerID: model.providerID,
          variant: typeof model.variant === "string" ? model.variant : undefined,
        },
      })
    }
  }

  async function lastAssistant(sessionID: string): Promise<MessageWithParts | undefined> {
    const result = await v2.message.list({ sessionID, order: "desc", limit: 20 })
    const message = result.data.find((item): item is SessionMessageAssistant => item.type === "assistant")
    if (!message) return undefined
    return projectMessages([message], sessionID)[0]
  }

  async function* eventStream() {
    for await (const event of v2.event.subscribe()) {
      for (const projected of projectEvent(event)) yield projected
    }
  }

  async function providerList(input: Json) {
    const location = toLocation(input.directory as string | undefined)
    const [providers, models, defaultModel, integrations] = await Promise.all([
      v2.provider.list(location),
      v2.model.list(location),
      v2.model.default(location),
      v2.integration.list(location),
    ])
    const all = providers.data.map((provider: ProviderInfo) => projectProvider(provider, models.data))
    const connected = providers.data
      .filter((provider) => {
        if (!provider.integrationID) return false
        const integration = integrations.data.find((item) => item.id === provider.integrationID)
        return (integration?.connections.length ?? 0) > 0
      })
      .map((provider) => provider.id)
    const defaultEntry = defaultModel.data
      ? { [defaultModel.data.providerID]: defaultModel.data.modelID }
      : {}
    return { data: { all, connected, default: defaultEntry } }
  }

  async function providerAuth(input: Json) {
    const integrations = await v2.integration.list(toLocation(input.directory as string | undefined))
    const providers = await v2.provider.list(toLocation(input.directory as string | undefined))
    const result: Record<string, ProviderAuthMethod[]> = {}
    for (const integration of integrations.data) {
      const provider = providers.data.find(
        (item: ProviderInfo) => item.integrationID === integration.id || item.id === integration.id,
      )
      if (!provider) continue
      integrationMethods.set(provider.id, integration.methods as never)
      result[provider.id] = integration.methods.map((method) => {
        if (method.type === "oauth") return { type: "oauth", label: method.label } as ProviderAuthMethod
        return { type: "api", label: "label" in method ? method.label ?? "API key" : "API key" } as ProviderAuthMethod
      })
    }
    return { data: result }
  }

  return {
    session: {
      list: async (input: Json = {}) => {
        const result = await v2.session.list({
          directory: input.directory as string | undefined,
          search: input.search as string | undefined,
          limit: input.limit as number | undefined,
          parentID: input.roots === true || input.roots === "true" ? null : undefined,
          archived: input.archived === true || input.archived === "true" ? true : undefined,
        })
        const data = result.data.map(projectSession)
        return { data: typeof input.start === "number" ? data.slice(input.start) : data }
      },
      status: async (_input: Json = {}) => {
        const active = await v2.session.active()
        return {
          data: Object.fromEntries(Object.keys(active).map((id) => [id, { type: "busy" as const }])),
        }
      },
      messages: async (input: Json) => {
        const sessionID = input.sessionID as string
        const result = await v2.message.list({
          sessionID,
          limit: input.limit as number | undefined,
          order: "asc",
        })
        return { data: projectMessages(result.data, sessionID) }
      },
      get: async (input: Json) => ({
        data: projectSession(await v2.session.get({ sessionID: input.sessionID as string })),
      }),
      create: async (input: Json) => {
        const model = input.model as Json | undefined
        const session = await v2.session.create({
          title: (input.title as string | undefined) ?? undefined,
          parentID: input.parentID as string | undefined,
          agent: input.agent as string | undefined,
          model:
            model && typeof model.providerID === "string" && (typeof model.modelID === "string" || typeof model.id === "string")
              ? {
                  id: String(model.modelID ?? model.id),
                  providerID: model.providerID,
                  variant: model.variant as string | undefined,
                }
              : undefined,
          location: input.directory ? { directory: input.directory as string } : undefined,
        })
        return { data: projectSession(session) }
      },
      update: async (input: Json) => {
        const sessionID = input.sessionID as string
        const archived =
          (input.time as Json | undefined)?.archived !== undefined ? true : input.unarchive === true ? false : undefined
        await v2.session.update({
          sessionID,
          title: input.title as string | undefined,
          permissions: input.permission as never,
          archived,
        })
        return { data: projectSession(await v2.session.get({ sessionID })) }
      },
      delete: async (input: Json) => {
        await v2.session.remove({ sessionID: input.sessionID as string })
        return { data: true }
      },
      abort: async (input: Json) => {
        await v2.session.interrupt({ sessionID: input.sessionID as string })
        return { data: true }
      },
      revert: async (input: Json) => {
        const sessionID = input.sessionID as string
        await v2.session.revert.stage({
          sessionID,
          messageID: input.messageID as string,
          files: true,
        })
        return { data: projectSession(await v2.session.get({ sessionID })) }
      },
      unrevert: async (input: Json) => {
        const sessionID = input.sessionID as string
        await v2.session.revert.clear({ sessionID })
        return { data: projectSession(await v2.session.get({ sessionID })) }
      },
      fork: async (input: Json) => {
        const result = await v2.session.fork({
          sessionID: input.sessionID as string,
          before: input.messageID as string | undefined,
        })
        return { data: projectSession(result) }
      },
      summarize: async (input: Json) => {
        await v2.session.compact({ sessionID: input.sessionID as string })
        return { data: true }
      },
      children: async (input: Json) => {
        const result = await v2.session.list({ parentID: input.sessionID as string })
        return { data: result.data.map(projectSession) }
      },
      diff: async (input: Json) => {
        const result = await v2.session.diff({
          sessionID: input.sessionID as string,
          to: input.messageID as string | undefined,
        })
        return { data: result as unknown as SnapshotFileDiff[] }
      },
      todo: async (input: Json) => {
        const result = await v2.message.list({ sessionID: input.sessionID as string, order: "asc" })
        for (const message of [...result.data].reverse()) {
          if (message.type !== "assistant") continue
          for (const content of [...message.content].reverse()) {
            if (content.type !== "tool") continue
            if (content.name !== "todowrite" && content.name !== "todo") continue
            if (content.state.status !== "completed") continue
            const todos = content.state.metadata?.todos
            if (Array.isArray(todos)) return { data: todos as unknown as Todo[] }
          }
        }
        return { data: [] as Todo[] }
      },
      prompt: async (input: Json) => {
        const sessionID = input.sessionID as string
        await switchModelAndAgent(input, sessionID)
        const payload = await buildPromptInput(input)
        await v2.session.prompt({
          sessionID,
          text: payload.text,
          files: payload.files,
          agents: payload.agents,
          metadata: payload.metadata,
          delivery: input.delivery === "steer" || input.delivery === "queue" ? input.delivery : undefined,
        })
        await v2.session.wait({ sessionID })
        const message = await lastAssistant(sessionID)
        if (!message) throw new Error("No assistant response")
        return { data: { info: message.info as AssistantMessage, parts: message.parts } }
      },
      promptAsync: async (input: Json) => {
        const sessionID = input.sessionID as string
        await switchModelAndAgent(input, sessionID)
        const payload = await buildPromptInput(input)
        await v2.session.prompt({
          sessionID,
          text: payload.text,
          files: payload.files,
          agents: payload.agents,
          metadata: payload.metadata,
          delivery: input.delivery === "steer" || input.delivery === "queue" ? input.delivery : undefined,
        })
        return { data: true }
      },
      command: async (input: Json) => {
        const sessionID = input.sessionID as string
        await switchModelAndAgent(input, sessionID)
        const payload = await buildPromptInput(input)
        await v2.session.command({
          sessionID,
          name: String(input.command ?? input.name ?? ""),
          text: String(input.arguments ?? input.text ?? ""),
          files: payload.files.map((file) => ({
            uri: file.name ?? "",
            name: file.name,
          })),
          agents: payload.agents,
          delivery: input.delivery === "steer" || input.delivery === "queue" ? input.delivery : undefined,
        })
        return { data: true }
      },
    },

    message: {
      list: async (input: Json) => {
        const sessionID = input.sessionID as string
        const result = await v2.message.list({
          sessionID,
          limit: input.limit as number | undefined,
          order: "asc",
        })
        return { data: projectMessages(result.data, sessionID) }
      },
    },

    command: {
      list: async (input: Json = {}) => {
        const result = await v2.command.list(toLocation(input.directory as string | undefined))
        return { data: result.data.map((command) => ({ name: command.name, description: command.description })) }
      },
    },

    app: {
      agents: async (input: Json = {}) => {
        const result = await v2.agent.list(toLocation(input.directory as string | undefined))
        return { data: result.data.map(projectAgent) }
      },
      skills: async (input: Json = {}) => {
        const result = await v2.skill.list(toLocation(input.directory as string | undefined))
        return { data: result.data.map(projectSkill) }
      },
    },

    config: {
      get: async (input: Json = {}) => {
        const entries = await v2.config.get(toLocation(input.directory as string | undefined))
        return { data: mergeConfig(entries as never) }
      },
      update: async (input: Json = {}) => {
        await options.requestJson("/experimental/config", {
          method: "PATCH",
          body: JSON.stringify({
            ...(input.config as Json),
            directory: input.directory,
          }),
        })
        const entries = await v2.config.get(toLocation(input.directory as string | undefined))
        return { data: mergeConfig(entries as never) }
      },
      providers: async (input: Json = {}) => {
        const location = toLocation(input.directory as string | undefined)
        const [providers, models, defaultModel] = await Promise.all([
          v2.provider.list(location),
          v2.model.list(location),
          v2.model.default(location),
        ])
        const all = providers.data.map((provider: ProviderInfo) => projectProvider(provider, models.data))
        const connected = providers.data
          .filter((provider) => provider.integrationID)
          .map((provider) => provider.id)
        const defaultEntry = defaultModel.data
          ? { [defaultModel.data.providerID]: defaultModel.data.modelID }
          : {}
        return { data: { providers: all, default: defaultEntry, connected } }
      },
    },

    global: {
      config: {
        get: async () => {
          const entries = await v2.config.get()
          return { data: mergeConfig(entries as never) }
        },
        update: async (input: Json = {}) => {
          await options.requestJson("/experimental/config", {
            method: "PATCH",
            body: JSON.stringify(input.config),
          })
          const entries = await v2.config.get()
          return { data: mergeConfig(entries as never) }
        },
      },
      health: async () => {
        const info = await v2.server.info()
        return { data: { healthy: true as const, version: info.version } }
      },
      dispose: async (_input: Json = {}) => ({ data: true }),
      event: async () => ({ stream: eventStream() }),
    },

    instance: {
      dispose: async (_input: Json = {}) => ({ data: true }),
    },

    path: {
      get: async (_input: Json = {}) => {
        const info = await v2.location.get()
        return {
          data: {
            home: "",
            state: "",
            config: "",
            worktree: info.project.directory,
            directory: info.directory,
          },
        }
      },
    },

    project: {
      current: async (input: Json = {}) => {
        const project = await projectByDirectory(input.directory as string | undefined)
        if (!project) throw new Error("Project not found")
        return { data: projectProject(project) }
      },
      list: async (_input: Json = {}) => {
        const projects = await v2.project.list()
        return { data: projects.map(projectProject) }
      },
      initGit: async (input: Json = {}) => {
        await v2.vcs.init(toLocation(input.directory as string | undefined))
        const info = await v2.location.get(toLocation(input.directory as string | undefined))
        const projects = await v2.project.list()
        const project = projects.find((item) => item.id === info.project.id)
        return { data: project ? projectProject(project) : { id: info.project.id, worktree: info.project.directory } as never }
      },
      subrepos: async (input: Json = {}) => {
        const directory = (input.directory as string | undefined) ?? ""
        const result = await options.requestJson<{ repos?: Array<{ worktree: string }> }>(
          `/project/subrepos?${new URLSearchParams({ directory }).toString()}`,
        )
        return { data: { directory, repos: result.repos ?? [] } }
      },
      update: async (input: Json) => {
        const project = await v2.project.update({
          projectID: input.projectID as string,
          name: input.name as string | undefined,
          icon: input.icon as never,
        })
        return { data: projectProject(project) }
      },
    },

    provider: {
      list: providerList,
      refresh: async (input: Json = {}) => {
        await options.requestJson("/provider/refresh", {
          method: "POST",
          body: JSON.stringify({ directory: input.directory }),
        })
        return providerList(input)
      },
      auth: providerAuth,
      oauth: {
        authorize: async (input: Json) => {
          const providerID = input.providerID as string
          const methods = await providerAuth({ directory: input.directory })
          const integration = await v2.provider.get({
            providerID,
            ...toLocation(input.directory as string | undefined),
          })
          const integrationID = integration.data.integrationID ?? providerID
          const rawMethods = integrationMethods.get(providerID) ?? []
          const raw = rawMethods[Number(input.method ?? 0)]
          if (!methods.data[providerID]) throw new Error("Provider has no auth methods")
          const attempt = await v2.integration.oauth.connect({
            integrationID,
            methodID: raw?.id ?? "oauth",
            answer: input.inputs as never,
            ...toLocation(input.directory as string | undefined),
          })
          oauthAttempts.set(`${providerID}:${Number(input.method ?? 0)}`, {
            integrationID,
            attemptID: attempt.data.attemptID,
            methodID: raw?.id ?? "oauth",
          })
          return {
            data: {
              url: attempt.data.url,
              method: attempt.data.mode,
              instructions: attempt.data.instructions,
            } satisfies ProviderAuthAuthorization,
          }
        },
        callback: async (input: Json) => {
          const providerID = input.providerID as string
          const attempt = oauthAttempts.get(`${providerID}:${Number(input.method ?? 0)}`)
          if (!attempt) throw new Error("OAuth attempt not found")
          await v2.integration.oauth.complete({
            integrationID: attempt.integrationID,
            attemptID: attempt.attemptID,
            code: input.code as string | undefined,
            ...toLocation(input.directory as string | undefined),
          })
          oauthAttempts.delete(`${providerID}:${Number(input.method ?? 0)}`)
          return { data: true }
        },
      },
    },

    auth: {
      set: async (input: Json) => {
        const auth = input.auth as Auth
        const providerID = input.providerID as string
        const provider = await v2.provider.get({ providerID })
        const integrationID = provider.data.integrationID ?? providerID
        if (auth.type === "api") {
          await v2.integration.connect.key({ integrationID, key: auth.key })
        } else if (auth.type === "wellknown") {
          await v2.integration.connect.key({ integrationID, key: auth.key })
        } else {
          await v2.credential.create({
            integrationID,
            value: {
              type: "oauth",
              methodID: "oauth",
              refresh: auth.refresh,
              access: auth.access,
              expires: auth.expires,
            },
          })
        }
        return { data: true }
      },
      remove: async (input: Json) => {
        const providerID = input.providerID as string
        const provider = await v2.provider.get({ providerID })
        const integration = await v2.integration.get({ integrationID: provider.data.integrationID ?? providerID })
        const credential = integration.data.connections.find((connection) => connection.type === "credential")
        if (credential) await v2.credential.remove({ credentialID: credential.id })
        return { data: true }
      },
    },

    file: {
      list: async (input: Json = {}) => {
        const directory = input.directory as string | undefined
        const result = await v2.file.list({
          path: (input.path as string | undefined) ?? ".",
          ...toLocation(directory),
        })
        return { data: result.data.map((entry) => fileNode(entry, result.location.directory)) }
      },
      read: async (input: Json) => {
        const bytes = await v2.file.read({
          path: input.path as string,
          ...toLocation(input.directory as string | undefined),
        })
        try {
          return { data: { type: "text", content: new TextDecoder().decode(bytes) } satisfies FileContent }
        } catch {
          return { data: { type: "binary", content: bytesToBase64(bytes), encoding: "base64" } satisfies FileContent }
        }
      },
      status: async (input: Json = {}) => {
        const result = await v2.vcs.status(toLocation(input.directory as string | undefined))
        return {
          data: result.data.map(
            (item): File => ({ path: item.file, added: item.additions, removed: item.deletions, status: item.status }),
          ),
        }
      },
    },

    find: {
      files: async (input: Json) => {
        const result = await v2.file.find({
          query: input.query as string,
          type: input.type as "file" | "directory" | undefined,
          limit: input.limit as number | undefined,
          ...toLocation(input.directory as string | undefined),
        })
        return { data: result.data.map((entry) => entry.path) }
      },
      symbols: async (_input: Json = {}) => ({ data: [] as Symbol[] }),
    },

    mcp: {
      status: async (input: Json = {}) => {
        const result = await v2.mcp.list(toLocation(input.directory as string | undefined))
        return { data: projectMcpResponse(result.data) as McpStatusResponse }
      },
      add: async (input: Json) => {
        const config = input.config as McpServerConfig
        await v2.mcp.add({
          server: input.name as string,
          config: {
            ...(config as unknown as Json),
            type: config.type,
          } as never,
          ...toLocation(input.directory as string | undefined),
        })
        return { data: true }
      },
      connect: async (input: Json) => {
        await v2.mcp.connect({
          server: input.name as string,
          ...toLocation(input.directory as string | undefined),
        })
        return { data: true }
      },
      disconnect: async (input: Json) => {
        await v2.mcp.disconnect({
          server: input.name as string,
          ...toLocation(input.directory as string | undefined),
        })
        return { data: true }
      },
      auth: {
        start: async (input: Json) => {
          const servers = await v2.mcp.list(toLocation(input.directory as string | undefined))
          const server = servers.data.find((item: McpServer) => item.name === input.name)
          if (!server?.integrationID) throw new Error("MCP server has no integration")
          const integration = await v2.integration.get({ integrationID: server.integrationID })
          const method = integration.data.methods.find((item) => item.type === "oauth")
          if (!method) throw new Error("MCP server has no OAuth method")
          const attempt = await v2.integration.oauth.connect({
            integrationID: server.integrationID,
            methodID: method.id,
            ...toLocation(input.directory as string | undefined),
          })
          return { data: { authorizationUrl: attempt.data.url } }
        },
        remove: async (input: Json) => {
          const servers = await v2.mcp.list(toLocation(input.directory as string | undefined))
          const server = servers.data.find((item: McpServer) => item.name === input.name)
          if (!server?.integrationID) return { data: true }
          const integration = await v2.integration.get({ integrationID: server.integrationID })
          const credential = integration.data.connections.find((connection) => connection.type === "credential")
          if (credential) await v2.credential.remove({ credentialID: credential.id })
          return { data: true }
        },
        callback: async (_input: Json = {}) => ({ data: true }),
        authenticate: async (_input: Json = {}) => ({ data: true }),
      },
    },

    permission: {
      list: async (input: Json = {}) => {
        const result = await v2.permission.request.list(toLocation(input.directory as string | undefined))
        for (const request of result.data) permissionSessions.set(request.id, request.sessionID)
        return {
          data: result.data.map(
            (request): PermissionRequest => ({
              id: request.id,
              sessionID: request.sessionID,
              permission: request.action,
              patterns: request.resources,
              metadata: (request.metadata ?? {}) as Record<string, unknown>,
              always: request.save ?? [],
              tool: request.source ? { messageID: request.source.messageID, callID: request.source.id } : undefined,
            }),
          ),
        }
      },
      respond: async (input: Json) => {
        const sessionID = input.sessionID as string
        await v2.permission.reply({
          sessionID,
          requestID: input.permissionID as string,
          decision: input.response as "once" | "always" | "reject",
        })
        return { data: true }
      },
      reply: async (input: Json) => {
        const requestID = input.requestID as string
        const sessionID = permissionSessions.get(requestID)
        if (!sessionID) throw new Error("Permission request session not found")
        await v2.permission.reply({
          sessionID,
          requestID,
          decision: input.reply as "once" | "always" | "reject",
          message: input.message as string | undefined,
        })
        return { data: true }
      },
    },

    question: {
      list: async (input: Json = {}) => {
        const result = await v2.form.list(toLocation(input.directory as string | undefined))
        return {
          data: result.data.map((form) => {
            formCache.set(form.id, form)
            return projectForm(form)
          }),
        }
      },
      reply: async (input: Json) => {
        const form = formCache.get(input.requestID as string)
        if (!form) throw new Error("Form not found")
        const answers = (input.answers as string[][]) ?? []
        const answer: Record<string, string | string[]> = {}
        form.fields.forEach((field, index) => {
          const selected = answers[index] ?? []
          if (!selected.length) return
          const values = "options" in field && Array.isArray(field.options)
            ? selected.map((label) => field.options?.find((option) => option.label === label)?.value ?? label)
            : selected
          answer[field.key] = field.type === "multiselect" ? values : values[0]
        })
        await v2.session.form.reply({ sessionID: form.sessionID, formID: form.id, answer })
        formCache.delete(form.id)
        return { data: true }
      },
      reject: async (input: Json) => {
        const form = formCache.get(input.requestID as string)
        if (!form) throw new Error("Form not found")
        await v2.session.form.cancel({ sessionID: form.sessionID, formID: form.id })
        formCache.delete(form.id)
        return { data: true }
      },
    },

    pty: {
      list: async (input: Json = {}) => {
        const result = await v2.pty.list(toLocation(input.directory as string | undefined))
        return { data: result.data as LegacyPty[] }
      },
      shells: async (_input: Json = {}) => {
        const shells = await v2.config.shells()
        return { data: shells.map((shell) => ({ path: shell.path, name: shell.name, acceptable: shell.acceptable })) }
      },
      create: async (input: Json) => {
        const result = await v2.pty.create({
          command: input.command as string | undefined,
          args: input.args as string[] | undefined,
          cwd: input.cwd as string | undefined,
          title: input.title as string | undefined,
          env: input.env as Record<string, string> | undefined,
          ...toLocation(input.directory as string | undefined),
        })
        return { data: result.data as LegacyPty }
      },
      get: async (input: Json) => {
        const result = await v2.pty.get({ ptyID: input.ptyID as string, ...toLocation(input.directory as string | undefined) })
        return { data: result.data as LegacyPty }
      },
      update: async (input: Json) => {
        const result = await v2.pty.update({
          ptyID: input.ptyID as string,
          title: input.title as string | undefined,
          size: input.size as { rows: number; cols: number } | undefined,
          ...toLocation(input.directory as string | undefined),
        })
        return { data: result.data as LegacyPty }
      },
      remove: async (input: Json) => {
        await v2.pty.remove({ ptyID: input.ptyID as string, ...toLocation(input.directory as string | undefined) })
        return { data: true }
      },
    },

    tool: {
      ids: async (_input: Json = {}) => ({ data: [] as string[] }),
      list: async (_input: Json = {}) => ({ data: [] as ToolList }),
    },

    vcs: {
      get: async (input: Json = {}) => ({
        data: projectVcsInfo(
          (await v2.vcs.get(toLocation(input.directory as string | undefined))).data as never,
        ) as VcsInfo,
      }),
      branch: {
        list: async (input: Json = {}) => {
          const location = toLocation(input.directory as string | undefined)
          const [branches, info] = await Promise.all([v2.vcs.branch.list(location), v2.vcs.get(location)])
          const current = info.data.branch.current
          return {
            data: branches.data.map((name) => ({ name, current: name === current })),
          }
        },
        switch: async (input: Json) => {
          const result = await options.requestJson<{ branch: string }>("/vcs/branch", {
            method: "POST",
            body: JSON.stringify({ branch: input.branch, directory: input.directory }),
          })
          return { data: result }
        },
      },
      diff: async (input: Json) => {
        const result = await v2.vcs.diff({
          mode: input.mode as "working" | "branch" | "committed",
          ...toLocation(input.directory as string | undefined),
        })
        return { data: result.data as unknown as SnapshotFileDiff[] }
      },
      stage: async (input: Json) => {
        const result = await options.requestJson<{ output: string }>("/vcs/stage", {
          method: "POST",
          body: JSON.stringify({ files: input.files, directory: input.directory }),
        })
        return { data: result }
      },
      unstage: async (input: Json) => {
        const result = await options.requestJson<{ output: string }>("/vcs/unstage", {
          method: "POST",
          body: JSON.stringify({ files: input.files, directory: input.directory }),
        })
        return { data: result }
      },
      discard: async (input: Json) => {
        const result = await options.requestJson<{ output: string }>("/vcs/discard", {
          method: "POST",
          body: JSON.stringify({ files: input.files, directory: input.directory }),
        })
        return { data: result }
      },
      commit: async (input: Json) => {
        const result = await options.requestJson<{ output: string }>("/vcs/commit", {
          method: "POST",
          body: JSON.stringify({ message: input.message, directory: input.directory }),
        })
        return { data: result }
      },
      push: async (input: Json) => {
        const result = await options.requestJson<{ output: string }>("/vcs/push", {
          method: "POST",
          body: JSON.stringify({ directory: input.directory }),
        })
        return { data: result }
      },
      operation: async (input: Json) => {
        const result = await options.requestJson<{ output: string }>("/vcs/operation", {
          method: "POST",
          body: JSON.stringify({ action: input.action, argument: input.argument, directory: input.directory }),
        })
        return { data: result }
      },
      history: async (input: Json = {}) => {
        const query = new URLSearchParams()
        if (input.directory) query.set("directory", String(input.directory))
        if (input.limit) query.set("limit", String(input.limit))
        const result = await options.requestJson<Array<{ hash: string; shortHash: string; author: string; timestamp: number; subject: string }>>(
          `/vcs/history?${query.toString()}`,
        )
        return { data: result }
      },
    },

    worktree: {
      list: async (input: Json = {}) => {
        const project = await projectByDirectory(input.directory as string | undefined)
        if (!project) return { data: [] as string[] }
        const result = await v2.worktree.list({ projectID: project.id })
        return { data: result.map((item) => item.directory) }
      },
      create: async (input: Json = {}) => {
        const project = await projectByDirectory(input.directory as string | undefined)
        if (!project) throw new Error("Project not found")
        const params = (input.worktreeCreateInput ?? {}) as Json
        const result = await v2.worktree.create({
          projectID: project.id,
          from: params.from as string | undefined,
          branch: params.branch as string | undefined,
          directory: params.directory as string | undefined,
          name: params.name as string | undefined,
        })
        return { data: { name: result.directory.split(/[\\/]/).at(-1) ?? "", branch: params.branch as string | undefined, directory: result.directory } satisfies Worktree }
      },
      remove: async (input: Json = {}) => {
        const project = await projectByDirectory(input.directory as string | undefined)
        if (!project) throw new Error("Project not found")
        const params = (input.worktreeRemoveInput ?? {}) as Json
        await v2.worktree.remove({
          projectID: project.id,
          directory: String(params.directory ?? ""),
          force: params.force === true,
        })
        return { data: true }
      },
      reset: async (input: Json = {}) => {
        await options.requestJson("/experimental/worktree/reset", {
          method: "POST",
          body: JSON.stringify({
            directory: input.directory,
            ...(input.worktreeResetInput as Json | undefined),
          }),
        })
        return { data: true }
      },
    },

    lsp: {
      status: async (_input: Json = {}) => ({ data: [] as LspStatus[] }),
    },

    formatter: {
      status: async (_input: Json = {}) => ({ data: [] as FormatterStatus[] }),
    },

    experimental: {
      session: {
        list: async (input: Json = {}) => {
          const result = await v2.session.list({
            search: input.search as string | undefined,
            limit: input.limit as number | undefined,
            archived: input.archived === true || input.archived === "true" ? true : undefined,
          })
          return { data: result.data.map(projectSession) }
        },
      },
      controlPlane: {
        moveSession: async (input: Json) => {
          await options.requestJson("/experimental/control-plane/move-session", {
            method: "POST",
            body: JSON.stringify({
              sessionID: input.sessionID,
              destination: input.destination,
              moveChanges: input.moveChanges,
            }),
          })
          return { data: true }
        },
      },
    },
  }
}

export type LegacyClient = ReturnType<typeof makeLegacyClient>

export type ProjectMessages = MessageWithParts[]
export type ProviderList = Provider[]
export type SessionList = Session[]
