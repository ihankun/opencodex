export * as SkillMarketplace from "./marketplace.js"

import path from "path"
import { createHash } from "node:crypto"
import { lstat } from "node:fs/promises"
import extract from "extract-zip"
import { Context, Effect, Layer, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { SkillMarketplace as Marketplace } from "@opencode/schema/skill-marketplace"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Location } from "../location.js"

const officialUrl = (process.env.SKILLHUB_URL ?? "https://skills.palebluedot.live").replace(/\/+$/, "")
const neteaseUrl = "https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/skill-store"
const manifestFile = ".opencodex-marketplace.json"
const maxArchiveBytes = 20 * 1024 * 1024
const maxFileBytes = 1024 * 1024
const maxTotalBytes = 5 * 1024 * 1024

const RemoteSearch = Schema.Struct({
  skills: Schema.Array(Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    description: Schema.NullOr(Schema.String),
    githubOwner: Schema.String,
    githubRepo: Schema.String,
    githubStars: Schema.Number,
    downloadCount: Schema.Number,
    isVerified: Schema.Boolean,
    securityScore: Schema.NullOr(Schema.Number),
    securityStatus: Schema.NullOr(Schema.String),
    aiScore: Schema.NullOr(Schema.Number),
    reviewStatus: Schema.NullOr(Schema.String),
  })),
  pagination: Schema.Struct({
    page: Schema.Number,
    limit: Schema.Number,
    total: Schema.Number,
  }),
})

const RemoteDetail = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  githubOwner: Schema.String,
  githubRepo: Schema.String,
  githubStars: Schema.Number,
  downloadCount: Schema.Number,
  isVerified: Schema.Boolean,
  isFeatured: Schema.Boolean,
  securityScore: Schema.NullOr(Schema.Number),
  securityStatus: Schema.NullOr(Schema.String),
  qualityScore: Schema.NullOr(Schema.Number),
  aiScore: Schema.NullOr(Schema.Number),
  reviewStatus: Schema.NullOr(Schema.String),
  license: Schema.NullOr(Schema.String),
  isMalicious: Schema.optional(Schema.Boolean),
  isBlocked: Schema.optional(Schema.Boolean),
})

const RemoteFiles = Schema.Struct({
  skillId: Schema.String,
  files: Schema.Array(Schema.Struct({
    path: Schema.String,
    type: Schema.String,
    content: Schema.NullOr(Schema.String),
  })),
})

const NetEaseEnvelope = Schema.Struct({
  data: Schema.Struct({ value: Schema.Unknown }),
})

type NetEaseSkill = {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly version: string | null
  readonly archive: string
  readonly source: string
  readonly sourceUrl: string
  readonly tags: string[]
}

export class Error extends Schema.TaggedError<Error>()("SkillMarketplace.Error", {
  message: Schema.String,
  conflict: Schema.optional(Schema.Boolean),
}) {}

export interface Interface {
  readonly search: (input: {
    query: string
    provider: Marketplace.Provider
    sort: Marketplace.Sort
    category?: string
    limit: number
    page: number
  }) => Effect.Effect<typeof Marketplace.Page.Type, Error>
  readonly detail: (id: string, provider: Marketplace.Provider) => Effect.Effect<typeof Marketplace.Detail.Type, Error>
  readonly installed: () => Effect.Effect<Marketplace.Installation[], Error>
  readonly install: (input: Marketplace.InstallInput) => Effect.Effect<Marketplace.Installation, Error>
  readonly remove: (input: Marketplace.RemoveInput) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillMarketplace") {}

export function safePath(value: string) {
  const parts = value.split("/")
  return (
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    parts.every((part) => part.length > 0 && part !== "." && part !== "..")
  )
}

export function hash(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.retryTransient({
        retryOn: "errors-and-responses",
        times: 2,
        schedule: Schedule.exponential(200).pipe(Schedule.jittered),
      }),
      HttpClient.filterStatusOk,
    )
    let neteaseCache: { expires: number; data: NetEaseSkill[] } | undefined

    const execute = <S extends Schema.Top>(url: string, schema: S, provider: string) =>
      HttpClientRequest.get(url).pipe(
        HttpClientRequest.acceptJson,
        http.execute,
        Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
        Effect.mapError((cause) => new Error({ message: `${provider} request failed: ${String(cause)}` })),
      )

