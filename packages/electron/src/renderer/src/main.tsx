import { StrictMode, Suspense } from "react"
import { createRoot } from "react-dom/client"
import "katex/dist/katex.min.css"
import "./index.css"
import "./i18n"
import appIcon from "../../../assets/opencode-icon.png"
import { initOverlayScrollbars } from "./lib/overlayScrollbar"
import App from "./App"
import { DirectoryProvider, FullscreenProvider, SessionProvider } from "./contexts"
import { themeStore } from "./store/themeStore"
import { serverStore } from "./store/serverStore"
import { messageStore } from "./store/messageStore"
import { childSessionStore } from "./store/childSessionStore"
import { todoStore } from "./store/todoStore"
import { autoApproveStore } from "./store/autoApproveStore"
import { reconnectSSE } from "./api/events"
import { abortInFlightApiRequests, invalidateSDKClient } from "./api/sdk"
import { resetPathModeCache } from "./utils/directoryUtils"
import { getDesktopPlatform } from "./utils/platform"
import { globalErrorHandler } from "./utils/errorHandling"
import { applyLocalServiceUrl } from "./utils/localServiceUrl"
import { initializeModels } from "./hooks/useModels"
import { ErrorBoundary } from "./components/ErrorBoundary"
import { accessibilityStore } from "./store/accessibilityStore"

// Polyfill: randomUUID 在非 HTTPS 环境可能缺失（如局域网 HTTP）
// 统一补齐，避免业务层 scattered fallback。
function ensureRandomUUID() {
  const cryptoObj = globalThis.crypto as Crypto & { randomUUID?: () => string }
  if (!cryptoObj || typeof cryptoObj.getRandomValues !== "function") return
  if (typeof cryptoObj.randomUUID === "function") return

  cryptoObj.randomUUID = () => {
    const bytes = new Uint8Array(16)
    cryptoObj.getRandomValues(bytes)
    // RFC 4122 v4
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80

    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`
  }
}

ensureRandomUUID()

// 禁用浏览器的 scroll restoration（刷新时不恢复旧 scrollTop），
// 由 ChatArea 自行控制定位
if ("scrollRestoration" in history) {
  history.scrollRestoration = "manual"
}

// 初始化主题系统（在 React 渲染前注入 CSS 变量，避免闪烁）
themeStore.init()
accessibilityStore.init()

// 全局 overlay 滚动条 — 等 DOM 就绪后启动
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initOverlayScrollbars)
} else {
  // DOM 已就绪（defer script 或者 module）
  requestAnimationFrame(initOverlayScrollbars)
}

// 注册 active server 入口变化 → 只中止受影响服务器请求，并保留其他服务器的客户端缓存
serverStore.onServerChange((serverId, reason) => {
  // 切换服务器：把该服务器上次使用的目录恢复进 URL，然后整体刷新，
  // 确保会话列表、供应商信息等全部按新服务器重新加载
  if (reason === "server-switch") {
    void (async () => {
      if (typeof window.customOpenCode?.cachedSessions === "function") {
        const cached = await window.customOpenCode.cachedSessions(serverId).catch(() => undefined)
        if (cached?.directory && serverStore.getActiveServerId() === serverId) {
          const encoded = encodeURIComponent(cached.directory)
          const sessionMatch = window.location.hash.match(/^#\/session\/([^?]*)/)
          window.location.hash = sessionMatch ? `#/session/${sessionMatch[1]}?dir=${encoded}` : `#/?dir=${encoded}`
        }
      }
      window.location.reload()
    })()
    return
  }

  abortInFlightApiRequests("Server endpoint changed", serverId)
  invalidateSDKClient(serverId)

  // 仅凭据变化（例如 sidecar 重启后的新密码）不改变服务器数据，
  // 保留会话和消息，只重连即可，避免界面被清空。
  if (reason === "credential-change") {
    reconnectSSE()
    return
  }

  // 1. 清空内存中的 session/消息数据
  messageStore.clearAll()
  childSessionStore.clearAll()
  todoStore.clearAll()

  // 2. 重置路径模式缓存（不同服务器可能是不同操作系统）
  resetPathModeCache()

  // 4. 重新加载 auto-approve 开关状态（从新服务器的 storage key 读取）
  autoApproveStore.reloadFromStorage()

  // 5. 重连 SSE（会自动连到新的 server endpoint）
  reconnectSSE()
})

function configureNativeShell() {
  if ("customOpenCode" in window) {
    document.documentElement.classList.add("electron-app")
    const platform = getDesktopPlatform()
    document.documentElement.setAttribute("data-platform", platform)
  }
}

async function initializeElectronService() {
  if (!window.customOpenCode) return

  let resolveReady: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  const applyServer = (state: Awaited<ReturnType<typeof window.customOpenCode.server>>) => {
    if (state.status !== "online") {
      // 启动或重启中：先保持 checking，服务器就绪后再更新地址与凭据。
      serverStore.setLocalServerStatus(state.error ? "failed" : "starting")
      if (state.error) resolveReady()
      return
    }
    serverStore.setLocalServerStatus("online")
    serverStore.updateServer("local", {
      auth: state.server.password
        ? {
            username: state.server.username,
            password: state.server.password,
          }
        : undefined,
    })
    applyLocalServiceUrl(state.server.url)
    // 只在使用本地服务器时才激活它，避免刷新后把用户切换到的远程服务器拉回本地
    if (serverStore.getActiveServerId() === "local") {
      serverStore.setActiveServer("local")
    }
    resolveReady()
  }

  window.customOpenCode.onServerUpdated(applyServer)
  applyServer(await window.customOpenCode.server())
  // 模型列表依赖已就绪的 sidecar；等第一次在线（或启动失败）后再拉取，
  // 避免启动阶段把 transport 错误写进模型状态。
  await ready
}

configureNativeShell()

// 全局错误处理 - 防止未捕获错误导致页面刷新
window.addEventListener("error", (event) => {
  globalErrorHandler("uncaught error", event.error)
  event.preventDefault()
})

window.addEventListener("unhandledrejection", (event) => {
  globalErrorHandler("unhandled promise rejection", event.reason)
  event.preventDefault()
})

function bootstrap() {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary root>
        <Suspense fallback={<StartupFallback />}>
          <DirectoryProvider>
            <SessionProvider>
              <FullscreenProvider>
                <App />
              </FullscreenProvider>
            </SessionProvider>
          </DirectoryProvider>
        </Suspense>
      </ErrorBoundary>
    </StrictMode>,
  )
}

function StartupFallback() {
  return (
    <div className="startup-screen" role="status" aria-live="polite" aria-label="正在启动 OpenCodex">
      <div className="startup-ambient-light" aria-hidden="true" />
      <div className="startup-glass-panel">
        <div className="startup-logo-wrap">
          <span className="startup-logo-halo" aria-hidden="true" />
          <img className="startup-logo" src={appIcon} alt="" />
        </div>
        <div className="startup-title">正在启动 OpenCodex</div>
        <div className="startup-progress" aria-hidden="true">
          <span />
        </div>
      </div>
    </div>
  )
}

async function startApp() {
  const electronService = initializeElectronService()

  bootstrap()

  await electronService
  void initializeModels()
}

void startApp()
