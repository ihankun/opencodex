/**
 * Reads provider credentials that the local opencode runtime persisted to auth.json.
 * The sidecar points XDG_DATA_HOME at <userData>/data, so the file lives beside the
 * local runtime's data directory. Only api/wellknown entries expose a stable key;
 * oauth access tokens rotate and are intentionally not returned.
 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"

export async function readProviderAuthKey(userDataPath: string, providerID: string): Promise<string | undefined> {
  if (typeof providerID !== "string" || !providerID.trim() || providerID.length > 200) return
  const auth = await readAuth(join(userDataPath, "data", "opencode", "auth.json"))
  const entry = record(auth[providerID.replace(/\/+$/, "")])
  if (entry.type === "api") return text(entry.key)
  if (entry.type === "wellknown") return text(entry.token)
  return
}

function readAuth(path: string): Promise<Record<string, unknown>> {
  return readFile(path, "utf8")
    .then(content => record(JSON.parse(content) as unknown))
    .catch(() => ({}))
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown) {
  return typeof value === "string" && value ? value : undefined
}
