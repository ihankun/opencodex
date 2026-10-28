import type { Session } from "@opencode/client"

export type CachedSessionList = {
  directory: string
  sessions: Session[]
  updatedAt: number
}

export type SessionListCacheServer = {
  lastDirectory?: string
  directories: Record<string, CachedSessionList>
}

export type SessionListCacheFile = {
  version: 1
  servers: Record<string, SessionListCacheServer>
}

export function normalizeCachedSessionList(value: unknown, directory?: string): CachedSessionList | undefined {
  if (!isRecord(value)) return
  const normalizedDirectory =
    typeof value.directory === "string" && value.directory ? value.directory : directory
  if (!normalizedDirectory) return

  return {
    directory: normalizedDirectory,
    sessions: Array.isArray(value.sessions)
      ? value.sessions.flatMap((session): Session[] => {
          if (!isRecord(session) || !isRecord(session.time)) return []
          if (
            typeof session.id !== "string" ||
            typeof session.slug !== "string" ||
            typeof session.projectID !== "string" ||
            typeof session.directory !== "string" ||
            typeof session.title !== "string" ||
            typeof session.version !== "string" ||
            typeof session.time.created !== "number" ||
            typeof session.time.updated !== "number"
          )
            return []
          return [session as Session]
        }).slice(0, 30)
      : [],
    updatedAt:
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : 0,
  }
}

export function normalizeSessionListCacheFile(value: unknown): SessionListCacheFile {
  if (!isRecord(value) || !isRecord(value.servers)) return { version: 1, servers: {} }

  return {
    version: 1,
    servers: Object.fromEntries(
      Object.entries(value.servers).flatMap(([serverId, server]): Array<[string, SessionListCacheServer]> => {
        if (!serverId || !isRecord(server) || !isRecord(server.directories)) return []
        const directories = Object.fromEntries(
          Object.entries(server.directories).flatMap(([directory, sessions]) => {
            const normalized = normalizeCachedSessionList(sessions, directory)
            return normalized ? [[directory, normalized]] : []
          }),
        )
        const lastDirectory =
          typeof server.lastDirectory === "string" && directories[server.lastDirectory]
            ? server.lastDirectory
            : Object.values(directories).toSorted((left, right) => right.updatedAt - left.updatedAt)[0]?.directory
        return [[serverId, { lastDirectory, directories }]]
      }),
    ),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
