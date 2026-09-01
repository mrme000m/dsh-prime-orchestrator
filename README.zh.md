# dsh-prime-orchestrator

[English](README.md) | 中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）提供的 Prime Agent 编排能力，一个可安装的插件包。

它把一个 dsh agent 变成 [Prime Agent](https://pypi.org/project/prime-agent/)（`prime-agent` CLI）会话的编排者：

- **宿主引擎**（`ctx.prime`）：共享委托表、一次性 CLI 运行、protocol-7 守护进程套接字客户端、`/prime` JSON API 与 `prime-orchestrator` 设置命名空间。
- **模型侧**：`prime_agent` 工具（委派、监控、转向、协调、心跳与管理 prime-agent 会话）、`prime-orchestrator:workflow` 提示段，以及内置的 `prime-agent` 技能。
- **Web 界面**：Prime 舰队侧栏（Web 界面右侧，侧栏底部开关），实时展示委托/会话/事件流；以及 设置 → Prime 编排 分区。
- **Agent 预设**：`prime-orchestrator` —— 基于 `standard` 的完整编码 agent 加编排能力，会话可从预设选择器选用。

## 安装

需要宿主机上装有 `dsh` CLI（`@deepseek-ai/dsh`），以及引擎调用的 `prime-agent` CLI（`pip install prime-agent`；路径可用配置覆盖）。

```sh
# npm（发布后）
dsh plugin --profile web add dsh-prime-orchestrator

# git 检出（pnpm 通过 prepare 脚本构建；pnpm ≥10 需先按提示放行构建）
dsh plugin --profile web add github:<owner>/dsh-prime-orchestrator

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

## 卸载

```sh
dsh plugin --profile web remove dsh-prime-orchestrator
```

未被用户改动的已物化预设随包一并移除；改动过的会保留（自行删除 `$DSH_HOME/.agent-presets/prime-orchestrator/`）。

## 许可

MIT
