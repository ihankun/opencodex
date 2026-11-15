import type { WindowEffect } from "@opencode/app/desktop-menu"

// Electron only supports setBackgroundMaterial on Windows 11 22H2 and up.
const windowsBackgroundMaterialBuild = 22_621

export function windowsBuild(version: string) {
  const build = Number(version.split(".")[2])

  return Number.isInteger(build) ? build : undefined
}

// The window-effect values the host can actually apply. Empty means the setting is hidden.
export function windowEffectOptions(platform: NodeJS.Platform, version: string): readonly WindowEffect[] {
  if (platform === "win32")
    return (windowsBuild(version) ?? 0) >= windowsBackgroundMaterialBuild ? ["off", "acrylic", "mica"] : []

  if (platform === "darwin") return ["off", "on"]

  return []
}
