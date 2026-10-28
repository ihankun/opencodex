import { OpenCode } from "@opencode/client"
import type { Event, Message, Model, Part, Provider } from "@opencode/client"
import "./styles.css"

type ServerInfo = {
  url: string
  username: string
  password: string
}

type ModelOption = {
  providerID: string
  providerName: string
  modelID: string
  name: string
  variants: string[]
}

type LocalMessage = {
  id: string
  role: "user" | "assistant"
  text: string
  completed?: boolean
}

const status = document.querySelector("#status")
const serverUrl = document.querySelector("#server-url")
const promptInput = document.querySelector<HTMLTextAreaElement>("#prompt-input")
const sendButton = document.querySelector<HTMLButtonElement>("#send-button")
const modelButton = document.querySelector<HTMLButtonElement>("#model-button")
const variantButton = document.querySelector<HTMLButtonElement>("#variant-button")
const modelMenu = document.querySelector<HTMLDivElement>("#model-menu")
const conversation = document.querySelector<HTMLElement>("#conversation")

let server: ServerInfo | undefined
let client: ReturnType<typeof OpenCode.make> | undefined
let sessionID: string | undefined
let sending = false
let eventsStarted = false
let models: ModelOption[] = []
let selectedModel: ModelOption | undefined
let selectedVariant: string | null = "medium"
let modelLoadError: string | undefined
let messages: LocalMessage[] = []
const partText = new Map<string, string>()
const messageParts = new Map<string, Set<string>>()

async function renderServerStatus() {
  const state = await window.customOpenCode.server()

  if (state.status !== "online") {
    if (status) status.textContent = state.error ? "Server error" : "Starting"
    if (serverUrl) serverUrl.textContent = state.error ?? "Starting opencode server..."
    return
  }

  server = state.server
  client = OpenCode.make({
    baseUrl: server.url,
    headers: authHeaders(server),
    throwOnError: true,
  })

  const response = await fetch(new URL("/global/health", server.url), {
    headers: authHeaders(server),
  })

  if (status) status.textContent = response.ok ? "Online" : "Unhealthy"
  if (serverUrl) serverUrl.textContent = server.url
  startEvents()
  await loadModels()
}

function authHeaders(input: ServerInfo) {
  return {
    Authorization: `Basic ${btoa(`${input.username}:${input.password}`)}`,
  }
}

async function loadModels() {
  if (!client) return
  modelLoadError = undefined
  renderModelControls()

  try {
    const response = await client.config.providers()
    const data = response.data
    if (!data) return

    models = data.providers.flatMap(providerToModelOptions)
    selectedModel = findDefaultModel(data.default) ?? models[0]
    selectedVariant = selectedModel?.variants.includes("medium")
      ? "medium"
      : (selectedModel?.variants[0] ?? null)
  } catch (error) {
    modelLoadError = errorMessage(error)
    models = []
    selectedModel = undefined
    selectedVariant = null
  }

  renderModelControls()
  updateComposerState()
}

function providerToModelOptions(provider: Provider): ModelOption[] {
  return Object.entries(provider.models)
    .filter(([, model]) => modelEnabled(model))
    .map(([modelID, model]) => ({
      providerID: provider.id,
      providerName: provider.name,
      modelID,
      name: model.name || modelID,
      variants: modelVariants(model),
    }))
}

function modelEnabled(model: Model) {
  const status = "status" in model ? model.status : undefined
  const enabled = "enabled" in model ? model.enabled : undefined
  if (enabled === false) return false
  if (status && status !== "active") return false
  return true
}

function modelVariants(model: Model) {
  if (!model.variants) return []
  return Array.isArray(model.variants) ? model.variants.map((variant) => variant.id) : Object.keys(model.variants)
}

function findDefaultModel(defaults: Record<string, string>) {
  for (const [providerID, modelID] of Object.entries(defaults)) {
    const match = models.find((model) => model.providerID === providerID && model.modelID === modelID)
    if (match) return match
  }
  return undefined
}

function renderModelControls() {
  if (modelButton) modelButton.textContent = selectedModel ? shortModelName(selectedModel.name) : modelLoadError ? "模型错误" : "模型"
  if (variantButton) {
    variantButton.innerHTML = `${variantLabel(selectedVariant)} <svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg>`
  }
}

function shortModelName(name: string) {
  return name
    .replace(/^gpt-/i, "")
    .replace(/^claude-/i, "")
    .replace(/-latest$/i, "")
    .slice(0, 12)
}

