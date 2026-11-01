import { Skill } from "@opencode/core/skill"
import { SkillMarketplace } from "@opencode/core/skill/marketplace"
import { SkillMarketplaceError } from "@opencode/protocol/groups/skill"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import { Api } from "../api"
import { response } from "../location"

export const SkillHandler = HttpApiBuilder.group(Api, "server.skill", (handlers) =>
  handlers
    .handle("skill.list", () => response(Skill.Service.use((skill) => skill.list())))
    .handle("skill.marketplaceSearch", (ctx) =>
      response(
        SkillMarketplace.Service.use((marketplace) =>
          badRequest(marketplace.search({
            query: ctx.query.q,
            provider: ctx.query.provider,
            sort: ctx.query.sort ?? "recommended",
            category: ctx.query.category,
            limit: ctx.query.limit ?? 24,
            page: ctx.query.page ?? 1,
          })),
        ),
      ),
    )
    .handle("skill.marketplaceDetail", (ctx) =>
      response(SkillMarketplace.Service.use((marketplace) => badRequest(marketplace.detail(ctx.query.id, ctx.query.provider)))),
    )
    .handle("skill.marketplaceInstalled", () =>
      response(SkillMarketplace.Service.use((marketplace) => badRequest(marketplace.installed()))),
    )
    .handle("skill.marketplaceInstall", (ctx) =>
      response(SkillMarketplace.Service.use((marketplace) => badRequest(marketplace.install(ctx.payload)))),
    )
    .handle("skill.marketplaceRemove", (ctx) =>
      SkillMarketplace.Service.use((marketplace) =>
        badRequest(marketplace.remove(ctx.payload)).pipe(Effect.as(HttpApiSchema.NoContent.make())),
      ),
    ),
)

function badRequest<A, R>(effect: Effect.Effect<A, SkillMarketplace.Error, R>) {
  return effect.pipe(
    Effect.mapError(
      (error) =>
        new SkillMarketplaceError({
          message: error.message,
          conflict: error.conflict,
        }),
    ),
  )
}
