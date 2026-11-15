import { describe, expect, test } from "bun:test"
import { windowBootstrapArgument, windowBootstrapFromArguments, type WindowBootstrap } from "./window-bootstrap"

describe("window bootstrap", () => {
  test("round-trips through argv and keeps unknown values absent", () => {
    const bootstrap: WindowBootstrap = {
      id: "win a/b ü",
      firstLaunchPending: false,
      packaged: true,
      windowEffects: { options: ["off", "acrylic", "mica"], current: "acrylic" },
    }

    expect(windowBootstrapFromArguments(["electron", windowBootstrapArgument(bootstrap)])).toEqual(bootstrap)
    // Absent means "ask over IPC", so a value must not appear on the way through.
    expect(windowBootstrapFromArguments([windowBootstrapArgument({ id: "x" })])).toEqual({ id: "x" })
    expect(() => windowBootstrapFromArguments(["electron"])).toThrow("Window bootstrap argument not found")
  })
})
