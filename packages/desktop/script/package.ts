#!/usr/bin/env bun

// Local installer builds use the prod identity (OpenCodex, black-and-white icon) unless the caller
// picks a channel. The build and pack steps read the channel from the environment when they load.
process.env.OPENCODE_CHANNEL ??= "prod"

process.argv.push("--installer")

await import("./build")

await import("./pack")
