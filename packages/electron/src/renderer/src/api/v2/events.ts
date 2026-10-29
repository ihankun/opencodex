// V2 事件 → 旧 UI 事件投影。
//
// 服务端现在推送 /api/event 的 V2 事件（session.text.delta、session.tool.* 等）。
// renderer 的 messageStore / sessionStore 仍按 V1 事件消费，这里做有状态的转换，
// 并把流式片段合成为旧版的 message/part 事件。

import type {
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  V2Event,
} from "@opencode/client"
import type {
  AssistantMessage,
  GlobalEvent,
  Part,
  QuestionRequest,
  Session,
  SnapshotFileDiff,
  Todo,
} from "../../types/api/legacy-sdk"
import { projectAssistantParts, projectForm } from "./project"

const zeroTokens = () => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
})

function createdOf(event: V2Event): number {
  return "created" in event && typeof event.created === "number" ? event.created : Date.now()
}

function locationOf(event: V2Event): string {
  if (!("location" in event)) return ""
  return (event.location as { directory?: string } | undefined)?.directory ?? ""
}

function envelope(event: V2Event, type: string, properties: Record<string, unknown>): GlobalEvent {
  if (!("id" in event) || typeof event.id !== "string") return { directory: "", payload: { id: "", type, properties } as GlobalEvent["payload"] }
  return {
    directory: locationOf(event),
    payload: { id: event.id, type, properties } as GlobalEvent["payload"],
  }
}

function assistantInfo(
  sessionID: string,
  messageID: string,
  created: number,
  agent?: string,
  model?: { id: string; providerID: string; variant?: string },
): AssistantMessage {
  return {
    id: messageID,
    sessionID,
    role: "assistant",
    time: { created },
    parentID: "",
    modelID: model?.id ?? "",
    providerID: model?.providerID ?? "",
    mode: "",
    agent: agent ?? "",
    path: { cwd: "", root: "" },
    cost: 0,
    tokens: zeroTokens(),
    variant: model?.variant,
  }
}

function textPart(sessionID: string, messageID: string, ordinal: number, text: string): Part {
  return {
    id: `${messageID}:text:${ordinal}`,
    sessionID,
    messageID,
    type: "text",
    text,
  }
}

function reasoningPart(sessionID: string, messageID: string, ordinal: number, text: string, created: number): Part {
  return {
    id: `${messageID}:reasoning:${ordinal}`,
    sessionID,
    messageID,
    type: "reasoning",
    text,
    time: { start: created },
  }
}

function toolPart(
  sessionID: string,
  messageID: string,
  callID: string,
  tool: string,
  state: SessionMessageAssistantTool["state"],
  time: { created: number; ran?: number; completed?: number },
): Part {
  const start = time.ran ?? time.created
  const mapped =
    state.status === "streaming"
      ? { status: "pending" as const, input: {}, raw: state.input }
      : state.status === "running"
        ? { status: "running" as const, input: state.input, metadata: state.metadata, time: { start } }
        : state.status === "completed"
          ? {
              status: "completed" as const,
              input: state.input,
              output: state.content.map((item) => ("text" in item ? item.text : "")).join(""),
              title: String(state.metadata?.title ?? tool),
              metadata: state.metadata ?? {},
              time: { start, end: time.completed ?? Date.now() },
            }
          : {
              status: "error" as const,
              input: state.input,
              error: state.error.message,
              metadata: state.metadata,
              time: { start, end: time.completed ?? Date.now() },
            }
  return {
    id: `${messageID}:tool:${callID}`,
    sessionID,
    messageID,
    type: "tool",
    callID,
    tool,
    state: mapped,
  }
}

