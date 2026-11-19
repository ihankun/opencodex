#!/usr/bin/env bun
import { $ } from "bun"
import { exists } from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { copyBuiltCliToResources, downloadCliToResources, getCurrentCli, resolveChannel } from "./utils"
import { verifyBundles } from "./verify-bundles"

// Prepares resources/ (icons, metainfo, the bundled CLI) for OPENCODE_CHANNEL and builds the app into out/.
// The CLI comes from ../cli/dist when it holds the target. A prod build whose version does not match the app is
// rebuilt first; otherwise dev downloads the published dev CLI, beta the beta CLI, and prod fails.
const dir = path.resolve(import.meta.dir, "..")

const cli = path.resolve(dir, "../cli/dist")

const channel = resolveChannel()

process.chdir(dir)

await $`bun ./script/copy-icons.ts ${channel}`

await $`bun ./script/copy-metainfo.ts ${channel}`

const currentCli = getCurrentCli()

const built = await exists(path.join(cli, currentCli.package.replace("@opencode/", "")))

if (channel === "prod" && !built)
  throw new Error(`Production desktop builds bundle the CLI from ${cli}; build it first`)

if (built) {
  await ensureBuiltCliVersion(currentCli)
  await copyBuiltCliToResources(cli)
}

if (!built) await downloadCliToResources(channel === "beta" ? "beta" : undefined)

await $`bunx electron-vite build`

await verifyBundles(path.join(dir, "out"))

async function manifestVersion(file: string) {
  const manifest = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ version: Schema.NonEmptyString })))(
      await Bun.file(file).text(),
    ),
  )

  if (manifest === undefined) throw new Error(`Package manifest has no version: ${file}`)

  return manifest.version
}

async function ensureBuiltCliVersion(target: ReturnType<typeof getCurrentCli>) {
  if (channel !== "prod") return

  const directory = path.join(cli, target.package.replace("@opencode/", ""))
  const built = await manifestVersion(path.join(directory, "package.json"))
  const appVersion = process.env.OPENCODE_VERSION ?? (await manifestVersion(path.join(dir, "package.json")))
  // The bundled CLI reports the upstream base version. The fork's `-ocx.N` suffix is desktop-only, and
  // leaking it into the CLI makes the CLI updater treat the same upstream release as newer.
  const expected = appVersion.split(/[-+]/, 1)[0]

  if (built === expected) return

  // A stale build may also come from another channel: a local-channel CLI registers service-local.json,
  // which the desktop never reads, so every launch waits out the background service timeout instead.
  const cliTarget = target.package.replace("@opencode/cli-", "")

  console.log(`Bundled CLI is ${built}, expected ${expected}; rebuilding ${cliTarget}`)
  await $`bun run --cwd ${path.resolve(dir, "../cli")} build`.env({
    ...process.env,
    OPENCODE_CHANNEL: "latest",
    OPENCODE_VERSION: expected,
    OPENCODE_TARGET: cliTarget,
  })

  const rebuilt = await manifestVersion(path.join(directory, "package.json"))

  if (rebuilt !== expected) throw new Error(`Rebuilt CLI is ${rebuilt}, expected ${expected}: ${directory}`)
}