    const netease = Effect.fn("SkillMarketplace.neteaseCatalog")(function* () {
      if (neteaseCache && neteaseCache.expires > Date.now()) return neteaseCache.data
      const response = yield* execute(neteaseUrl, NetEaseEnvelope, "NetEase skill marketplace")
      const value = typeof response.data.value === "string"
        ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(response.data.value).pipe(
            Effect.mapError((cause) => new Error({ message: `NetEase skill marketplace returned invalid JSON: ${String(cause)}` })),
          )
        : response.data.value
      const root = asRecord(value)
      const entries = Array.isArray(root?.marketplace) ? root.marketplace : []
      const skills = entries.flatMap((entry): NetEaseSkill[] => {
        const info = asRecord(entry)
        if (!info) return []
        const id = string(info.id)
        const name = string(info.name)
        const archive = string(info.url)
        if (!id || !name || !archive || !/^https:\/\//.test(archive)) return []
        const origin = asRecord(info.source)
        const tags = Array.isArray(info.tags) ? info.tags.filter((tag): tag is string => typeof tag === "string") : []
        return [{
          id,
          name,
          description: localized(info.description) || name,
          version: string(info.version) || null,
          archive,
          source: string(origin?.author) || string(origin?.from) || "NetEase Youdao",
          sourceUrl: string(origin?.url) || archive,
          tags,
        }]
      })
      neteaseCache = { expires: Date.now() + 5 * 60_000, data: skills }
      return skills
    })

    const officialDetail = Effect.fn("SkillMarketplace.officialDetail")(function* (id: string) {
      const encoded = id.split("/").map(encodeURIComponent).join("/")
      const [info, snapshot] = yield* Effect.all([
        execute(`${officialUrl}/api/skills/${encoded}`, RemoteDetail, "SkillHub"),
        execute(`${officialUrl}/api/skill-files?id=${encodeURIComponent(id)}`, RemoteFiles, "SkillHub"),
      ], { concurrency: 2 })
      if (info.isMalicious || info.isBlocked) return yield* new Error({ message: "SkillHub has blocked this skill" })
      const files = snapshot.files.flatMap((file) =>
        file.type === "file" && file.content !== null ? [{ path: file.path, contents: file.content }] : [],
      )
      if (files.length === 0) return yield* new Error({ message: "This skill does not have an installable file snapshot" })
      return {
        id: info.id,
        provider: "official" as const,
        source: `${info.githubOwner}/${info.githubRepo}`,
        slug: info.name,
        version: null,
        category: null,
        tags: [],
        icon: null,
        hash: snapshotHash(files),
        files,
        githubStars: info.githubStars,
        downloadCount: info.downloadCount,
        isVerified: info.isVerified,
        isFeatured: info.isFeatured,
        securityScore: info.securityScore,
        securityStatus: info.securityStatus,
        qualityScore: info.qualityScore,
        aiScore: info.aiScore,
        reviewStatus: info.reviewStatus,
        license: info.license,
      }
    })

    const neteaseDetail = Effect.fn("SkillMarketplace.neteaseDetail")(function* (id: string) {
      const info = (yield* netease()).find((item) => item.id === id)
      if (!info) return yield* new Error({ message: "Skill was not found in the NetEase marketplace" })
      const token = crypto.randomUUID()
      const temporary = path.join(global.tmp, `skill-${token}`)
      const archive = path.join(temporary, "skill.zip")
      const unpacked = path.join(temporary, "unpacked")
      const files = yield* Effect.gen(function* () {
        const bytes = yield* HttpClientRequest.get(info.archive).pipe(
          http.execute,
          Effect.flatMap((response) => response.arrayBuffer),
          Effect.mapError((cause) => new Error({ message: `Unable to download NetEase skill: ${String(cause)}` })),
        )
        if (bytes.byteLength === 0 || bytes.byteLength > maxArchiveBytes) {
          return yield* new Error({ message: "NetEase skill archive exceeds the download size limit" })
        }
        yield* fs.writeWithDirs(archive, new Uint8Array(bytes)).pipe(
          Effect.mapError((cause) => new Error({ message: `Unable to save NetEase skill: ${String(cause)}` })),
        )
        yield* fs.ensureDir(unpacked).pipe(Effect.mapError((cause) => new Error({ message: String(cause) })))
        let extractedBytes = 0
        yield* Effect.tryPromise({
          try: () => extract(archive, {
            dir: unpacked,
            onEntry: (entry) => {
              extractedBytes += entry.uncompressedSize
              if (entry.uncompressedSize > maxFileBytes || extractedBytes > maxTotalBytes) {
                throw new globalThis.Error("NetEase skill archive exceeds the extracted size limit")
              }
            },
          }),
          catch: (cause) => new Error({ message: `Unable to unpack NetEase skill: ${String(cause)}` }),
        })
        const all = yield* fs.scan("**/*", { cwd: unpacked, absolute: true, include: "all", dot: true }).pipe(
          Effect.mapError((cause) => new Error({ message: String(cause) })),
        )
        const unsafe = yield* Effect.forEach(all, (entry) => Effect.tryPromise({
          try: () => lstat(entry),
          catch: (cause) => new Error({ message: String(cause) }),
        }).pipe(Effect.map((stat) => !stat.isFile() && !stat.isDirectory())))
        if (unsafe.some(Boolean)) return yield* new Error({ message: "NetEase skill archive contains unsupported links or entries" })
        const skillFile = all
          .filter((entry) => path.basename(entry) === "SKILL.md")
          .toSorted((a, b) => a.split(path.sep).length - b.split(path.sep).length)[0]
        if (!skillFile) return yield* new Error({ message: "NetEase skill archive does not contain SKILL.md" })
        const root = path.dirname(skillFile)
        const paths = yield* fs.scan("**/*", { cwd: root, absolute: true, include: "file", dot: true }).pipe(
          Effect.mapError((cause) => new Error({ message: String(cause) })),
        )
        return yield* Effect.forEach(paths, (file) => fs.readFileString(file).pipe(
          Effect.map((contents) => ({ path: path.relative(root, file).split(path.sep).join("/"), contents })),
          Effect.mapError((cause) => new Error({ message: `Unable to read NetEase skill file: ${String(cause)}` })),
        ), { concurrency: 8 })
      }).pipe(Effect.ensuring(fs.remove(temporary, { recursive: true, force: true }).pipe(Effect.ignore)))
      return {
        id: info.id,
        provider: "netease" as const,
        source: info.source,
        slug: installSlug(info.id, info.name),
        version: info.version,
        category: info.tags[0] ?? null,
        tags: info.tags,
        icon: null,
        hash: snapshotHash(files),
        files,
        githubStars: 0,
        downloadCount: 0,
        isVerified: false,
        isFeatured: false,
        securityScore: null,
        securityStatus: null,
        qualityScore: null,
        aiScore: null,
        reviewStatus: null,
        license: null,
      }
    })

    const detail = Effect.fn("SkillMarketplace.detail")(function* (id: string, provider: Marketplace.Provider) {
      if (provider === "netease") return yield* neteaseDetail(id)
      return yield* officialDetail(id)
    })

    const root = (scope: Marketplace.Scope) =>
      scope === "global"
        ? path.join(global.home, ".opencodex", "skills")
        : path.join(location.directory, ".opencode", "skills")

    const directory = (scope: Marketplace.Scope, slug: string) => path.resolve(root(scope), slug)

    const manifest = Effect.fn("SkillMarketplace.manifest")(function* (dir: string) {
      const raw = yield* fs.readFileStringSafe(path.join(dir, manifestFile)).pipe(Effect.mapError((cause) => new Error({ message: String(cause) })))
      if (!raw) return undefined
      const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(raw).pipe(
        Effect.mapError((cause) => new Error({ message: `Invalid marketplace metadata: ${String(cause)}` })),
      )
      const legacy = asRecord(decoded)
      if (!legacy) return yield* new Error({ message: "Invalid marketplace metadata: expected an object" })
      return yield* Schema.decodeUnknownEffect(Marketplace.Manifest)({
        provider: "official",
        version: null,
        ...legacy,
      }).pipe(
        Effect.mapError((cause) => new Error({ message: `Invalid marketplace metadata: ${String(cause)}` })),
      )
    })

    const conflict = Effect.fn("SkillMarketplace.conflict")(function* (dir: string, info?: Marketplace.Manifest) {
      if (!info) return yield* fs.existsSafe(dir)
      if (Object.keys(info.files).some((file) => !safePath(file))) {
        return yield* new Error({ message: "Marketplace metadata contains an unsafe path" })
      }
      const files = yield* fs.scan("**/*", { cwd: dir, include: "file", dot: true }).pipe(
        Effect.mapError((cause) => new Error({ message: String(cause) })),
      )
      // Manifest keys are normalized to `/`; Windows scans come back with the platform separator.
      const normalized = files.map((file) => file.split(path.sep).join("/"))
      if (normalized.some((file) => file !== manifestFile && !(file in info.files))) return true
      const changed = yield* Effect.forEach(Object.entries(info.files), ([file, expected]) =>
        fs.readFileStringSafe(path.join(dir, file)).pipe(
          Effect.map((content) => content === undefined || hash(content) !== expected),
          Effect.mapError((cause) => new Error({ message: String(cause) })),
        ),
      )
      return changed.some(Boolean)
    })

    const installation = Effect.fn("SkillMarketplace.installation")(function* (
      info: Marketplace.Manifest,
      dir: string,
      remoteHash: string | null,
    ) {
      return {
        id: info.id,
        provider: info.provider,
        slug: info.slug,
        scope: info.scope,
        directory: dir,
        manifest: info,
        conflict: yield* conflict(dir, info),
        updateAvailable: remoteHash !== null && remoteHash !== info.hash,
      } satisfies Marketplace.Installation
    })

    const installed = Effect.fn("SkillMarketplace.installed")(function* () {
      const entries = yield* Effect.forEach(["global", "project"] as const, (scope) =>
        fs.scan(`*/${manifestFile}`, { cwd: root(scope), absolute: true, include: "file", dot: true }).pipe(
          Effect.catch(() => Effect.succeed([] as string[])),
          Effect.map((files) => files.map((file) => ({ scope, file }))),
        ),
      )
      return yield* Effect.forEach(entries.flat(), ({ file }) =>
        Effect.gen(function* () {
          const info = yield* manifest(path.dirname(file)).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!info) return undefined
          const remote = yield* detail(info.id, info.provider).pipe(Effect.catch(() => Effect.succeed(undefined)))
          return yield* installation(info, path.dirname(file), remote?.hash ?? info.hash)
        }),
        { concurrency: 4 },
      ).pipe(Effect.map((items) => items.filter((item): item is Marketplace.Installation => item !== undefined)))
    })

