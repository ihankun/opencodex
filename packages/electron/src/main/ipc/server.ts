import { ipcMain } from "electron"
import type { ServerHandle } from "../server"
import type { AssertIpcSender } from "./shared"

type ServerState =
  | { status: "online"; server: ServerHandle["state"] }
  | { status: "starting"; error?: string }

export function registerServerIpc(input: {
  assertSender: AssertIpcSender
  current: () => ServerState
  restart: () => Promise<ServerState>
}) {
  ipcMain.handle("server:get", (event) => {
    input.assertSender(event)
    return input.current()
  })
  ipcMain.handle("server:restart", (event) => {
    input.assertSender(event)
    return input.restart()
  })
}
