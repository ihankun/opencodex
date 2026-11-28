import { expect, test } from "bun:test"
import { isCollidingDevShortcut, resolveIdentity } from "./identity"

test.each([
  {
    channel: "dev",
    packaged: true,
    appName: "OpenCodex Dev",
    appID: "ai.opencodex.desktop.dev",
    appUserModelID: "ai.opencodex.desktop.dev",
  },
  {
    channel: "beta",
    packaged: true,
    appName: "OpenCodex Beta",
    appID: "ai.opencodex.desktop.beta",
    appUserModelID: "ai.opencodex.desktop.beta",
  },
  {
    channel: "prod",
    packaged: true,
    appName: "OpenCodex",
    appID: "ai.opencodex.desktop",
    appUserModelID: "ai.opencodex.desktop",
  },
  {
    channel: "local",
    packaged: false,
    appName: "OpenCodex Dev",
    appID: "ai.opencodex.desktop.dev",
    appUserModelID: "ai.opencodex.desktop.local",
  },
  {
    channel: "dev",
    packaged: false,
    appName: "OpenCodex Dev",
    appID: "ai.opencodex.desktop.dev",
    appUserModelID: "ai.opencodex.desktop.local",
  },
] as const)(
  "identity for $channel (packaged=$packaged) isolates unpackaged AUMID from installed channels",
  ({ channel, packaged, appName, appID, appUserModelID }) => {
    expect(resolveIdentity(channel, packaged)).toEqual({ appName, appID, appUserModelID })
  },
)

const installedExe = "C:\\Users\\user\\AppData\\Local\\Programs\\ai.opencodex.desktop.dev\\OpenCodex Dev.exe"

const devElectron = "D:\\repo\\node_modules\\electron\\dist\\electron.exe"

test.each([
  {
    name: "unpackaged Electron.lnk claiming the installed dev AUMID",
    shortcut: { appUserModelId: "ai.opencodex.desktop.dev", target: devElectron },
    expected: true,
  },
  {
    name: "case-insensitive AUMID match",
    shortcut: { appUserModelId: "AI.OpenCodex.Desktop.Dev", target: devElectron },
    expected: true,
  },
  {
    name: "unpackaged Electron.lnk with the isolated local AUMID",
    shortcut: { appUserModelId: "ai.opencodex.desktop.local", target: devElectron },
    expected: false,
  },
  {
    name: "unrelated app shortcut",
    shortcut: { appUserModelId: "com.example.other", target: devElectron },
    expected: false,
  },
  {
    name: "shortcut without an AUMID",
    shortcut: { target: devElectron },
    expected: false,
  },
  {
    name: "shortcut targeting the installed executable itself",
    shortcut: { appUserModelId: "ai.opencodex.desktop.dev", target: installedExe.toLowerCase() },
    expected: false,
  },
])("isCollidingDevShortcut returns $expected for $name", ({ shortcut, expected }) => {
  expect(isCollidingDevShortcut(shortcut, "ai.opencodex.desktop.dev", installedExe)).toBe(expected)
})
