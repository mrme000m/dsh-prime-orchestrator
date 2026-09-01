# dsh-prime-orchestrator

[English](README.md) | 中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）提供的 Prime Agent 编排能力，一个可安装的插件包。

它把一个 dsh agent 变成 [Prime Agent](https://pypi.org/project/prime-agent/)（`prime-agent` CLI）会话的编排者：

- **宿主引擎**（`ctx.prime`）：共享委托表、一次性 CLI 运行、protocol-7 守护进程套接字客户端、`/prime` JSON API 与 `prime-orchestrator` 设置命名空间。
- **模型侧**：`prime_agent` 工具（委派、监控、转向、协调、设置与管理持久目标、心跳、向运行中会话下发提示、读取对话记录、检查与管理递归子代理、运行中切换模型、管理队列与递归深度、分支重试、导出会话、管理 prime-agent 会话）、`prime-orchestrator:workflow` 提示段，以及内置的 `prime-agent` 技能。
- **Web 界面**：Prime 舰队侧栏（Web 界面右侧，侧栏底部开关），实时展示委托/会话/事件流；以及 设置 → Prime 编排 分区。
- **Agent 预设**：`prime-orchestrator` —— 基于 `standard` 的完整编码 agent 加编排能力，会话可从预设选择器选用。

## 安装

需要宿主机上装有 `dsh` CLI（`@deepseek-ai/dsh`），以及引擎调用的 `prime-agent` CLI（`pip install prime-agent`；路径可用配置覆盖）。

```sh
# npm（发布后）
dsh plugin --profile web add dsh-prime-orchestrator

# git 检出（pnpm ≥10 需先放行一次构建——失败的安装会打印确切补救方式）
dsh plugin --profile web add github:mrme000m/dsh-prime-orchestrator
# 若 pnpm 阻止了构建：在 <profile>/pnpm-workspace.yaml 里加入后重试：
#   allowBuilds:
#     dsh-prime-orchestrator: true

# 本地检出（按当前 lib/ 原样安装）
dsh plugin --profile web add ./path/to/dsh-prime-orchestrator
```

然后用 **prime-orchestrator** 预设新建会话（或在 设置 → Agent 预设 里设为默认）。

预设会在启动时物化到你的用户预设根目录（`$DSH_HOME/.agent-presets/prime-orchestrator/`）：

- 未改动 → 升级插件时原位重新物化；
- 被你编辑过 → 永不再覆盖（删除目录即可重新物化）；
- 设置 → Prime 编排 分区与 `prime-orchestrator` 设置命名空间负责引擎配置（bin、stateDir、daemonSocket、maxDelegations、委派会话默认值）。

## 兼容性

| dsh 版本 | 支持 |
| --- | --- |
| 0.1.0-rc.7、0.1.1-rc.2（npm `latest`） | ✅ |
| 0.1.0-rc.5 及更早 | ❌ |
| 0.1.2-alpha（npm `alpha`） | ❌ —— 客户端插件 API 变更（`dsh-client-runtime` 已移除），移植计划中 |

dsh 家族包以精确版本链声明为 peer 依赖，运行时从正在运行的 dsh 安装解析（dsh 会把模块回退链接写入 `$DSH_HOME/profiles/node_modules`），插件与宿主共享同一模块实例，不会安装重复副本。

## 包结构

一个包，三个挂载面：

| 挂载面 | 挂载方式 | 内容 |
| --- | --- | --- |
| `exports "."` | 包补丁行 `prime-orchestration`（`cordis.patch.yml`） | 宿主引擎 + 预设物化 |
| `exports "./agent-tool"` | 预设组合行 | `prime_agent` 工具 + 提示段 + 技能 |
| `exports "./client"`（`dsh.client`） | 浏览器插件表（从已挂载行扫描） | 舰队侧栏 + 设置分区 |

### 布局覆盖

舰队侧栏需要第四个外壳栏（`prime` 槽位，跨会话切换保活），官方 dsh 的布局并不包含。本包携带 `lib/layout-override.js` —— **官方** ui-layout（0.1.1-rc.2 源码）加 prime 栏补丁的构建 —— 并在启动时通过两个宿主侧机制安装：

- 精确路由 `/prime/layout-override.js` 提供该产物；
- 一次 index tap 把启动清单中 `@deepseek-ai/dsh-client-ui-layout` 条目的 URL 改写为该地址。

浏览器模块系统每个模块 id 只允许注册一个工厂（重复注册会抛错），因此改写条目 URL —— 而非二次注册 —— 是替换某个浏览器插件实现的受支持方式。dsh 安装内的文件不会被改动；卸载本包后，下次刷新即恢复官方三栏外壳。未来 dsh 若自带 `prime` 槽位也不受影响：改写只针对 URL 仍指向 `/plugins/...` 的条目。

## 开发

```sh
pnpm install
pnpm run build      # lib/index.js、lib/agent-tool.js、lib/client.js
pnpm run typecheck
```

- `src/` —— 宿主侧（引擎、agent 工具、预设物化器）。
- `client/` —— 浏览器侧（`client/index.tsx` 为插件入口；`fleet/`、`settings/` 为界面）。
- `presets/prime-orchestrator/` —— agent 预设内容；`skills/prime-agent/` —— 内置技能。
- `tsdown.config.ts` —— 宿主 ESM 构建（peer 外置）+ 浏览器 CJS 闭包工厂构建（lightningcss 编译 CSS Modules，保留模块表外置项）。

## 从手工部署的工作区构建迁移

如果你此前通过手工复制的工作区构建（`@deepseek-ai/dsh-prime-orchestration`、`@deepseek-ai/dsh-prime-agent-tool`、`@deepseek-ai/dsh-client-ui-prime`、`@deepseek-ai/dsh-client-ui-prime-settings`）挂载 Prime 功能：

1. 从 profile 的 `cordis.patch.yml` 删除这些行，以及被补丁进官方 web 组合的 `ui-prime` / `ui-prime-settings` 行。
2. 从 profile 的 `package.json` 删除它们的 `link:` 依赖。
3. 删除旧的 `$DSH_HOME/.agent-presets/prime-orchestrator/`（前提是你从未编辑过），本包会在下次启动时物化自己的副本。

## 卸载

```sh
dsh plugin --profile web remove dsh-prime-orchestrator
```

未被用户改动的已物化预设随包一并移除；改动过的会保留（自行删除 `$DSH_HOME/.agent-presets/prime-orchestrator/`）。

## 许可

MIT
