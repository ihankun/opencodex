import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { readProviderAuthKey } from "./providerAuth.ts"

async function withAuthFile(content: string, run: (userDataPath: string) => Promise<void>) {
  const userDataPath = await mkdtemp(join(tmpdir(), "opencodex-provider-auth-"))
  try {
    const directory = join(userDataPath, "data", "opencode")
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "auth.json"), content)
    await run(userDataPath)
  } finally {
    await rm(userDataPath, { recursive: true, force: true })
  }
}

test("reads a plaintext api key from the local auth store", async () => {
  await withAuthFile(JSON.stringify({ anthropic: { type: "api", key: "sk-ant-test" } }), async userDataPath => {
    assert.equal(await readProviderAuthKey(userDataPath, "anthropic"), "sk-ant-test")
  })
})

test("returns the token for wellknown entries", async () => {
  await withAuthFile(
    JSON.stringify({ "https://example.com": { type: "wellknown", key: "EXAMPLE_ENV", token: "well-known-token" } }),
    async userDataPath => {
      assert.equal(await readProviderAuthKey(userDataPath, "https://example.com"), "well-known-token")
    },
  )
})

test("does not expose oauth access tokens", async () => {
  await withAuthFile(
    JSON.stringify({ openai: { type: "oauth", access: "rotating-token", refresh: "refresh", expires: 0 } }),
    async userDataPath => {
      assert.equal(await readProviderAuthKey(userDataPath, "openai"), undefined)
    },
  )
})

test("returns undefined for unknown providers and missing files", async () => {
  await withAuthFile(JSON.stringify({ anthropic: { type: "api", key: "sk-ant-test" } }), async userDataPath => {
    assert.equal(await readProviderAuthKey(userDataPath, "deepseek"), undefined)
    assert.equal(await readProviderAuthKey("/nonexistent/user-data", "anthropic"), undefined)
  })
})

test("rejects invalid provider ids", async () => {
  await withAuthFile(JSON.stringify({ anthropic: { type: "api", key: "sk-ant-test" } }), async userDataPath => {
    assert.equal(await readProviderAuthKey(userDataPath, ""), undefined)
  })
})
