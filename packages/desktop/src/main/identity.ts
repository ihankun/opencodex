import path from "node:path"

export type Channel = "local" | "dev" | "beta" | "prod"

const appNames: Record<Channel, string> = {
  local: "OpenCodex Dev",
  dev: "OpenCodex Dev",
  beta: "OpenCodex Beta",
  prod: "OpenCodex",
}

const appIDs: Record<Channel, string> = {
  local: "ai.opencodex.desktop.dev",
  dev: "ai.opencodex.desktop.dev",
  beta: "ai.opencodex.desktop.beta",
  prod: "ai.opencodex.desktop",
}

// Unpackaged dev runs keep the dev profile directory (`appID`), but use a separate Windows
// AppUserModelID: Electron writes a Start Menu `Electron.lnk` with the active AUMID on the first
// toast, which would otherwise shadow the installed OpenCodex Dev shortcut and route its toast
// clicks to bare `electron.exe`.
const LOCAL_APP_USER_MODEL_ID = "ai.opencodex.desktop.local"

export function resolveIdentity(channel: Channel, packaged: boolean) {
  return {
    appName: packaged ? appNames[channel] : "OpenCodex Dev",
    appID: packaged ? appIDs[channel] : "ai.opencodex.desktop.dev",
    appUserModelID: packaged ? appIDs[channel] : LOCAL_APP_USER_MODEL_ID,
  }
}

export function isCollidingDevShortcut(
  shortcut: { readonly appUserModelId?: string; readonly target: string },
  appUserModelID: string,
  execPath: string,
) {
  if (!shortcut.appUserModelId) return false

  if (shortcut.appUserModelId.toLowerCase() !== appUserModelID.toLowerCase()) return false

  return path.win32.normalize(shortcut.target).toLowerCase() !== path.win32.normalize(execPath).toLowerCase()
}
