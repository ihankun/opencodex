import { $ } from "bun"
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const cacheDir = join(__dirname, "..", ".models-cache")
const cacheFile = join(cacheDir, "api.json")

const cliDir = join(__dirname, "..", "..", "cli")
const cliPkg = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")) as { version: string }
const targetName = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
const binaryName = process.platform === "win32" ? "opencode.exe" : "opencode"
// scripts/build.ts names its output after the artifact: opencode-windows-x64 -> cli-windows-x64.
const builtBinary = join(cliDir, "dist", `cli-${targetName}`, "bin", binaryName)
const outputBinary = join(__dirname, "..", ".server", process.platform === "win32" ? "opencode-server.exe" : "opencode-server")
const buildKind = "bun"
const buildKindFile = join(__dirname, "..", ".server", "kind")

const isBuild = process.env.npm_lifecycle_event?.includes("build") ?? false

// 服务端二进制是否新鲜：只有 CLI 及其内联的 workspace 包都比产物旧时才跳过构建。
// 每次 `electron:dev` 的 predev 都会跑本脚本，命中缓存可跳过整包重构建。
function serverBinaryUpToDate(): boolean {
  if (!existsSync(outputBinary) || !existsSync(builtBinary)) return false
  // Rebuild once when the compile method changes; a Node SEA binary is not interchangeable with
  // the Bun build even though both report the same CLI version.
  if (!existsSync(buildKindFile) || readFileSync(buildKindFile, "utf8").trim() !== buildKind) return false
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
  // Build the CLI exactly like the official desktop bundle: the Bun compile from script/build.ts.
  // The Node SEA output (script/build-node.ts) is rejected by the inference free tier even with the
  // same version and client identity, so keep this on the official runtime.
  // --single only builds this platform; --skip-install reuses the root install; --skip-web-ui
  // embeds an empty app archive because the Electron app disables the embedded web UI.
  await $`cd ${cliDir} && OPENCODE_CHANNEL=local OPENCODE_VERSION=${cliPkg.version} ${process.execPath} script/build.ts --single --skip-install --skip-web-ui`
  if (!existsSync(builtBinary)) throw new Error(`build-server: missing ${builtBinary}`)
  mkdirSync(join(__dirname, "..", ".server"), { recursive: true })
  copyFileSync(builtBinary, outputBinary)
  writeFileSync(buildKindFile, `${buildKind}\n`)
  if (process.platform !== "win32") chmodSync(outputBinary, 0o755)
  console.log(`build-server: wrote ${outputBinary}`)
}

// `Service.ensure` only adopts a registered service whose version matches. Ship the version next
// to the binary so the main process can enforce that without importing the CLI package.
writeFileSync(join(__dirname, "..", ".server", "version"), `${cliPkg.version}\n`)
