# Prime Orchestration Reliability & Efficiency Improvement Plan

**Status:** proposal (revised for DSH 0.1.2-alpha.5 host shift) · **Repo:** `dsh-prime-orchestrator` · **Date:** 2026-09-02
**Source:** grounded in a live orchestration session (two parallel prime-agent workers
fixing session-id detection and the fleet UI) plus repeated earlier orchestration.

This document captures the concrete failure modes observed while driving prime-agent
workers from the Prime Orchestrator harness, and the tooling changes that would make
future runs more reliable, error-free, and token-efficient. Each item is tied to an
observed incident, not a theoretical concern.

---

## 0. Host architectural shift (DSH 0.1.0-rc.5 → 0.1.2-alpha.5)

The plugin's host (`deepseek-harness`, origin = github.com/deepseek-ai/deepseek-harness)
has moved far past the plugin's fork point (`47f943859b`, release 0.1.0-rc.5) to
`0.1.2-alpha.5` (+2625 commits). The shifts that change this plan:

| Area | Upstream change | Effect on this plan |
|------|-----------------|---------------------|
| Steering | Native **steer service** (`feat/3220-steer-service`) + **team message steer** (`feat/3330-team-send-message-steer`, `feat(agent-team): unify messages on steer`) | DSH now has first-class steer + team-mailbox for **its own** subagents. A2/A3 (steerable, heartbeat-able delegations) is still plugin work because it targets the **prime-agent daemon** (a separate harness), but the plugin should mirror DSH's steer/team vocabulary and reuse DSH's host APIs in the fleet UI rather than invent a parallel one. |
| Sessions | **SQLite removed — JSONL-only** (`refactor(session)!: remove SQLite persistence backend`, `session-format-01-jsonl-only`), handle-based persistence seam (`refactor(session-persistence)!`), event-seq brands (`refactor(session)!: distinguish event seqs from log offsets`) | Session introspection is now a **projection API** (`session-projection`, `session-turn-outline`, `loadThrough` deep paging, new `packages/session` + `packages/session-query`). Any session inspector the plugin adds should read through this API, not raw files. |
| Presets | Native **agent-presets roster** + `packages/client/ui-agent-preset` + `packages/client/ui-permission-presets` (`feat(plugin-inventory): carry every agent preset's composition…`, live-mount-first inventory) | B2's "scout" sub-agent preset can now ride the native preset roster instead of a bespoke preset path. |
| Package graph | +`packages/experimental`, +`packages/webhook`, −`packages/examples`; new top-level `snapshots/` | The plugin must not assume the old package graph; `experimental`/`webhook` are unstable host surfaces. |

**Net effect:** the DSH-side halves of A (steer/team) and B2 (preset roster) are now
**native DSH capabilities to leverage, not reimplement**. The prime-agent-side work —
A1 unified id resolver, A2/A3 daemon-backed + heartbeat delegations, B1 briefing
injection, B3 graph-MCP injection, B4 exploration gating, C Mnemon writeback, D fleet
UI — is unchanged in intent and remains plugin work.

---

## 1. Observed failure modes (the evidence base)

| # | Failure | What happened | Cost |
|---|---------|---------------|------|
| F1 | **Session-id ambiguity** | `action=goal id=2cda24a8d2a9` → `unknown prime-agent session id`; `action=events id=01a05f8c…` → `unknown delegation id`. Three id namespaces (delegation id, daemon active session id, full session id) are not uniformly resolved. | Orchestrator wasted turns re-trying ids; risk of acting on the wrong session. |
| F2 | **Delegations are unsteerable** | Delegated workers run as `prime-agent --mode json` subprocesses and do **not** register in the daemon `agents` roster, so `send`/`send_message`/`prompt`/`heartbeat_set` cannot target them. When a worker over-explored, I could only poll `events` — no way to redirect it. | No mid-flight correction; wasted a full worker. |
| F3 | **No heartbeat on delegations** | `heartbeat_set` needs a daemon active-session id; subprocess delegations have none, so no self-checkpoints on the workers I actually delegated. | No checkpoint steering; manual polling only. |
| F4 | **Exploration overruns** | One worker spent **22 turns / 30 tool calls reading files** before writing a single line. The other spent ~5 turns re-deriving a bug analysis I had already completed. | Near-missed the 30-min timeout; huge token spend on redundant reads. |
| F5 | **Orchestrator analysis not transmitted** | I mapped the 3 id namespaces + exact line numbers **before** delegating, but the workers could only receive a flat `task` string, so each re-read the 2200-line `engine.ts` from scratch. | Duplicated comprehension work. |
| F6 | **No durable memory** | Mnemon reported `healthy` but **0 insights** — my session-id analysis, the tvcli map, the QD root-cause diagnosis were never persisted for future workers. | Every session re-explores from zero. |
| F7 | **code-review-graph unused** | The workspace `AGENTS.md` mandates the graph MCP tools, but prime-agent workers have no MCP injection, so they fell back to `grep`/`sed`/`read` via `ipython`. | Slower, token-heavier exploration. |
| F8 | **No phase gating** | Nothing distinguishes "exploring" from "implementing", so an over-exploring worker runs silently until timeout. | No early-warning signal to the orchestrator. |