    const install = Effect.fn("SkillMarketplace.install")(function* (input: Marketplace.InstallInput) {
      const remote = yield* detail(input.id, input.provider)
      if (!remote.files.some((file) => file.path === "SKILL.md")) {
        return yield* new Error({ message: "Skill snapshot does not contain SKILL.md" })
      }
      if (remote.files.some((file) => !safePath(file.path))) {
        return yield* new Error({ message: "Skill snapshot contains an unsafe path" })
      }
      const sizes = remote.files.map((file) => Buffer.byteLength(file.contents))
      if (sizes.some((size) => size > maxFileBytes) || sizes.reduce((total, size) => total + size, 0) > maxTotalBytes) {
        return yield* new Error({ message: "Skill snapshot exceeds the installation size limit" })
      }

      const dir = directory(input.scope, remote.slug)
      if (!FSUtil.contains(root(input.scope), dir) || dir === root(input.scope)) {
        return yield* new Error({ message: "Invalid skill installation directory" })
      }
      const current = yield* manifest(dir)
      if ((yield* conflict(dir, current)) && input.force !== true) {
        return yield* new Error({ message: "Local skill files have changes", conflict: true })
      }

      const now = new Date().toISOString()
      const next: Marketplace.Manifest = {
        id: remote.id,
        provider: remote.provider,
        source: remote.source,
        slug: remote.slug,
        version: remote.version,
        hash: remote.hash,
        scope: input.scope,
        installedAt: current?.installedAt ?? now,
        updatedAt: now,
        files: Object.fromEntries(remote.files.map((file) => [file.path, hash(file.contents)])),
      }
      const token = crypto.randomUUID()
      const staging = `${dir}.tmp-${token}`
      const backup = `${dir}.old-${token}`
      yield* Effect.gen(function* () {
        yield* Effect.forEach(remote.files, (file) => fs.writeWithDirs(path.join(staging, file.path), file.contents), {
          concurrency: 8,
          discard: true,
        })
        yield* fs.writeWithDirs(path.join(staging, manifestFile), JSON.stringify(next, null, 2))
        const exists = yield* fs.existsSafe(dir)
        if (exists) yield* fs.rename(dir, backup)
        yield* fs.rename(staging, dir).pipe(
          Effect.catch((cause) => Effect.gen(function* () {
            if (exists) yield* fs.rename(backup, dir).pipe(Effect.ignore)
            return yield* Effect.fail(cause)
          })),
        )
        if (exists) yield* fs.remove(backup, { recursive: true, force: true }).pipe(Effect.ignore)
      }).pipe(
        Effect.mapError((cause) => new Error({ message: `Unable to install skill: ${String(cause)}` })),
        Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
      )
      return yield* installation(next, dir, remote.hash)
    })

