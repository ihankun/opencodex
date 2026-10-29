import { $ } from "bun"
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { AppArchive } from "../../cli/src/app-archive"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const cacheDir = join(__dirname, "..", ".models-cache")
const cacheFile = join(cacheDir, "api.json")

const cliDir = join(__dirname, "..", "..", "cli")
const cliPkg = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")) as { version: string }
const targetName = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
const binaryName = process.platform === "win32" ? "opencode2-node.exe" : "opencode2-node"
const builtBinary = join(cliDir, "dist", "node", `cli-node-${targetName}`, "bin", binaryName)
const outputBinary = join(__dirname, "..", ".server", process.platform === "win32" ? "opencode-server.exe" : "opencode-server")

const isBuild = process.env.npm_lifecycle_event?.includes("build") ?? false

// 服务端二进制是否新鲜：只有 CLI 及其内联的 workspace 包都比产物旧时才跳过构建。
// 每次 `electron:dev` 的 predev 都会跑本脚本，命中缓存可跳过整包重构建。
function serverBinaryUpToDate(): boolean {
  if (!existsSync(outputBinary) || !existsSync(builtBinary)) return false
  const binaryTime = statSync(outputBinary).mtimeMs
  const isNewer = (candidate: string) => existsSync(candidate) && statSync(candidate).mtimeMs > binaryTime

  for (const pkg of ["cli", "core", "server", "protocol", "schema", "util", "plugin", "client", "session-ui", "theme"]) {
    const dir = join(cliDir, "..", pkg)
    for (const sub of ["src", "script"]) {
      const candidate = join(dir, sub)
      if (!existsSync(candidate)) continue
      for (const entry of readdirSync(candidate, { recursive: true })) {
        try {
          if (isNewer(join(candidate, String(entry)))) return false
        } catch {
          // 忽略无法 stat 的条目（如损坏的符号链接）
        }
      }
    }
    if (isNewer(join(dir, "package.json"))) return false
  }
  for (const candidate of [join(cliDir, "package.json"), join(cliDir, "vite.node.config.ts"), join(__dirname, "..", "..", "..", "bun.lock")]) {
    if (isNewer(candidate)) return false
  }
  return true
}

async function resolveModelsJson(): Promise<string | undefined> {
  if (isBuild) {
    try {
      const res = await fetch("https://models.dev/api.json")
      if (res.ok) {
        mkdirSync(cacheDir, { recursive: true })
        writeFileSync(cacheFile, await res.text())
        return cacheFile
      }
    } catch {}
  } else {
    if (existsSync(cacheFile)) return cacheFile
    try {
      const res = await fetch("https://models.dev/api.json")
      if (res.ok) {
        mkdirSync(cacheDir, { recursive: true })
        writeFileSync(cacheFile, await res.text())
        return cacheFile
      }
    } catch {}
  }
  return existsSync(cacheFile) ? cacheFile : undefined
}

const modelsJson = await resolveModelsJson()
if (modelsJson) process.env.OPENCODE_MODELS_PATH = modelsJson

const forceServerBuild = process.env.OPENCODEX_FORCE_SERVER_BUILD === "1"
if (!forceServerBuild && serverBinaryUpToDate()) {
  console.log("build-server: skip (server binary is up to date)")
} else {
  // V2 用 packages/cli 的 node SEA 构建服务端二进制；Electron 只是启动它。
  // --single 只构建当前平台，避免下载其它平台的 Node；--skip-install 复用根目录已安装的依赖。
  // Electron 关闭了内嵌 Web UI，所以传一个空 app archive 跳过 packages/app 的前端构建。
  const emptyArchive = join(__dirname, "..", ".server", "empty-app-archive")
  mkdirSync(dirname(emptyArchive), { recursive: true })
  writeFileSync(emptyArchive, AppArchive.encode([]))
  process.env.OPENCODE_APP_ARCHIVE = emptyArchive
  await $`cd ${cliDir} && OPENCODE_CHANNEL=opencodex OPENCODE_VERSION=${cliPkg.version} OPENCODE_APP_ARCHIVE=${emptyArchive} ${process.execPath} script/build-node.ts --single --skip-install`
  if (!existsSync(builtBinary)) throw new Error(`build-server: missing ${builtBinary}`)
  mkdirSync(join(__dirname, "..", ".server"), { recursive: true })
  copyFileSync(builtBinary, outputBinary)
  if (process.platform !== "win32") chmodSync(outputBinary, 0o755)
  console.log(`build-server: wrote ${outputBinary}`)
}
