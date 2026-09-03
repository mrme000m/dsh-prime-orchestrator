# A2/A3 — Daemon-backed delegations + heartbeats (design)

**Status:** design (not implemented) · **Repo:** `dsh-prime-orchestrator` · **Date:** 2026-09-02

## Problem (F2/F3)

`delegate` starts `prime-agent --mode json <task>` as a detached subprocess. JSON mode is a
**client-owned one-shot worker** in prime-agent's daemon architecture (see
`packages/coding-agent/docs/daemon.md`): it does not register in the daemon `agents` roster,
is omitted from default lists/schedules/peer routing, and cannot be targeted by
`send`/`prompt`/`heartbeat_set`/`abort`. So a delegated worker cannot be steered or
heartbeated — the orchestrator can only poll its stdout.

## Target

A delegated worker becomes **daemon-backed (resident)**: it appears in `agents` with a stable
`activeSessionId` from the moment it starts, is steerable (`prompt`/`steer`/`abort`), and
supports `heartbeat_set` (A3). `PrimeDelegation.activeSessionId` (plumbing already landed) is
populated from the daemon instead of staying `null`.

## Mechanism (prime-agent daemon protocol v4)

The plugin already speaks the daemon socket — `daemonRequest(config, command, timeoutMs)` in
`src/engine.ts` (~line 981) sends JSONL command envelopes to the supervisor socket
(`defaultDaemonSocket()`). Every daemon-backed action (`heartbeat_set`, `rename`, `prompt`,
`get_messages`, …) already goes through it. The missing piece is **session creation**:

- **`create`** (`packages/coding-agent/src/modes/daemon/daemon-protocol.ts`, `DaemonCommand`):
  `{ id?, type: "create", sessionPath?, continueRecent?, noSession?, name?, config?:
  AgentSessionRuntimeConfig, runtimeMetadata?, lifecycle?: DaemonSessionLifecycle } &
  DaemonClientEnv & DaemonLaunchEnv`. `name: "orchestrator-<delegationId>"` names it;
  `lifecycle` selects the resident (daemon-backed) lifecycle; `config` carries
  model/provider/thinking/systemPrompt/goal/autonomous flags/cwd/tools.
- **`prompt`** / **`prompt_and_wait`** / **`steer`** / **`follow_up`**: deliver the task text to
  the created `activeSessionId` (these already exist in the plugin's command set).
- **`promote_owned_session`** / **`complete_owned_session`**: alternative lifecycle path — start
  owned (as today) then promote to resident; and headless completion.
- **`attach`** / **`reattach`**: subscribe to a session's event stream (needed if the plugin
  keeps live event ingestion instead of re-polling).

## Change plan

1. `src/engine.ts` `startDelegation` (~line 424): replace
   `spawn(config.bin, buildDelegateArgv(...))` with a daemon `create` + `prompt`. Keep the
   subprocess path as a fallback when the daemon socket is unreachable (roster-less local use).
2. Map `PrimeDelegateRequest` → `AgentSessionRuntimeConfig` (model, provider, thinking, goal,
   goalTokenBudget, autonomous + gates/turns/tokens/timeout, appendSystemPrompt/briefing, cwd).
   The mapping lives beside `buildDelegateArgv` (~line 344).
3. Name the session `orchestrator-<delegationId>` and capture the returned `activeSessionId`
   into `DelegationRecord.activeSessionId` (field already exists).
4. Lifecycle: on completion, `complete_owned_session` (or detach); `stop` already routes to the
   daemon `stop` path once an `activeSessionId` exists (verify `stopDelegation` ~line 501 and
   the `stop` action ~line 1757).
5. A3: once daemon-backed, `delegate` accepts `heartbeat`/`heartbeatSchedule`/`heartbeatMessage`
   and issues `{ type: "heartbeat_set", activeSessionId, schedule, prompt }` immediately after
   create (the plugin already has this command wired at ~line 1922).

## Acceptance

1. A delegated worker shows in `prime-agent agents` (roster) with a stable `activeSessionId`
   from start; `PrimeDelegation.activeSessionId` is non-null.
2. `prime_agent` `send`/`prompt`/`abort`/`stop` target it; `heartbeat_set` succeeds.
3. `npm run verify` + `npm run typecheck` pass; the subprocess fallback still works when the
   daemon is down.

## Risks

- `AgentSessionRuntimeConfig` is a large type; an incomplete mapping silently drops flags.
- Daemon lifecycle cleanup (detach/complete) must avoid orphaned resident workers.
- A broken `create` against a live supervisor can error, not corrupt — gate it behind a config
  flag (`daemonBacked: true`) until verified.