export function createEventProjector() {
  const seenMessages = new Set<string>()
  const stepCounts = new Map<string, number>()
  const rawToolInput = new Map<string, string>()

  return function project(event: V2Event): GlobalEvent[] {
    switch (event.type) {
      case "session.created": {
        const data = event.data
        const info: Session = {
          id: data.sessionID,
          slug: data.slug,
          projectID: data.projectID,
          directory: data.location.directory,
          parentID: data.parentID,
          title: data.title ?? "Untitled",
          agent: data.agent,
          model: data.model,
          version: data.version,
          metadata: data.metadata as Record<string, unknown> | undefined,
          permission: data.permissions as Session["permission"],
          cost: 0,
          tokens: zeroTokens(),
          time: { created: createdOf(event), updated: createdOf(event) },
        }
        return [envelope(event, "session.created", { sessionID: data.sessionID, info })]
      }
      case "session.renamed":
      case "session.archived":
      case "session.unarchived":
      case "session.agent.selected":
      case "session.model.selected": {
        const sessionID = event.data.sessionID
        const info = { id: sessionID, directory: (event.location as { directory?: string })?.directory ?? "" } as Session
        if (event.type === "session.renamed") info.title = event.data.title
        if (event.type === "session.archived") info.time = { created: 0, updated: 0, archived: createdOf(event) }
        if (event.type === "session.agent.selected") info.agent = event.data.agent
        if (event.type === "session.model.selected") info.model = event.data.model
        return [envelope(event, "session.updated", { sessionID, info })]
      }
      case "session.deleted": {
        const sessionID = event.data.sessionID
        return [
          envelope(event, "session.deleted", {
            sessionID,
            info: { id: sessionID, directory: (event.location as { directory?: string })?.directory ?? "" } as Session,
          }),
        ]
      }
      case "session.execution.started": {
        const sessionID = event.data.sessionID
        return [envelope(event, "session.status", { sessionID, status: { type: "busy" } })]
      }
      case "session.execution.succeeded":
      case "session.execution.interrupted": {
        const sessionID = event.data.sessionID
        return [
          envelope(event, "session.status", { sessionID, status: { type: "idle" } }),
          envelope(event, "session.idle", { sessionID }),
        ]
      }
      case "session.execution.failed": {
        const sessionID = event.data.sessionID
        return [
          envelope(event, "session.error", {
            sessionID,
            error: { name: "UnknownError", data: { message: event.data.error.message } },
          }),
          envelope(event, "session.idle", { sessionID }),
        ]
      }
      case "session.idle": {
        const sessionID = event.data.sessionID
        return [envelope(event, "session.idle", { sessionID })]
      }
      case "session.retry.scheduled": {
        const sessionID = event.data.sessionID
        return [
          envelope(event, "session.status", {
            sessionID,
            status: {
              type: "retry",
              attempt: event.data.attempt,
              message: event.data.error.message,
              next: event.data.at,
            },
          }),
        ]
      }
      case "session.compaction.ended": {
        return [envelope(event, "session.compacted", { sessionID: event.data.sessionID })]
      }
      case "session.step.started": {
        const { sessionID, assistantMessageID, agent, model, snapshot } = event.data
        const step = stepCounts.get(assistantMessageID) ?? 0
        stepCounts.set(assistantMessageID, step + 1)
        const events: GlobalEvent[] = []
        if (!seenMessages.has(assistantMessageID)) {
          seenMessages.add(assistantMessageID)
          events.push(
            envelope(event, "message.updated", {
              info: assistantInfo(sessionID, assistantMessageID, createdOf(event), agent, model),
            }),
          )
        }
        events.push(
          envelope(event, "message.part.updated", {
            part: {
              id: `${assistantMessageID}:step:${step}:start`,
              sessionID,
              messageID: assistantMessageID,
              type: "step-start",
              snapshot,
            } satisfies Part,
          }),
        )
        return events
      }
      case "session.step.ended": {
        const { sessionID, assistantMessageID, finish, cost, tokens, snapshot } = event.data
        const step = Math.max(0, (stepCounts.get(assistantMessageID) ?? 1) - 1)
        return [
          envelope(event, "message.part.updated", {
            part: {
              id: `${assistantMessageID}:step:${step}:finish`,
              sessionID,
              messageID: assistantMessageID,
              type: "step-finish",
              reason: finish,
              snapshot,
              cost,
              tokens,
            } satisfies Part,
          }),
        ]
      }
      case "session.text.started": {
        const { sessionID, assistantMessageID, ordinal } = event.data
        return [
          ...ensureMessage(event, sessionID, assistantMessageID),
          envelope(event, "message.part.updated", {
            part: textPart(sessionID, assistantMessageID, ordinal, ""),
          }),
        ]
      }
      case "session.text.delta": {
        const { sessionID, assistantMessageID, ordinal, delta } = event.data
        return [
          envelope(event, "message.part.delta", {
            sessionID,
            messageID: assistantMessageID,
            partID: `${assistantMessageID}:text:${ordinal}`,
            field: "text",
            delta,
          }),
        ]
      }
      case "session.text.ended": {
        const { sessionID, assistantMessageID, ordinal, text } = event.data
        return [
          envelope(event, "message.part.updated", {
            part: textPart(sessionID, assistantMessageID, ordinal, text),
          }),
        ]
      }
      case "session.reasoning.started": {
        const { sessionID, assistantMessageID, ordinal } = event.data
        return [
          ...ensureMessage(event, sessionID, assistantMessageID),
          envelope(event, "message.part.updated", {
            part: reasoningPart(sessionID, assistantMessageID, ordinal, "", createdOf(event)),
          }),
        ]
      }
      case "session.reasoning.delta": {
        const { sessionID, assistantMessageID, ordinal, delta } = event.data
        return [
          envelope(event, "message.part.delta", {
            sessionID,
            messageID: assistantMessageID,
            partID: `${assistantMessageID}:reasoning:${ordinal}`,
            field: "text",
            delta,
          }),
        ]
      }
      case "session.reasoning.ended": {
        const { sessionID, assistantMessageID, ordinal, text } = event.data
        return [
          envelope(event, "message.part.updated", {
            part: reasoningPart(sessionID, assistantMessageID, ordinal, text, createdOf(event)),
          }),
        ]
      }
      case "session.tool.input.started": {
        const { sessionID, assistantMessageID, id, name } = event.data
        rawToolInput.set(id, "")
        return [
          ...ensureMessage(event, sessionID, assistantMessageID),
          envelope(event, "message.part.updated", {
            part: toolPart(sessionID, assistantMessageID, id, name, { status: "streaming", input: "" }, { created: createdOf(event) }),
          }),
        ]
      }
      case "session.tool.input.delta": {
        const { sessionID, assistantMessageID, id, delta } = event.data
        const raw = (rawToolInput.get(id) ?? "") + delta
        rawToolInput.set(id, raw)
        return [
          envelope(event, "message.part.updated", {
            part: toolPart(
              sessionID,
              assistantMessageID,
              id,
              "tool",
              { status: "streaming", input: raw },
              { created: createdOf(event) },
            ),
          }),
        ]
      }
      case "session.tool.input.ended": {
        const { sessionID, assistantMessageID, id, text } = event.data
        rawToolInput.set(id, text)
        return [
          envelope(event, "message.part.updated", {
            part: toolPart(
              sessionID,
              assistantMessageID,
              id,
              "tool",
              { status: "streaming", input: text },
              { created: createdOf(event) },
            ),
          }),
        ]
      }
      case "session.tool.called": {
        const { sessionID, assistantMessageID, id, input } = event.data
        return [
          envelope(event, "message.part.updated", {
            part: toolPart(
              sessionID,
              assistantMessageID,
              id,
              rawToolInput.get(id) ? "tool" : "tool",
              { status: "running", input, metadata: {} },
              { created: createdOf(event), ran: createdOf(event) },
            ),
          }),
        ]
      }
      case "session.tool.progress": {
        const { sessionID, assistantMessageID, id, metadata } = event.data
        return [
          envelope(event, "message.part.updated", {
            part: toolPart(
              sessionID,
              assistantMessageID,
              id,
              "tool",
              { status: "running", input: {}, metadata },
              { created: createdOf(event), ran: createdOf(event) },
            ),
          }),
        ]
      }
      case "session.tool.success": {
        const { sessionID, assistantMessageID, id, content, metadata } = event.data
        const events = [
          envelope(event, "message.part.updated", {
            part: toolPart(
              sessionID,
              assistantMessageID,
              id,
              "tool",
              { status: "completed", input: {}, content, metadata },
              { created: createdOf(event), completed: createdOf(event) },
            ),
          }),
        ]
        const todos = metadata?.todos
        if (Array.isArray(todos)) {
          events.push(
            envelope(event, "todo.updated", {
              sessionID,
              todos: todos as Todo[],
            }),
          )
        }
        return events
      }
      case "session.tool.failed": {
        const { sessionID, assistantMessageID, id, error, content, metadata } = event.data
        return [
          envelope(event, "message.part.updated", {
            part: toolPart(
              sessionID,
              assistantMessageID,
              id,
              "tool",
              { status: "error", input: {}, error, content, metadata },
              { created: createdOf(event), completed: createdOf(event) },
            ),
          }),
        ]
      }
      case "permission.asked": {
        const data = event.data
        return [
          envelope(event, "permission.asked", {
            id: data.id,
            sessionID: data.sessionID,
            permission: data.action,
            patterns: data.resources,
            metadata: data.metadata ?? {},
            always: data.save ?? [],
            tool: data.source ? { messageID: data.source.messageID, callID: data.source.id } : undefined,
          }),
        ]
      }
      case "permission.replied": {
        return [
          envelope(event, "permission.replied", {
            sessionID: event.data.sessionID,
            requestID: event.data.requestID,
            reply: event.data.reply,
          }),
        ]
      }
      case "form.created": {
        const question: QuestionRequest = projectForm(event.data.form as never)
        return [envelope(event, "question.asked", question as unknown as Record<string, unknown>)]
      }
      case "form.replied": {
        const answer = event.data.answer
        return [
          envelope(event, "question.replied", {
            sessionID: event.data.sessionID,
            requestID: event.data.id,
            answers: Object.values(answer).map((value) => (Array.isArray(value) ? value : [String(value)])),
          }),
        ]
      }
      case "form.cancelled": {
        return [
          envelope(event, "question.rejected", {
            sessionID: event.data.sessionID,
            requestID: event.data.id,
          }),
        ]
      }
      case "project.updated": {
        const data = event.data
        return [
          envelope(event, "project.updated", {
            id: data.id,
            worktree: data.canonical,
            vcs: data.vcs,
            name: data.name,
            icon: data.icon,
            commands: data.commands,
            time: data.time,
            sandboxes: data.sandboxes,
          }),
        ]
      }
      case "worktree.updated":
      case "worktree.resolved": {
        const directory = "directory" in event.data ? event.data.directory : undefined
        return [
          envelope(event, "worktree.ready", {
            name: directory ? directory.split(/[\\/]/).at(-1) ?? "" : "",
          }),
        ]
      }
      case "server.connected": {
        return [envelope(event, "server.connected", { timestamp: createdOf(event) })]
      }
      default:
        return []
    }
  }

  function ensureMessage(event: V2Event, sessionID: string, messageID: string): GlobalEvent[] {
    if (seenMessages.has(messageID)) return []
    seenMessages.add(messageID)
    return [
      envelope(event, "message.updated", {
        info: assistantInfo(sessionID, messageID, createdOf(event)),
      }),
    ]
  }
}

export type { SnapshotFileDiff }
