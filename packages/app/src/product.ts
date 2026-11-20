const channel = import.meta.env.VITE_OPENCODE_CHANNEL

/** Desktop builds follow their channel identity; the hosted web app keeps the upstream name. */
export const PRODUCT_NAME =
  channel === "prod" ? "OpenCodex" : channel === "beta" ? "OpenCodex Beta" : channel ? "OpenCodex Dev" : "OpenCode"
