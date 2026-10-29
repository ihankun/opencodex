// V2 → 旧版 UI 类型投影。
// Electron renderer 的 UI 仍消费 V1 形状的数据，这里把 V2 的 Session/Message/Provider
// 等模型转换成旧结构，避免重写全部组件。

import type {
  AgentInfo,
  FormInfo,
  McpServer,
  ModelInfo,
  Project as V2Project,
  ProviderInfo,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageInfo,
  SessionMessageUser,
  SessionStructuredError,
  SkillInfo,
  VcsInfo as V2VcsInfo,
} from "@opencode/client"
import type { MessageWithParts } from "../../types/api/message"
import type { Skill } from "../../types/api/skill"
import type {
  Agent,
  AssistantMessage,
  FilePart,
  McpStatus,
  McpStatusResponse,
  Model,
  Part,
  Project,
  Provider,
  QuestionRequest,
  Session,
  ToolState,
  VcsInfo,
} from "../../types/api/legacy-sdk"

type LegacyFileSource = NonNullable<FilePart["source"]>

const zeroTokens = () => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
})

export function projectSession(info: SessionInfo): Session {
  return {
    id: info.id,
    slug: info.id,
    projectID: info.projectID,
    directory: info.location.directory,
    parentID: info.parentID,
    title: info.title ?? "Untitled",
    agent: info.agent,
    model: info.model,
    cost: info.cost,
    tokens: info.tokens,
    metadata: info.metadata as Record<string, unknown> | undefined,
    time: {
      created: info.time.created,
      updated: info.time.updated,
      compacting: info.time.idle,
      archived: info.time.archived,
    },
    permission: info.permissions as Session["permission"],
    revert: info.revert
      ? {
          messageID: info.revert.messageID,
          partID: info.revert.partID,
          snapshot: info.revert.snapshot,
        }
      : undefined,
    version: "",
  }
}

function filePart(sessionID: string, messageID: string, index: number, file: NonNullable<SessionMessageUser["files"]>[number]): FilePart {
  const url = file.source.type === "uri" ? file.source.uri : `data:${file.mime};base64,${file.data}`
  const source: LegacyFileSource | undefined = file.mention
    ? {
        text: { value: file.mention.text, start: file.mention.start, end: file.mention.end },
        type: "file",
        path: file.name ?? "",
      }
    : undefined
  return {
    id: `${messageID}:file:${index}`,
    sessionID,
    messageID,
    type: "file",
    mime: file.mime,
    filename: file.name,
    url,
    source,
  }
}

function toolContentText(tool: SessionMessageAssistantTool): string {
  if (tool.state.status === "error") return tool.state.content?.map((item) => ("text" in item ? item.text : "")).join("") ?? ""
  if (tool.state.status !== "completed") return ""
  return tool.state.content.map((item) => ("text" in item ? item.text : "")).join("")
}

function toolState(tool: SessionMessageAssistantTool): ToolState {
  const start = tool.time.ran ?? tool.time.created
  if (tool.state.status === "streaming") {
    return { status: "pending", input: {}, raw: tool.state.input }
  }
  if (tool.state.status === "running") {
    return {
      status: "running",
      input: tool.state.input,
      metadata: tool.state.metadata,
      time: { start },
    }
  }
  if (tool.state.status === "completed") {
    return {
      status: "completed",
      input: tool.state.input,
      output: toolContentText(tool),
      title: String(tool.state.metadata?.title ?? tool.name),
      metadata: tool.state.metadata ?? {},
      time: { start, end: tool.time.completed ?? Date.now() },
    }
  }
  return {
    status: "error",
    input: tool.state.input,
    error: tool.state.error.message,
    metadata: tool.state.metadata,
    time: { start, end: tool.time.completed ?? Date.now() },
  }
}

