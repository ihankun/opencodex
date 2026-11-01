import { describe, expect, test } from "bun:test"
import { SkillMarketplace } from "@opencode/core/skill/marketplace"

describe("SkillMarketplace", () => {
  test("accepts files contained by a skill snapshot", () => {
    expect(SkillMarketplace.safePath("SKILL.md")).toBe(true)
    expect(SkillMarketplace.safePath("references/example.md")).toBe(true)
  })

  test("rejects traversal and absolute paths", () => {
    expect(SkillMarketplace.safePath("../secret")).toBe(false)
    expect(SkillMarketplace.safePath("references/../../secret")).toBe(false)
    expect(SkillMarketplace.safePath("/tmp/secret")).toBe(false)
    expect(SkillMarketplace.safePath("C:\\secret")).toBe(false)
    expect(SkillMarketplace.safePath("references\\secret")).toBe(false)
  })

  test("uses stable sha256 content hashes", () => {
    expect(SkillMarketplace.hash("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
  })
})
