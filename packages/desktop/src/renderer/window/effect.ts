import type { WindowEffect } from "@opencode/app/desktop-menu"
import { createSignal } from "solid-js"
import { api } from "../api"

const bootstrap = api.getWindowBootstrap().windowEffects

const windowEffectOptions = bootstrap?.options ?? []

// Seeded synchronously from the window bootstrap so the first paint already knows the effect.
const [windowEffect, setWindowEffectSignal] = createSignal<WindowEffect>(bootstrap?.current ?? "off")

if (windowEffectOptions.length > 0) {
  void api.getWindowEffect().then(setWindowEffectSignal, () => undefined)

  api.onWindowEffectChanged((effect) => setWindowEffectSignal(effect))
}

// Main applies the material to every window and broadcasts the new value; the caller only asks.
const setWindowEffect = (effect: WindowEffect) => api.setWindowEffect(effect)

export { setWindowEffect, windowEffect, windowEffectOptions }