function variantLabel(variant: string | null) {
  if (variant === null) return "关"
  if (variant === "high" || variant === "xhigh") return "高"
  if (variant === "medium") return "中"
  if (variant === "low") return "低"
  return variant
}

function cycleVariant() {
  const variants = selectedModel?.variants ?? []
  const ordered = supportedThinkingOrder(variants)
  const cycle = ordered.length > 0 ? [...ordered, null] : [null]
  const index = cycle.findIndex((item) => item === selectedVariant)
  selectedVariant = cycle[(index + 1) % cycle.length] ?? null
  renderModelControls()
}

function supportedThinkingOrder(variants: string[]) {
  const high = variants.includes("high") ? "high" : variants.includes("xhigh") ? "xhigh" : undefined
  return ["medium", high, "low"].flatMap((variant) => (variant && variants.includes(variant) ? [variant] : []))
}

function toggleModelMenu() {
  if (!modelMenu) return
  if (!modelMenu.hidden) {
    modelMenu.hidden = true
    return
  }
  renderModelMenu()
  modelMenu.hidden = false
}

function renderModelMenu() {
  if (!modelMenu) return
  if (modelLoadError || models.length === 0) {
    const empty = document.createElement("div")
    empty.className = "model-menu-empty"
    empty.textContent = modelLoadError ?? "没有可用模型。请先在 opencode 配置中连接模型提供商。"
    modelMenu.replaceChildren(empty)
    return
  }
  modelMenu.replaceChildren(
    ...models.slice(0, 120).map((model) => {
      const button = document.createElement("button")
      button.className = "model-menu-item"
      button.type = "button"
      button.innerHTML = `<strong>${escapeHtml(model.name)}</strong><span>${escapeHtml(model.providerName)}</span>`
      button.addEventListener("click", () => {
        selectedModel = model
        selectedVariant = model.variants.includes("medium") ? "medium" : (model.variants[0] ?? null)
        modelMenu.hidden = true
        renderModelControls()
        updateComposerState()
      })
      return button
    }),
  )
}

async function sendPrompt() {
  if (!client || !selectedModel || !promptInput) return
  const text = promptInput.value.trim()
  if (!text || sending) return

  sending = true
  promptInput.value = ""
  updateComposerState()

  try {
    const activeSessionID = await ensureSession()
    const userID = localID("msg")
    upsertMessage({ id: userID, role: "user", text, completed: true })
    upsertMessage({ id: "assistant-pending", role: "assistant", text: "正在思考..." })

    await client.session.promptAsync({
      sessionID: activeSessionID,
      agent: "build",
      model: {
        providerID: selectedModel.providerID,
        modelID: selectedModel.modelID,
      },
      variant: selectedVariant ?? undefined,
      parts: [{ type: "text", text }],
    })
  } catch (error) {
    upsertMessage({ id: "assistant-pending", role: "assistant", text: errorMessage(error), completed: true })
  } finally {
    sending = false
    updateComposerState()
  }
}

async function ensureSession() {
  if (sessionID) return sessionID
  if (!client || !selectedModel) throw new Error("Server or model is not ready")
  const response = await client.session.create({
    title: "新对话",
    agent: "build",
    model: {
      id: selectedModel.modelID,
      providerID: selectedModel.providerID,
      variant: selectedVariant ?? undefined,
    },
  })
  if (!response.data) throw new Error("Failed to create session")
  sessionID = response.data.id
  return sessionID
}

function startEvents() {
  if (!client || eventsStarted) return
  eventsStarted = true
  void (async () => {
    while (client) {
      try {
        const events = await client.global.event()
        for await (const event of events.stream) {
          applyEvent(event.payload as Event)
        }
      } catch (error) {
        if (status) status.textContent = `Event reconnecting: ${errorMessage(error)}`
        await sleep(1000)
      }
    }
  })()
}

function applyEvent(event: Event) {
  if (!("properties" in event)) return

  switch (event.type) {
    case "message.updated":
      if (event.properties.sessionID !== sessionID) return
      applyMessageInfo(event.properties.info)
      break
    case "message.part.updated":
      if (event.properties.sessionID !== sessionID) return
      applyPart(event.properties.part)
      break
    case "message.part.delta":
      if (event.properties.sessionID !== sessionID) return
      applyPartDelta(event.properties)
      break
    case "message.part.removed":
      if (event.properties.sessionID !== sessionID) return
      removePart(event.properties.messageID, event.properties.partID)
      break
    case "session.idle":
      if (event.properties.sessionID !== sessionID) return
      completeAssistant()
      break
    case "session.error":
      if (event.properties.sessionID !== sessionID) return
      upsertMessage({ id: "assistant-pending", role: "assistant", text: sessionErrorText(event), completed: true })
      break
  }
}