    const remove = Effect.fn("SkillMarketplace.remove")(function* (input: Marketplace.RemoveInput) {
      const item = (yield* installed()).find((entry) =>
        entry.id === input.id && entry.provider === input.provider && entry.scope === input.scope,
      )
      if (!item) return
      if (item.conflict && input.force !== true) {
        return yield* new Error({ message: "Local skill files have changes", conflict: true })
      }
      yield* fs.remove(item.directory, { recursive: true, force: true }).pipe(
        Effect.mapError((cause) => new Error({ message: `Unable to remove skill: ${String(cause)}` })),
      )
    })

    return Service.of({
      search: Effect.fn("SkillMarketplace.search")(function* (input) {
        if (input.provider === "netease") {
          const query = input.query.trim().toLocaleLowerCase()
          const all = (yield* netease()).filter((skill) => {
            const matchesQuery = !query || [skill.name, skill.description, skill.source, ...skill.tags]
              .some((value) => value.toLocaleLowerCase().includes(query))
            return matchesQuery && (!input.category || skill.tags.includes(input.category))
          })
          const sorted = all.toSorted((left, right) => {
            if (input.sort === "recent") return (right.version ?? "").localeCompare(left.version ?? "")
            return left.name.localeCompare(right.name)
          })
          const offset = Math.max(0, input.page - 1) * input.limit
          return {
            data: sorted.slice(offset, offset + input.limit).map((skill) => ({
              id: skill.id,
              provider: "netease" as const,
              slug: installSlug(skill.id, skill.name),
              name: skill.name,
              source: skill.source,
              description: skill.description,
              url: skill.sourceUrl,
              version: skill.version,
              category: skill.tags[0] ?? null,
              tags: skill.tags,
              icon: null,
              githubStars: 0,
              downloadCount: 0,
              isVerified: false,
              securityScore: null,
              securityStatus: null,
              aiScore: null,
              reviewStatus: null,
            })),
            page: input.page,
            perPage: input.limit,
            total: sorted.length,
            categories: Array.from(new Set((yield* netease()).flatMap((skill) => skill.tags))).toSorted(),
          }
        }
        const url = new URL(`${officialUrl}/api/skills`)
        url.searchParams.set("q", input.query)
        url.searchParams.set("limit", String(input.limit))
        url.searchParams.set("page", String(input.page))
        url.searchParams.set("sort", input.sort)
        if (input.category) url.searchParams.set("category", input.category)
        const result = yield* execute(url.href, RemoteSearch, "SkillHub")
        return {
          data: result.skills.map((skill) => ({
            id: skill.id,
            provider: "official" as const,
            slug: skill.name,
            name: skill.name,
            source: `${skill.githubOwner}/${skill.githubRepo}`,
            description: skill.description ?? skill.name,
            url: `${officialUrl}/skills/${skill.id.split("/").map(encodeURIComponent).join("/")}`,
            version: null,
            category: null,
            tags: [],
            icon: null,
            githubStars: skill.githubStars,
            downloadCount: skill.downloadCount,
            isVerified: skill.isVerified,
            securityScore: skill.securityScore,
            securityStatus: skill.securityStatus,
            aiScore: skill.aiScore,
            reviewStatus: skill.reviewStatus,
          })),
          page: result.pagination.page,
          perPage: result.pagination.limit,
          total: result.pagination.total,
          categories: [],
        }
      }),
      detail,
      installed,
      install,
      remove,
    })
  }),
)

function asRecord(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function string(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function localized(value: unknown) {
  if (typeof value === "string") return value.trim()
  const info = asRecord(value)
  return string(info?.zh) || string(info?.en)
}

function installSlug(id: string, name: string) {
  const value = (id.split("/").at(-1) || name).trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  return value || `netease-${hash(id).slice(0, 10)}`
}

function snapshotHash(files: ReadonlyArray<{ path: string; contents: string }>) {
  return hash(files.toSorted((a, b) => a.path.localeCompare(b.path)).map((file) => `${file.path}\0${file.contents}`).join("\0"))
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [httpClient, FSUtil.node, Global.node, Location.node],
})
