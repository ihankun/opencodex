import type { WindowEffect } from "@opencode/app/desktop-menu"
import { WINDOW_EFFECT_KEY } from "../storage/keys"
import { getStore } from "../storage/store"
import { windowEffectOptions } from "./capabilities"

export function windowEffectOptionsForHost() {
  return windowEffectOptions(process.platform, process.getSystemVersion())
}

// A stored value from another platform or an unsupported build falls back to off.
export function storedWindowEffect(): WindowEffect {
  const value = getStore().get(WINDOW_EFFECT_KEY)

  return windowEffectOptionsForHost().find((option) => option === value) ?? "off"
}
