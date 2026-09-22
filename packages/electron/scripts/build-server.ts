import { $ } from "bun"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const cacheDir = join(__dirname, "..", ".models-cache")
const cacheFile = join(cacheDir, "api.json")

const opencodeDir = join(__dirname, "..", "..", "opencode")
const opencodePkg = JSON.parse(readFileSync(join(opencodeDir, "package.json"), "utf8")) as Record<
  string,
  Record<string, string>
> & { version: string }
const testFixture = join(opencodeDir, "test", "tool", "fixtures", "models-api.json")
const serverDistFile = join(opencodeDir, "dist", "node", "node.js")

const isBuild = process.env.npm_lifecycle_event?.includes("build") ?? false

// 服务端 bundle 产物是否新鲜：dist/node/node.js 比 opencode 源码、其 workspace
// 依赖（bundle 内联了 core/protocol/schema 等）和关键配置都新时才认为新鲜。
// 每次 `electron:dev` 的 predev 都会跑本脚本，缓存后可跳过整包重构建（约数十秒）。
function serverDistUpToDate(): boolean {
  if (!existsSync(serverDistFile)) return false
  const distTime = statSync(serverDistFile).mtimeMs
  const isNewer = (candidate: string) => existsSync(candidate) && statSync(candidate).mtimeMs > distTime

  // opencode 自身 + 被内联进单文件 bundle 的 @opencode-ai/* workspace 依赖
  const scanDirs: string[] = []
  if (existsSync(join(opencodeDir, "src"))) scanDirs.push(join(opencodeDir, "src"))
  if (existsSync(join(opencodeDir, "script"))) scanDirs.push(join(opencodeDir, "script"))
  if (existsSync(join(opencodeDir, "test"))) scanDirs.push(join(opencodeDir, "test"))
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const name of Object.keys(opencodePkg[section] ?? {})) {
      if (!name.startsWith("@opencode-ai/")) continue
      // workspace 目录名不带 scope 前缀：@opencode-ai/core → packages/core
      const dirName = name.slice("@opencode-ai/".length)
      for (const sub of ["src", "test"]) {
        const candidate = join(opencodeDir, "..", dirName, sub)
        if (existsSync(candidate)) scanDirs.push(candidate)
      }
    }
  }

  for (const dirPath of scanDirs) {
    for (const entry of readdirSync(dirPath, { recursive: true })) {
      const full = join(dirPath, String(entry))
      try {
        if (isNewer(full)) return false
      } catch {
        // 忽略无法 stat 的条目（如损坏的符号链接）
      }
    }
  }
  for (const candidate of [
    join(opencodeDir, "package.json"),
    join(opencodeDir, "tsconfig.json"),
    join(opencodeDir, "bunfig.toml"),
    join(__dirname, "..", "..", "..", "bun.lock"),
  ]) {
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

  if (existsSync(testFixture)) return testFixture
  return undefined
}

const modelsJson = await resolveModelsJson()
if (modelsJson) process.env.MODELS_DEV_API_JSON = modelsJson

// 源码未变时跳过整包重构建；设 OPENCODEX_FORCE_SERVER_BUILD=1 可强制
const forceServerBuild = process.env.OPENCODEX_FORCE_SERVER_BUILD === "1"
if (!forceServerBuild && serverDistUpToDate()) {
  console.log("build-server: skip (dist/node/node.js is up to date)")
} else {
  // 注入真实语义化版本：opencode 服务端会用它构造 User-Agent（如 opencode/1.18.31）。
  // 只传 OPENCODE_CHANNEL=opencodex 会让版本退化为 0.0.0-opencodex-<时间戳>，从而被
  // Console 免费额度接口以“OpenCode 1.18.0 or newer is required”拒绝。
  await $`cd ../opencode && OPENCODE_CHANNEL=opencodex OPENCODE_VERSION=${opencodePkg.version} bun script/build-node.ts`
}
