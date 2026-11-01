export * as SkillMarketplace from "./skill-marketplace.js"

import { Schema } from "effect"
import { optional } from "./schema.js"

export const Scope = Schema.Literals(["global", "project"])
export type Scope = typeof Scope.Type

export const Provider = Schema.Literals(["official", "netease"])
export type Provider = typeof Provider.Type

export const Sort = Schema.Literals(["recommended", "aiScore", "downloads", "stars", "rating", "recent"])
export type Sort = typeof Sort.Type

export const File = Schema.Struct({
  path: Schema.String,
  contents: Schema.String,
}).annotate({ identifier: "SkillMarketplace.File" })
export type File = typeof File.Type

export const Summary = Schema.Struct({
  id: Schema.String,
  provider: Provider,
  slug: Schema.String,
  name: Schema.String,
  source: Schema.String,
  description: Schema.String,
  url: Schema.String,
  version: Schema.NullOr(Schema.String),
  category: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
  icon: Schema.NullOr(Schema.String),
  githubStars: Schema.Number,
  downloadCount: Schema.Number,
  isVerified: Schema.Boolean,
  securityScore: Schema.NullOr(Schema.Number),
  securityStatus: Schema.NullOr(Schema.String),
  aiScore: Schema.NullOr(Schema.Number),
  reviewStatus: Schema.NullOr(Schema.String),
}).annotate({ identifier: "SkillMarketplace.Summary" })
export type Summary = typeof Summary.Type

export const Page = Schema.Struct({
  data: Schema.Array(Summary),
  page: Schema.Number,
  perPage: Schema.Number,
  total: Schema.Number,
  categories: Schema.Array(Schema.String),
}).annotate({ identifier: "SkillMarketplace.Page" })
export type Page = typeof Page.Type

export const Detail = Schema.Struct({
  id: Schema.String,
  provider: Provider,
  source: Schema.String,
  slug: Schema.String,
  version: Schema.NullOr(Schema.String),
  category: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
  icon: Schema.NullOr(Schema.String),
  hash: Schema.String,
  files: Schema.Array(File),
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
}).annotate({ identifier: "SkillMarketplace.Detail" })
export type Detail = typeof Detail.Type

export const Manifest = Schema.Struct({
  id: Schema.String,
  provider: Provider,
  source: Schema.String,
  slug: Schema.String,
  version: Schema.NullOr(Schema.String),
  hash: Schema.NullOr(Schema.String),
  scope: Scope,
  installedAt: Schema.String,
  updatedAt: Schema.String,
  files: Schema.Record(Schema.String, Schema.String),
}).annotate({ identifier: "SkillMarketplace.Manifest" })
export type Manifest = typeof Manifest.Type

export const Installation = Schema.Struct({
  id: Schema.String,
  provider: Provider,
  slug: Schema.String,
  scope: Scope,
  directory: Schema.String,
  manifest: Manifest,
  conflict: Schema.Boolean,
  updateAvailable: Schema.Boolean,
}).annotate({ identifier: "SkillMarketplace.Installation" })
export type Installation = typeof Installation.Type

export const InstallInput = Schema.Struct({
  id: Schema.String,
  provider: Provider,
  scope: Scope,
  force: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "SkillMarketplace.InstallInput" })
export type InstallInput = typeof InstallInput.Type

export const RemoveInput = Schema.Struct({
  id: Schema.String,
  provider: Provider,
  scope: Scope,
  force: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "SkillMarketplace.RemoveInput" })
export type RemoveInput = typeof RemoveInput.Type
