#!/usr/bin/env bun
import { $ } from "bun"
import { cp, mkdir, readdir, rm } from "node:fs/promises"
import path from "node:path"
import { getConfig } from "../electron-builder.config"
import { getCurrentCli, resolveChannel } from "./utils"

// Packages the built app (out/) for OPENCODE_TARGET into dist/desktop at the repository root:
// --installer builds the platform installer (NSIS on Windows, dmg and zip on macOS, AppImage/deb/rpm on Linux).
// Without it, the unsigned app is packed for the release workflow to sign: the .app as a tarball on macOS, the
// unpacked app on Windows (or the NSIS installer around a signed app with OPENCODE_DESKTOP_APP), and the Linux
// packages. The release workflow signs afterwards.
const dir = path.resolve(import.meta.dir, "..")

const out = path.resolve(dir, "../../dist/desktop")

const cli = getCurrentCli()

const os =
  new Map([
    ["darwin", "mac"],
    ["win32", "win"],
  ]).get(cli.os) ?? "linux"

const app = process.env.OPENCODE_DESKTOP_APP

const installer = process.argv.includes("--installer")

const flags = [`--${os}`, `--${cli.cpu}`, "--publish", "never", "--config", "electron-builder.config.ts"]

process.chdir(dir)

await rm("dist", { recursive: true, force: true })

await rm(out, { recursive: true, force: true })

await mkdir(out, { recursive: true })

if (app) {
  // The installer uses the channel's icons; the rest of the app is already built and signed.
  await $`bun ./script/copy-icons.ts ${resolveChannel()}`
  await $`bunx electron-builder ${flags} --prepackaged ${app}`
  await cp(`dist/opencodex-win-${cli.cpu}.exe`, path.join(out, `opencodex-win-${cli.cpu}.exe`))
}

if (!app && installer) {
  // electron-builder writes the installer and its update metadata (latest*.yml and blockmaps) from out/.
  await $`bunx electron-builder ${os === "mac" ? [...flags, "-c.mac.identity=null"] : flags}`

  const files = (await readdir("dist")).filter((file) =>
    /\.(exe|dmg|zip|AppImage|deb|rpm|blockmap)$/.test(file) || /^latest(-mac|-linux)?\.yml$/.test(file),
  )

  await Promise.all(files.map((file) => cp(path.join("dist", file), path.join(out, file))))
}

if (!app && !installer && os === "linux") {
  await $`bunx electron-builder ${flags}`
  const files = (await readdir("dist")).filter((file) => /\.(AppImage|deb|rpm)$/.test(file))
  await Promise.all(files.map((file) => cp(path.join("dist", file), path.join(out, file))))
}

if (!app && !installer && os === "mac") {
  await $`bunx electron-builder ${flags} --dir -c.mac.identity=null`
  const parent = path.join("dist", cli.cpu === "arm64" ? "mac-arm64" : "mac")
  const bundles = (await readdir(parent)).filter((file) => file.endsWith(".app"))

  if (bundles.length !== 1) throw new Error(`Expected one .app bundle in ${parent}, found ${bundles.join(", ")}`)
  await writeUpdateConfig(path.join(parent, bundles[0], "Contents", "Resources"))
  await $`tar -cf ${path.join(out, `opencodex-mac-${cli.cpu}.app.tar`)} -C ${parent} ${bundles[0]}`
}

if (!app && !installer && os === "win") {
  await $`bunx electron-builder ${flags} --dir`
  const unpacked = path.join("dist", cli.cpu === "arm64" ? "win-arm64-unpacked" : "win-unpacked")
  await writeUpdateConfig(path.join(unpacked, "resources"))
  await cp(unpacked, path.join(out, "app"), { recursive: true })
}

// electron-builder writes resources/app-update.yml only for dmg, zip and nsis targets, not for --dir builds.
// electron-updater reads its feed from that file, so write the one those targets would.
async function writeUpdateConfig(resources: string) {
  const config = getConfig()
  const publish = config.publish

  if (Array.isArray(publish) || publish?.provider !== "github")
    throw new Error("Desktop packaging requires a GitHub release feed")

  // Match the updaterCacheDirName electron-builder writes for installer targets.
  const name: string = (await Bun.file("package.json").json()).name

  await Bun.write(
    path.join(resources, "app-update.yml"),
    [
      "provider: github",
      `owner: ${publish.owner}`,
      `repo: ${publish.repo}`,
      `channel: ${publish.channel ?? "latest"}`,
      `updaterCacheDirName: '${name.replace(/[/\\:*?"<>|]/g, "").toLowerCase()}-updater'`,
    ].join("\n") + "\n",
  )
}
