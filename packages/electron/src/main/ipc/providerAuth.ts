import { ipcMain } from "electron"
import { readProviderAuthKey } from "../providerAuth"
import type { AssertIpcSender } from "./shared"

export function registerProviderAuthIpc(input: {
  assertSender: AssertIpcSender
  userDataPath: string
}) {
  ipcMain.handle("provider-auth:key", (event, providerID: unknown) => {
    input.assertSender(event)
    if (typeof providerID !== "string") throw new Error("Invalid provider id")
    return readProviderAuthKey(input.userDataPath, providerID)
  })
}