function applyMessageInfo(info: Message) {
  if (info.role === "user") return
  removePendingAssistant()
  upsertMessage({
    id: info.id,
    role: "assistant",
    text: messageText(info.id) || "正在思考...",
    completed: Boolean(info.time.completed),
  })
}

function applyPart(part: Part) {
  if (part.type !== "text" && part.type !== "reasoning") return
  partText.set(part.id, part.text)
  const parts = messageParts.get(part.messageID) ?? new Set<string>()
  parts.add(part.id)
  messageParts.set(part.messageID, parts)
  removePendingAssistant()
  upsertMessage({ id: part.messageID, role: "assistant", text: messageText(part.messageID) || "正在思考..." })
}

function applyPartDelta(data: { messageID: string; partID: string; delta: string; field?: string }) {
  if (data.field && data.field !== "text" && data.field !== "reasoning" && data.field !== "reasoning_content") return
  partText.set(data.partID, `${partText.get(data.partID) ?? ""}${data.delta}`)
  const parts = messageParts.get(data.messageID) ?? new Set<string>()
  parts.add(data.partID)
  messageParts.set(data.messageID, parts)
  removePendingAssistant()
  upsertMessage({ id: data.messageID, role: "assistant", text: messageText(data.messageID) || "正在思考..." })
}

function removePart(messageID: string, partID: string) {
  partText.delete(partID)
  messageParts.get(messageID)?.delete(partID)
  upsertMessage({ id: messageID, role: "assistant", text: messageText(messageID) || "正在思考..." })
}

function messageText(messageID: string) {
  return Array.from(messageParts.get(messageID) ?? [])
    .map((partID) => partText.get(partID) ?? "")
    .filter(Boolean)
    .join("\n\n")
}

function completeAssistant() {
  const last = messages.findLast((message) => message.role === "assistant")
  if (!last) return
  last.completed = true
  renderConversation()
}

function removePendingAssistant() {
  messages = messages.filter((message) => message.id !== "assistant-pending")
}

function upsertMessage(message: LocalMessage) {
  const index = messages.findIndex((item) => item.id === message.id)
  if (index >= 0) {
    messages[index] = { ...messages[index], ...message }
  } else {
    messages.push(message)
  }
  renderConversation()
}

function renderConversation() {
  if (!conversation) return
  conversation.replaceChildren(
    ...messages.map((message) => {
      const row = document.createElement("article")
      row.className = `message message-${message.role}`
      row.textContent = message.text
      return row
    }),
  )
  conversation.scrollTop = conversation.scrollHeight
}

function updateComposerState() {
  if (sendButton) sendButton.disabled = sending || !client || !selectedModel
  if (promptInput) promptInput.disabled = !client || !selectedModel
}

function sessionErrorText(event: Extract<Event, { type: "session.error" }>) {
  const error = event.properties.error
  if (!error) return "Session error"
  if ("data" in error && error.data && typeof error.data === "object" && "message" in error.data) {
    return String(error.data.message)
  }
  return error.name
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "data" in error) {
    const data = error.data
    if (data && typeof data === "object" && "message" in data && typeof data.message === "string") return data.message
  }
  return String(error)
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function localID(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;"
    if (char === "<") return "&lt;"
    if (char === ">") return "&gt;"
    if (char === '"') return "&quot;"
    return "&#39;"
  })
}

sendButton?.addEventListener("click", () => {
  void sendPrompt()
})

promptInput?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey) return
  event.preventDefault()
  void sendPrompt()
})

modelButton?.addEventListener("click", (event) => {
  event.stopPropagation()
  toggleModelMenu()
})
variantButton?.addEventListener("click", cycleVariant)
document.addEventListener("click", (event) => {
  if (!modelMenu || modelMenu.hidden) return
  const target = event.target
  if (target instanceof Node && (modelMenu.contains(target) || modelButton?.contains(target))) return
  modelMenu.hidden = true
})

await renderServerStatus()
updateComposerState()
window.customOpenCode.onServerUpdated(() => {
  void renderServerStatus()
})