---

## 2. Improvement pillars

### A. Reliability — make session identity and steering unambiguous

**A1. Finish the unified identity resolver (in flight).**
`resolveSessionIdentity` is being built (Worker A) so every action accepts any id form
and resolves it to `{ delegationId, activeSessionId, sessionId, sessionFile, sessionName }`.
- Close the loop by also updating the `prime_agent` tool description so the `id`/`agent`
  param contract states "any id form is accepted" instead of the current three-way overload.
- Add unit tests for delegation-id / active-session-id / full-session-id / name / ambiguous-prefix / unknown.

**A2. Make delegated workers daemon-backed (and steerable).**
Today `delegate` spawns a detached subprocess. Change it to register the session with the
daemon immediately (name it, e.g. `orchestrator-<delegationId>`), so:
- `send`/`send_message`/`prompt`/`heartbeat_set`/`abort`/`stop` all work on it,
- it shows in the `agents` roster with a stable `activeSessionId`,
- the delegation record links `sessionId` → daemon `activeSessionId` from the start.

**A3. Add heartbeats to delegations.**
Once A2 lands, `delegate` should accept `heartbeat` + `heartbeatSchedule` + `heartbeatMessage`
and set the recurring checkpoint automatically, so every worker self-reports progress
instead of requiring manual polling.

**A4. Surface a single canonical id per delegation.**
The `PrimeDelegation` view should carry **all three ids** (`delegationId`, `activeSessionId`,
`sessionId`) plus a copy-to-clipboard affordance in the fleet UI, so the human and the
model never have to guess which id a card represents.

### B. Efficiency — eliminate redundant exploration

**B1. Inject an orchestrator "briefing" into the worker.**
Add a `briefing` field to `PrimeDelegateRequest`. The orchestrator writes a compact
pre-digested summary (file map, key symbols, exact line numbers, the three id namespaces,
the known decision) and it is **prepended to the worker's system prompt**. Workers then
verify instead of re-explore. This alone would have collapsed F5's 5-turn re-derivation.

**B2. Add a dedicated code-explorer sub-agent preset.**
A "scout" role whose only job is comprehension: it runs the **code-review-graph MCP tools**
(`get_minimal_context_tool`, `query_graph_tool` callers/callees, `list_communities_tool`,
`detect_changes_tool`) and emits a **token-capped structural brief** (~500 tokens): entry
points, communities, hotspots, and the specific symbols a change touches. The implementing
worker consumes the brief instead of reading files. This splits "understand" from "change"
and lets each phase use the cheapest tool.

**B3. Wire the code-review-graph MCP tools into prime-agent.** ✅ **done**
Register the code-review-graph MCP server in prime-agent's `Settings.mcpServers` (stdio:
`code-review-graph serve`, auto-detected repo), with a comprehension-focused `enabledTools`
allowlist (`get_minimal_context_tool`, `query_graph_tool`, `semantic_search_nodes_tool`,
`list_communities_tool`, `detect_changes_tool`, `list_flows_tool`, `get_flow_tool`,
`traverse_graph_tool`). Workers then call these natively instead of shelling out to `grep`;
the server builds the graph on demand, so there is no separate "built graph" gate.
- Implemented: `scripts/register-code-review-graph-mcp.mjs` (idempotent, backs up settings)
  + registered in `~/.prime/agent/settings.json`.
- Caveat: `serve` auto-detects the repo from the MCP process cwd; for a single fixed repo,
  add `--repo <path>` to `args`.

**B4. Exploration budget gating.** ✅ **done**
`classifyToolCode(code)` (exported, tested) classifies each tool call's `args.code` as
mutation (`edit`/`write`/`write_text`/`sed -i`/`mv`/`rm`/`npm run build`/`git add`…) vs
read-only (default). `ingestChunk` tracks read-only vs mutation turns per delegation and sets
`explorationWarning` once a worker exceeds **8** consecutive read-only turns without a write;
`readTurns`/`writeTurns`/`explorationWarning` are exposed on `PrimeDelegation` (host + client).
This is the automated fix for F4.

