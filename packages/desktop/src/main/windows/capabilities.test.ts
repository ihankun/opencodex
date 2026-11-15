import { describe, expect, test } from "bun:test"
import { windowEffectOptions, windowsBuild } from "./capabilities"

describe("window effects", () => {
  test("offers acrylic and mica only where Electron supports background materials", () => {
    expect(windowEffectOptions("win32", "10.0.19045")).toEqual([])
    expect(windowEffectOptions("win32", "10.0.22000")).toEqual([])
    expect(windowEffectOptions("win32", "10.0.22621")).toEqual(["off", "acrylic", "mica"])
    expect(windowEffectOptions("win32", "10.0.22631")).toEqual(["off", "acrylic", "mica"])
    expect(windowEffectOptions("win32", "10.0.26100")).toEqual(["off", "acrylic", "mica"])
  })

  test("offers vibrancy on macOS and nothing elsewhere", () => {
    expect(windowEffectOptions("darwin", "14.5")).toEqual(["off", "on"])
    expect(windowEffectOptions("linux", "6.8")).toEqual([])
  })

  test("rejects malformed version strings", () => {
    expect(windowEffectOptions("win32", "")).toEqual([])
    expect(windowEffectOptions("win32", "10.0")).toEqual([])
    expect(windowEffectOptions("win32", "10.0.abc")).toEqual([])
  })

  test("reads the build from the third version component", () => {
    expect(windowsBuild("10.0.22621.1")).toBe(22_621)
    expect(windowsBuild("10.0")).toBeUndefined()
  })
})