export function projectAssistantParts(message: SessionMessageAssistant, sessionID: string): Part[] {
  const parts: Part[] = message.content.map((item, index) => {
    if (item.type === "text") {
      return {
        id: `${message.id}:text:${index}`,
        sessionID,
        messageID: message.id,
        type: "text",
        text: item.text,
      }
    }
    if (item.type === "reasoning") {
      return {
        id: `${message.id}:reasoning:${index}`,
        sessionID,
        messageID: message.id,
        type: "reasoning",
        text: item.text,
        time: { start: message.time.created, end: message.time.completed },
      }
    }
    return {
      id: `${message.id}:tool:${item.id}`,
      sessionID,
      messageID: message.id,
      type: "tool",
      callID: item.id,
      tool: item.name,
      state: toolState(item),
    }
  })

  if (message.snapshot?.files?.length) {
    parts.push({
      id: `${message.id}:patch`,
      sessionID,
      messageID: message.id,
      type: "patch",
      hash: message.snapshot.end ?? "",
      files: message.snapshot.files,
    })
  }

  if (message.time.completed) {
    parts.push({
      id: `${message.id}:step-finish`,
      sessionID,
      messageID: message.id,
      type: "step-finish",
      reason: message.finish ?? "stop",
      cost: message.cost ?? 0,
      tokens: message.tokens ?? zeroTokens(),
    })
  }

  return parts
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function userMessage(message: SessionMessageUser, sessionID: string): MessageWithParts {
  const stored = isRecord(message.metadata) ? message.metadata.opencodex : undefined
  const storedParts = isRecord(stored) && Array.isArray(stored.parts) ? stored.parts : undefined
  const parts: Part[] = storedParts
    ? storedParts.flatMap((item, index): Part[] => {
        if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") return []
        return [
          {
            id: `${message.id}:text:${index}`,
            sessionID,
            messageID: message.id,
            type: "text",
            text: item.text,
            synthetic: item.synthetic === true,
            metadata: isRecord(item.metadata) ? item.metadata : undefined,
          },
        ]
      })
    : [
        {
          id: `${message.id}:text`,
          sessionID,
          messageID: message.id,
          type: "text",
          text: message.text,
        },
      ]
  for (const [index, file] of (message.files ?? []).entries()) {
    parts.push(filePart(sessionID, message.id, index, file))
  }
  for (const [index, agent] of (message.agents ?? []).entries()) {
    parts.push({
      id: `${message.id}:agent:${index}`,
      sessionID,
      messageID: message.id,
      type: "agent",
      name: agent.name,
      source: agent.mention
        ? { value: agent.mention.text, start: agent.mention.start, end: agent.mention.end }
        : undefined,
    })
  }
  return {
    info: {
      id: message.id,
      sessionID,
      role: "user",
      time: { created: message.time.created },
      agent: "",
      model: { providerID: "", modelID: "" },
    },
    parts,
  }
}

export function projectMessage(message: SessionMessageInfo, sessionID: string): MessageWithParts | null {
  if (message.type === "user") return userMessage(message, sessionID)
  if (message.type !== "assistant") return null
  return {
    info: {
      id: message.id,
      sessionID,
      role: "assistant",
      time: { created: message.time.created, completed: message.time.completed },
      parentID: "",
      modelID: message.model.id,
      providerID: message.model.providerID,
      mode: "",
      agent: message.agent,
      path: { cwd: "", root: "" },
      cost: message.cost ?? 0,
      tokens: message.tokens ?? zeroTokens(),
      variant: message.model.variant,
      finish: message.finish,
      error: message.error ? projectStructuredError(message.error) : undefined,
    },
    parts: projectAssistantParts(message, sessionID),
  }
}

export function projectStructuredError(error: SessionStructuredError): AssistantMessage["error"] {
  return {
    name: "APIError",
    data: {
      message: error.message,
      statusCode: error.status,
      isRetryable: error.type !== "provider.free-limit",
      responseBody: error.response?.body,
      type: error.type,
      retryAfterMs: error.retryAfterMs,
    },
  } as AssistantMessage["error"]
}

export function projectMessages(messages: SessionMessageInfo[], sessionID: string): MessageWithParts[] {
  return messages.flatMap((message) => {
    const projected = projectMessage(message, sessionID)
    return projected ? [projected] : []
  })
}

export function projectModel(model: ModelInfo): Model {
  const capabilities = model.capabilities as {
    temperature?: boolean
    reasoning?: boolean
    attachment?: boolean
    toolcall?: boolean
    input?: { text?: boolean; audio?: boolean; image?: boolean; video?: boolean; pdf?: boolean }
    output?: { text?: boolean; audio?: boolean; image?: boolean; video?: boolean; pdf?: boolean }
    interleaved?: boolean | { field: string }
  }
  const cost = (Array.isArray(model.cost) ? model.cost[0] : undefined) as
    | { input?: number; output?: number; cache?: { read?: number; write?: number } }
    | undefined
  return {
    id: model.modelID,
    providerID: model.providerID,
    api: { id: model.modelID, url: "", npm: model.package ?? "" },
    name: model.name,
    family: model.family,
    status: model.status,
    capabilities: {
      temperature: capabilities.temperature ?? false,
      reasoning: capabilities.reasoning ?? false,
      attachment: capabilities.attachment ?? false,
      toolcall: capabilities.toolcall ?? false,
      input: {
        text: capabilities.input?.text ?? true,
        audio: capabilities.input?.audio ?? false,
        image: capabilities.input?.image ?? false,
        video: capabilities.input?.video ?? false,
        pdf: capabilities.input?.pdf ?? false,
      },
      output: {
        text: capabilities.output?.text ?? true,
        audio: capabilities.output?.audio ?? false,
        image: capabilities.output?.image ?? false,
        video: capabilities.output?.video ?? false,
        pdf: capabilities.output?.pdf ?? false,
      },
      interleaved: capabilities.interleaved ?? false,
    },
    cost: {
      input: cost?.input ?? 0,
      output: cost?.output ?? 0,
      cache: { read: cost?.cache?.read ?? 0, write: cost?.cache?.write ?? 0 },
    },
    limit: { context: model.limit.context, output: model.limit.output },
    options: {},
  } as Model
}

export function projectProvider(provider: ProviderInfo, models: ModelInfo[]): Provider {
  const result: Record<string, Model> = {}
  for (const model of models) {
    if (model.providerID !== provider.id) continue
    result[model.modelID] = projectModel(model)
  }
  return {
    id: provider.id,
    name: provider.name,
    source: provider.activation === "auto" ? "config" : provider.activation === "enabled" ? "config" : "api",
    env: [],
    options: {},
    models: result,
  }
}

export function projectProject(project: V2Project): Project {
  return {
    id: project.id,
    worktree: project.canonical,
    vcs: project.vcs as Project["vcs"],
    name: project.name,
    icon: project.icon as Project["icon"],
    commands: project.commands as Project["commands"],
    time: project.time as Project["time"],
    sandboxes: project.sandboxes,
  }
}

export function projectAgent(agent: AgentInfo): Agent {
  return {
    name: agent.name,
    description: agent.description,
    mode: agent.mode,
    hidden: agent.hidden,
    color: agent.color,
    permission: agent.permissions as unknown as Agent["permission"],
    model: agent.model ? { modelID: agent.model.id, providerID: agent.model.providerID } : undefined,
    prompt: agent.system,
    options: {},
    steps: agent.steps,
  }
}

export function projectSkill(skill: SkillInfo): Skill {
  return {
    name: skill.name,
    description: skill.description,
    location: skill.path,
    content: skill.content,
  } as Skill
}

export function projectVcsInfo(info: V2VcsInfo | null): VcsInfo {
  return {
    branch: info?.branch.current,
    default_branch: info?.branch.default,
    remote_url: undefined,
  }
}

export function projectMcpStatus(server: McpServer): McpStatus {
  const status = server.status
  if (status.status === "connected") return { status: "connected" }
  if (status.status === "disabled") return { status: "disabled" }
  if (status.status === "failed") return { status: "failed", error: status.error }
  if (status.status === "needs_auth") return { status: "needs_auth" }
  return { status: "disabled" }
}

export function projectMcpResponse(servers: McpServer[]): McpStatusResponse {
  return Object.fromEntries(servers.map((server) => [server.name, projectMcpStatus(server)])) as McpStatusResponse
}

export function projectTodoItemsFromTool(tool: SessionMessageAssistantTool): Array<Record<string, unknown>> | undefined {
  if (tool.name !== "todowrite" && tool.name !== "todo") return undefined
  const raw = tool.state.status === "completed" ? tool.state.metadata : undefined
  const todos = raw?.todos
  if (!Array.isArray(todos)) return undefined
  return todos as Array<Record<string, unknown>>
}

export function projectForm(form: FormInfo): QuestionRequest {
  const questions = form.fields.map((field) => {
    const options =
      "options" in field && Array.isArray(field.options)
        ? field.options.map((option) => ({ label: option.label, description: option.description ?? option.value }))
        : []
    return {
      question: field.title ?? field.description ?? field.key,
      header: (field.title ?? field.key).slice(0, 30),
      options,
      multiple: field.type === "multiselect",
      custom: "custom" in field ? field.custom === true : false,
    }
  })
  return { id: form.id, sessionID: form.sessionID, questions }
}
