import { Skill } from "@opencode/schema/skill"
import { SkillMarketplace } from "@opencode/schema/skill-marketplace"
import { Location } from "@opencode/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

export class SkillMarketplaceError extends Schema.TaggedError<SkillMarketplaceError>()(
  "SkillMarketplaceError",
  {
    message: Schema.String,
    conflict: Schema.optional(Schema.Boolean),
  },
  { httpApiStatus: 400 },
) {}

export const SkillGroup = HttpApiGroup.make("server.skill")
  .add(
    HttpApiEndpoint.get("skill.list", "/api/skill", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Skill.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "skill.list",
          summary: "List skills",
          description: "Retrieve currently registered skills.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("skill.marketplaceSearch", "/api/skill/marketplace/search", {
      query: Schema.Struct({
        ...LocationQuery.fields,
        q: Schema.String,
        provider: SkillMarketplace.Provider,
        sort: SkillMarketplace.Sort.pipe(Schema.optional),
        category: Schema.String.pipe(Schema.optional),
        limit: Schema.NumberFromString.pipe(Schema.optional),
        page: Schema.NumberFromString.pipe(Schema.optional),
      }),
      success: Location.response(SkillMarketplace.Page),
      error: SkillMarketplaceError,
    }).annotateMerge(locationQueryOpenApi),
  )
  .add(
    HttpApiEndpoint.get("skill.marketplaceDetail", "/api/skill/marketplace/detail", {
      query: Schema.Struct({ ...LocationQuery.fields, id: Schema.String, provider: SkillMarketplace.Provider }),
      success: Location.response(SkillMarketplace.Detail),
      error: SkillMarketplaceError,
    }).annotateMerge(locationQueryOpenApi),
  )
  .add(
    HttpApiEndpoint.get("skill.marketplaceInstalled", "/api/skill/marketplace/installed", {
      query: LocationQuery,
      success: Location.response(Schema.Array(SkillMarketplace.Installation)),
      error: SkillMarketplaceError,
    }).annotateMerge(locationQueryOpenApi),
  )
  .add(
    HttpApiEndpoint.post("skill.marketplaceInstall", "/api/skill/marketplace/install", {
      query: LocationQuery,
      payload: SkillMarketplace.InstallInput,
      success: Location.response(SkillMarketplace.Installation),
      error: SkillMarketplaceError,
    }).annotateMerge(locationQueryOpenApi),
  )
  .add(
    HttpApiEndpoint.delete("skill.marketplaceRemove", "/api/skill/marketplace/install", {
      query: LocationQuery,
      payload: SkillMarketplace.RemoveInput,
      success: HttpApiSchema.NoContent,
      error: SkillMarketplaceError,
    }).annotateMerge(locationQueryOpenApi),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "skill",
      description: "Experimental skill routes.",
    }),
  )