**B5. Implementation-first guidance in the delegate prompt template.**
Default the worker prompt with an explicit "you have the briefing; verify then WRITE CODE
in this turn — do not re-read files you were given summaries of" bias. Make the
over-exploration anti-pattern explicit in the default system prompt.

### C. Memory — persist comprehension so it is never re-derived

**C1. Persist code comprehension to Mnemon.**
Add a memory-writeback step in the orchestrator's workflow prompt section: after analysis,
store a compact "project comprehension" insight (repo, key symbols, id namespaces, gotchas,
graph-build status) via the mnemon tooling. Before delegating, recall existing comprehension
for the target repo and fold it into the briefing. This turns F6's lost analysis into a
reusable asset.

**C2. Persist the session-identity map as a durable fact.**
The three-id-namespace discovery (delegation id vs daemon active-session id vs full
session id) is exactly the kind of cross-session lesson that should live in Mnemon, not
be re-derived. Store it once; recall it in every orchestration session.

**C3. Cross-worker shared comprehension for parallel fan-out.**
When two workers touch the same repo, seed each with the **same** recalled briefing
(so they share a mental model) but distinct file ownership, so they do not re-derive
the codebase structure independently — and do not collide. The orchestrator writes the
briefing once and reuses it for every worker in the fan-out.

### D. Tooling polish (fleet UI + observability)

**D1. Fleet UI: id copy + search + better rows.**
(In flight via Worker B — search/filter, copy-to-clipboard ids, session rows with
model/cwd/first-message, loading skeletons, empty states.) Keep this as the baseline
UX; it directly supports A4's "canonical id" goal.

**D2. Show exploration-vs-implementation phase in the fleet column.** ✅ **done**
The delegation card now shows `read {r} · write {w}` while running, plus an `exploring`
badge when `explorationWarning` is set — so the human sees at a glance whether a worker is
exploring or producing.

**D3. Report delegation ids uniformly in every action result.**
Every action response (goal, session, events, stop, heartbeats) should echo the resolved
identity (`source`, `delegationId`, `activeSessionId`, `sessionId`) so the model always
knows which namespace it actually resolved to — closing the loop on F1 at the API level.

---

## 3. Prioritized work order

| Priority | Item | Area | Effort | Unblocks |
|----------|------|------|--------|----------|
| P0 | A1 finish identity resolver + tests | engine | in flight | F1 |
| P0 | A2 daemon-backed delegations | engine | M | F2, F3, A3 |
| P0 | A4 canonical id per delegation + D3 echo identity | engine+UI | S | F1 |
| P1 | B1 briefing injection | engine+agent-tool | S | F5, C3 |
| P1 | B4 exploration budget gating + D2 phase indicator ✅ | engine+UI | S | F4, F8 |
| P1 | B2 code-explorer sub-agent preset | presets+prompt | M | F7, efficiency |
| P2 | B3 code-review-graph MCP injection ✅ | prime-agent settings + script | S | F7 |
| P2 | A3 heartbeats on delegations | engine | S | F3 |
| P2 | B5 implementation-first default prompt | preset | S | F4 |
| P3 | C1/C2/C3 Mnemon comprehension writeback + recall | orchestrator workflow | M | F6 |

> **Host-shift adjustment (0.1.2-alpha.5):** B2 rides the native agent-presets roster;
> DSH-side steer/team messaging is now native via `steer-service` + `agent-team`, so the
> fleet UI should mirror that vocabulary. The prime-agent-side rows (A1, A2/A3, B1, B3,
> B4, C, D) are unchanged. Do not reimplement host features in the plugin.

---

## 4. Acceptance criteria

1. Any action that takes a session/agent/delegation id resolves it from **any** id form
   and echoes the resolved identity; no `unknown … id` errors remain for resolvable ids.
2. A delegated worker can be steered (`send`/`prompt`/`abort`), heartbeated, and seen in
   the `agents` roster from the moment it starts.
3. An orchestrator can attach a `briefing` that workers consume instead of re-exploring,
   and a code-explorer sub-agent can produce that briefing via the code-review-graph MCP tools.
4. A worker that exceeds the exploration budget emits a steer event before timeout.
5. Code comprehension and the session-identity map survive across sessions via Mnemon,
   and are recalled automatically into future briefings.
6. `npm run build` and `npm test` pass, and the fleet UI renders search/filter, id copy,
   richer session rows, and loading/empty states.