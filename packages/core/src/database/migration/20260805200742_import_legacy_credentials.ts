import path from "node:path"
import { Effect } from "effect"
import { Global } from "@opencode/util/global"
import type { DatabaseMigration } from "../migration.js"
import { importLegacyCredentials } from "../legacy-credentials.js"

const migration: DatabaseMigration.Migration = {
  id: "20260805200742_import_legacy_credentials",
  up(tx) {
    return Effect.gen(function* () {
      const global = yield* Global.Service
      return yield* importLegacyCredentials(tx, path.join(global.data, "auth.json"))
    })
  },
}

export default migration
export { importLegacyCredentials } from "../legacy-credentials.js"
