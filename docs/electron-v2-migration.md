# electron-v2 迁移说明

`electron-v2` 是 OpenCodex 从上游 V1 迁移到 OpenCode V2 后继续开发的分支。`electron` 分支停留在 V1，仅用于 bug 修复，不再接收新功能。

## 这次合并发生了什么

- 合并区间：`ebb7b76ec`（2026-09-19）→ `06d3c060a1`（2026-10-28），共 5784 个上游提交。
- 上游已经切到 **OpenCode V2**（根 `package.json` 版本 `2.2.0`），并删除了整个 `packages/opencode`（V1 服务端，`44b6938b2a removed packages/opencode`）。
- 上游包结构改为：
  - `packages/cli` — V2 CLI / 进程入口
  - `packages/core` — 会话、Agent、Tool、Provider、VCS、Worktree 等核心实现
  - `packages/server` — HTTP handler
  - `packages/protocol` — HttpApi group 定义
  - `packages/client` / `packages/sdk` — Promise / Effect 客户端与 SDK
  - 新增 `utils`、`ai`、`gui-plugins`、`theme`、`latex`、`merman`、`patchmark` 等包
- workspace 包名从 `@opencode-ai/*` 改为 `@opencode/*`。
- 工具链要求 **bun 1.4.4**（`bun check` 是内置类型检查命令，1.3.x 没有）。

合并时 Electron 侧只做了两件机械调整：

1. `packages/electron/package.json` 的 `@opencode-ai/sdk` 改为 `@opencode/client`。
2. renderer/preload 里的 `@opencode-ai/sdk/v2/client` 导入改为 `@opencode/client`，`createOpencodeClient(...)` 改为 `OpenCode.make(...)`。

## 合并中暂时移除的 V1 代码

这些代码仍完整保存在 `electron` 分支（`b642d52730`），用 `git show electron:<path>` 查看。它们依赖 V1 的服务端结构，无法直接编译到 V2。

### 服务端功能（原 `packages/opencode`）

| 功能 | V1 源码位置（electron 分支） | V2 迁移目标 |
| --- | --- | --- |
| Goal 模式 | `src/goal/prompts.ts`、`src/goal/state.ts`、`src/tool/goal.ts` | `core/src/plugin/agent.ts`、`core/src/plugin/command.ts`、`core/src/tool/plugin/*` |
| Hooks | `src/hooks/manager.ts`、`src/hooks/index.ts` | 参考 `core/src/plugin/hooks.ts` 与插件生命周期 |
| 安全 / 沙箱 | `src/security/index.ts` | `core/src/tool/plugin/shell.ts`、permission、`packages/sandbox-runtime` |
| Memory source | `src/session/memory-source.ts` | `core/src/session/*`、`core/src/system-context/*` |
| durable JSON | `src/util/durable-json.ts` | `core/src/kv/*` 或 `core/src/util/*` |
| VCS 子仓库 / 分支 | `src/project/vcs.ts`、`src/git/index.ts` | `core/src/vcs.ts`、`core/src/git.ts` |
| Worktree 增强 | `src/worktree/index.ts` | `core/src/worktree.ts` |
| Account 错误处理 | `src/account/account.ts` | `core/src/account/*` |
| Agent / Command 的 goal 入口 | `src/agent/agent.ts`、`src/command/index.ts` | `core/src/plugin/agent.ts`、`core/src/plugin/command.ts` |
| Session 定制 | `src/session/{instruction,processor,prompt,run-state,session,tools}.ts` | `core/src/session/*` |
| Tool 定制 | `src/tool/{apply_patch,edit,glob,grep,read,registry,shell,write}.ts` | `core/src/tool/plugin/*` |
| 自定义 HTTP 路由 | `src/server/routes/instance/httpapi/{groups,handlers}/{experimental,instance,project,provider,session}.ts` | `protocol/src/groups/*` + `server/src/handlers/*`，然后 `bun run generate`（packages/client） |
| 对应测试 | `test/**` 中同名文件 | 跟随迁移目标放置 |

### 核心包定制（原 `packages/core`）

| 功能 | V1 位置 | 说明 |
| --- | --- | --- |
| `opencodex.db` 数据库名 | `core/src/database/database.ts` 的 `path()` | V2 路径逻辑在 `packages/cli/src/database-path.ts`，需要把 `opencodex` channel 分支补回去 |
| OpenCode Provider 公共 key | `core/src/plugin/provider/opencode.ts` | 需要在新 provider 插件里恢复 `apiKey = "public"` 回退 |
| Skill Marketplace | `core/src/skill/marketplace.ts`、`schema/src/skill-marketplace.ts` | 已从本分支删除；如需保留，按 V2 protocol/handler 结构重新接入 |

## Electron 集成待办

1. **服务端 bundle**：`packages/electron/scripts/build-server.ts` 仍在构建 `packages/opencode`（已删除）。需要改为使用 `packages/cli/script/build-node.ts` 的 V2 产物，或改为直接打包 `packages/server`。
2. **进程启动**：`packages/electron/src/main/server.ts:188` 仍指向 `opencode/dist/node/node.js`，需要跟随 V2 产物路径调整。
3. **Renderer 类型**：V2 client 不再导出 `Event`、`Message`、`Model`、`Part`、`Provider`、`Session` 等 V1 类型，对应改为 `SessionMessageNative`、`ProviderID`、`SessionID` 等 V2 generated types。`unwrap()` 的 `{ data, error }` 语义也需要按新 client 调整。
4. **自定义接口**：renderer 调用的 goal / hooks / security / memory / subrepos / provider catalog 等端点在 V2 服务端尚不存在，需要先完成上表的服务端迁移。
5. **验证命令**：`bun --cwd packages/electron verify`、`bun electron:build`。

## 工具链

- 安装依赖：`bun install`（建议使用 bun 1.4.4）
- 类型检查：在包目录执行 `bun check --no-script`，或 `bun typecheck`
- 客户端/协议重新生成：`bun run generate`（在 `packages/client`）
