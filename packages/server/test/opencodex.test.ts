import path from "node:path"
import { $ } from "bun"
import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

it.live(
  "serves the opencodex fork endpoints",
  () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencodex-endpoints-")))
      const server = yield* startServer(path.join(tmp.path, "config"))
      const directory = encodeURIComponent(tmp.path)
      const headers = { ...server.headers, "content-type": "application/json" }
      const url = (pathname: string, query = `directory=${directory}`) => new URL(`${pathname}?${query}`, server.base)

      yield* Effect.promise(() => Bun.write(path.join(tmp.path, "hello.txt"), "hello\n"))

      const initialized = yield* Effect.promise(() =>
        fetch(new URL(`/api/vcs/init?location[directory]=${directory}`, server.base), {
          method: "POST",
          headers: server.headers,
        }),
      )
      expect(initialized.status).toBe(204)
      yield* Effect.promise(() => $`git -C ${tmp.path} config user.email test@example.com`.quiet())
      yield* Effect.promise(() => $`git -C ${tmp.path} config user.name Test`.quiet())

      const staged = yield* Effect.promise(() =>
        fetch(url("/vcs/stage"), {
          method: "POST",
          headers,
          body: JSON.stringify({ files: ["hello.txt"] }),
        }),
      )
      expect(staged.status).toBe(200)

      const committed = yield* Effect.promise(() =>
        fetch(url("/vcs/commit"), {
          method: "POST",
          headers,
          body: JSON.stringify({ message: "initial commit" }),
        }),
      )
      expect(committed.status).toBe(200)
      expect(yield* Effect.promise(() => committed.json())).toMatchObject({ output: expect.stringContaining("initial commit") })

      const history = yield* Effect.promise(() => fetch(url("/vcs/history", `directory=${directory}&limit=5`), { headers: server.headers }))
      const commits = (yield* Effect.promise(() => history.json())) as Array<{ subject: string }>
      expect(commits[0]?.subject).toBe("initial commit")

      const patched = yield* Effect.promise(() =>
        fetch(new URL("/experimental/config?global=true", server.base), {
          method: "PATCH",
          headers,
          body: JSON.stringify({ model: "test/model" }),
        }),
      )
      expect(patched.status).toBe(204)
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "config", "opencode.json")).json())).toMatchObject({
        model: "test/model",
      })

      const emptyGoal = yield* Effect.promise(() => fetch(url("/experimental/goal/ses_test"), { headers: server.headers }))
      expect(yield* Effect.promise(() => emptyGoal.json())).toEqual({ goal: null })

      const hooks = yield* Effect.promise(() =>
        fetch(url("/experimental/hooks"), {
          method: "PUT",
          headers,
          body: JSON.stringify({
            hooks: [
              {
                id: "hook-1",
                name: "Notify",
                event: "notification",
                command: "echo hook",
                enabled: true,
                approved: false,
                sandbox: false,
                timeoutSeconds: 5,
              },
            ],
          }),
        }),
      )
      expect(hooks.status).toBe(200)
      expect(yield* Effect.promise(() => hooks.json())).toMatchObject({ hooks: [{ id: "hook-1" }] })

      const runs = yield* Effect.promise(() =>
        fetch(url("/experimental/hooks/run"), {
          method: "POST",
          headers,
          body: JSON.stringify({ event: "notification" }),
        }),
      )
      expect(yield* Effect.promise(() => runs.json())).toMatchObject([{ status: "blocked" }])

      const memory = yield* Effect.promise(() =>
        fetch(url("/experimental/memory/workspace"), {
          method: "PUT",
          headers,
          body: JSON.stringify({ content: "# memory\n" }),
        }),
      )
      expect(yield* Effect.promise(() => memory.json())).toMatchObject({ exists: true, content: "# memory\n" })
    }),
  30_000,
)
