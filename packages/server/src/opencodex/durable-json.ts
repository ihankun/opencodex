import { Flock } from "@opencode/util/flock"
import path from "node:path"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"

export async function read<T>(file: string, fallback: T): Promise<T> {
  for (const candidate of [file, backup(file)]) {
    const value = await readFile(candidate, "utf8")
      .then((text) => JSON.parse(text) as T)
      .catch(() => undefined)
    if (value !== undefined) return value
  }
  return fallback
}

export async function write<T>(file: string, value: T) {
  return Flock.withLock(`durable-json:${file}`, () => writeUnlocked(file, value))
}

export async function update<T, R>(
  file: string,
  fallback: T,
  change: (value: T) => Promise<{ value: T; result: R }> | { value: T; result: R },
) {
  return Flock.withLock(`durable-json:${file}`, async () => {
    const next = await change(await read(file, fallback))
    await writeUnlocked(file, next.value)
    return next.result
  })
}

async function writeUnlocked<T>(file: string, value: T) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const current = await readFile(file, "utf8").catch(() => undefined)
  if (current !== undefined && isJson(current)) await writeFile(backup(file), current)

  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
  await chmod(temporary, 0o600).catch(() => undefined)
  await rename(temporary, file).catch(async (error) => {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  })
  await chmod(file, 0o600).catch(() => undefined)
}

function backup(file: string) {
  return `${file}.bak`
}

function isJson(value: string) {
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

export * as DurableJson from "./durable-json"
