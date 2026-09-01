# dsh-prime-orchestrator

Prime Agent orchestration for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), in one installable plugin package.

It turns a dsh agent into an orchestrator over [Prime Agent](https://pypi.org/project/prime-agent/) (the `prime-agent` CLI) sessions:

- **Host engine** (`ctx.prime`): the shared delegation table, one-shot CLI runs, the protocol-7 daemon socket client, the `/prime` JSON API, and the `prime-orchestrator` settings namespace.
- **Model-facing surface**: the `prime_agent` tool (delegate, monitor, steer, coordinate, set and manage persistent goals, heartbeats, prompt running sessions, read transcripts, inspect and manage recursive subagents, switch models mid-session, control queue and recursion depth, fork branches, export transcripts, and manage prime-agent sessions), the `prime-orchestrator:workflow` prompt section, and the bundled `prime-agent` skill.
- **Web UI**: the Prime fleet column (right side of the Web GUI, toggle at the sidebar foot) with live delegation/session/event streams, and the Settings → Prime Orchestration section.
- **Agent preset**: `prime-orchestrator` — the full coding agent plus the orchestration surface, derived from `standard`. Sessions can pick it from the preset picker.

## Install

Requires the `dsh` CLI (`@deepseek-ai/dsh`) on the host and the `prime-agent` CLI (`pip install prime-agent`) on PATH for the engine's `bin` (configurable).

```sh
# from npm (when published)
dsh plugin --profile web add dsh-prime-orchestrator

# from a git checkout (pnpm ≥10 builds it via the prepare script after you
# allowlist the build once — the failed install prints the exact remedy)
dsh plugin --profile web add github:mrme000m/dsh-prime-orchestrator
# if pnpm blocks the build: add to <profile>/pnpm-workspace.yaml, then re-run:
#   allowBuilds:
#     dsh-prime-orchestrator: true

# from a local checkout (ships the current lib/ as-is)
dsh plugin --profile web add ./path/to/dsh-prime-orchestrator
```

Then create a session with the **prime-orchestrator** preset (or set it as the default through Settings → Agent presets).

The preset is materialized into your user preset root (`$DSH_HOME/.agent-presets/prime-orchestrator/`) at startup:

- untouched → an updated package re-materializes it in place;
- edited by you → never overwritten again (delete the directory to re-materialize);
- the `Settings → Prime Orchestration` section and the `prime-orchestrator` settings namespace configure the engine (bin, stateDir, daemonSocket, maxDelegations, defaults for delegated sessions).

## Compatibility

| dsh | supported |
| --- | --- |
| 0.1.0-rc.7, 0.1.1-rc.2 (npm `latest`) | ✅ |
| 0.1.0-rc.5 and older | ❌ |
| 0.1.2-alpha (npm `alpha`) | ❌ — the client plugin API changed (`dsh-client-runtime` was removed); a port is planned |

The dsh-family packages are declared as peer dependencies with exact version chains, resolved at runtime from the running dsh installation (dsh materializes module-fallback links into `$DSH_HOME/profiles/node_modules`), so the plugin shares the host's module instances instead of installing duplicates.

## Package layout

One package, three mounted surfaces:

| Surface | Mount | Content |
| --- | --- | --- |
| `exports "."` | bundle row `prime-orchestration` (from `cordis.patch.yml`) | host engine + preset materialization |
| `exports "./agent-tool"` | preset composition row | `prime_agent` tool + prompt section + skill |
| `exports "./client"` (`dsh.client`) | browser roster (scanned from mounted entries) | fleet column + settings section |

### The layout override

The fleet column needs a fourth shell column (the `prime` slot, live across session switches), which stock dsh layouts do not ship. The package carries `lib/layout-override.js` — the **stock** ui-layout bundle (0.1.1-rc.2 sources) plus the prime-column patch — and installs it at boot through two host-side pieces:

- an exact route `/prime/layout-override.js` serving the artifact;
- an index tap rewriting the boot manifest entry for `@deepseek-ai/dsh-client-ui-layout` to that URL.

The browser module system registers one factory per module id (a second registration throws), so redirecting the entry URL — never a second registration — is the supported way to replace one browser plugin's implementation. No file inside the dsh installation is touched; uninstalling the package restores the stock three-column shell on the next page load. A future dsh that ships its own `prime` slot keeps working: the rewrite only swaps entries whose URL still points at `/plugins/...`.

## Development

```sh
pnpm install
pnpm run build      # lib/index.js, lib/agent-tool.js, lib/client.js
pnpm run typecheck
```

- `src/` — host half (engine, agent tool, preset materializer).
- `client/` — browser half (`client/index.tsx` is the plugin entry; `fleet/` and `settings/` carry the UI).
- `presets/prime-orchestrator/` — the agent preset payload; `skills/prime-agent/` — the bundled skill.
- `tsdown.config.ts` — host ESM build (peers external) + browser CJS closure-factory build (CSS Modules compiled by lightningcss, module-table externals preserved).

## Migrating from a workspace-based deployment

If you previously mounted the Prime feature through hand-copied workspace
builds (`@deepseek-ai/dsh-prime-orchestration`, `@deepseek-ai/dsh-prime-agent-tool`,
`@deepseek-ai/dsh-client-ui-prime`, `@deepseek-ai/dsh-client-ui-prime-settings`):

1. Remove their rows from your profile's `cordis.patch.yml` and any `ui-prime` /
   `ui-prime-settings` rows patched into the stock web composition.
2. Remove their `link:` entries from the profile's `package.json`.
3. Delete the old `$DSH_HOME/.agent-presets/prime-orchestrator/` (if you never
   edited it) so this package materializes its own on the next boot.

## Uninstall

```sh
dsh plugin --profile web remove dsh-prime-orchestrator
```

A materialized preset the user never modified is removed with the package; an edited one is kept (delete `$DSH_HOME/.agent-presets/prime-orchestrator/` yourself).

## License

MIT
