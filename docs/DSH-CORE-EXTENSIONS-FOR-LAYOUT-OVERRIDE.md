# DSH core extensions that obsolete the layout override

**Repo:** `dsh-prime-orchestrator`
**Author:** m (Prime Orchestrator maintainer)
**Date:** 2026-09-07
**Status:** PR proposal for `deepseek-ai/deepseek-harness`
**DSH version target:** 0.1.2-alpha (where `dsh-client-runtime` still exists — the plugin is ❌ on 0.1.2-alpha today per its compatibility table)

This document names the three first-class extension points that the DSH core
**must** expose so the `dsh-prime-orchestrator` package can drop its
`lib/layout-override.js` HTTP-rewrite workaround (see
`src/layout-override.ts:1-135` and the `layout-override/` source tree).

The override currently exists because:

1. **`@deepseek-ai/dsh-client-modules` rejects duplicate factory registration**
   (`lib/client.js:104`):
   ```js
   if (this.bootstrapIds.has(id) || this.factories.has(id))
     throw new Error(`client-modules: duplicate factory registration for "${registration.id}" ...`);
   ```
   There is no API to **replace** or **wrap** a registered factory. The only
   way to swap a browser bundle's behavior is to redirect the URL the boot
   manifest loads from. The override serves `/prime/layout-override.js` and
   uses `webServer.tapIndex(html => rewriteLayoutEntry(html, version))`
   (`src/layout-override.ts:80-106`) to rewrite the `__DSH_BOOT__` JSON in the
   served `index.html` so the browser fetches the patched bundle instead of
   the stock one.

2. **`SlotCore.register` is the only way to declare child slot specs**
   (`@deepseek-ai/dsh-client-runtime/lib/client.js:333`):
   ```js
   return this.ctx.effect(() => this["_register"](options, component), "slots.register()");
   ```
   Child slots (e.g. `prime`, `shell.overlay`) are passed **only** inside the
   parent slot's `register({ name: 'root', children: {...} })` call. There is
   no `ctx.slots.declare(key, spec)` or `ctx.slots.addChild(parent, key, spec)`
   surface. A plugin that wants to add a child slot to `root` must either
   register `root` itself (which is what the override does), or rely on the
   host DSH version to have shipped the slot already.

3. **There is no compatibility-versioning contract** for browser plugins.
   When a plugin needs `slot X` and the host doesn't ship it, the plugin
   cannot politely say "I'm skipping this surface." It either replaces the
   host's factory (override), or it crashes at render time. The override's
   `entry.url.startsWith('/plugins/...')` guard (`src/layout-override.ts:95`)
   is an ad-hoc partial fix — it skips the rewrite only when the host has
   already migrated off the `/plugins/...` URL prefix.

The remainder of this document is the concrete PR design: three small,
backwards-compatible additions that close each gap. After they ship, the
override becomes dead code (delete it; the `entry.url` guard becomes a
passive no-op once every host URL prefix is migrated).

---

## Extension 1 — `ClientModuleSystem.replace(id, factory)` / `wrap(id, factory)`

**Package:** `@deepseek-ai/dsh-client-modules`
**File:** `src/client/system.ts` (and `lib/client.js` generated)
**Backwards-compatible:** yes. New methods, no signature changes.

### Problem

A bundle whose `id` is `@deepseek-ai/dsh-client-ui-layout` ships a `root`
slot registration with a specific set of child slots. A plugin wants to ship
the **same bundle id** but with an additional child slot declared (e.g.
`prime`) and the same AppFrame wired to it. There is no API for that — the
single factory registration is hard-wired as a one-shot insert, and the only
escape hatch is to intercept the URL the manifest loads.

### Design

Add two methods to `ClientModuleSystem` (and surface them on the
`ClientModuleLoader` contract face):

```ts
/**
 * Replace one registered factory. Subsequent imports materialize the new
 * factory instead of the original. The original factory is dropped — callers
 * who need a delegate-chain, use wrap() instead.
 * @param id - the graph row id (e.g. "@deepseek-ai/dsh-client-ui-layout").
 * @param factory - the new factory function.
 * @throws when no factory is registered under `id` (call register first or
 * wait for the arrival to settle).
 */
replace(id: string, factory: Factory): void;

/**
 * Wrap one registered factory. Subsequent imports materialize a delegation:
 * the original factory runs first (its exports are passed in), then the
 * wrapper returns the wrapper's exports. The wrapper can read, augment, or
 * replace individual exports. The original factory is preserved (and can be
 * unwrapped by passing the original).
 * @param id - the graph row id.
 * @param wrap - delegate factory (originalExports, require) => wrapperExports.
 * @throws when no factory is registered under `id`.
 */
wrap(id: string, wrap: (originalExports: any, require: Require) => any): void;
```

Both methods are **idempotent**: a second `replace` overwrites the first;
a second `wrap` chains. The contract is "last write wins." This matches the
mental model of HTTP middleware: replacement is absolute, wrapping is
additive.

### Why this replaces the override

A plugin that wants to add a `prime` slot to `root` can now:

```ts
// in the plugin's client apply()
ctx.modules.wrap('@deepseek-ai/dsh-client-ui-layout', (original) => {
  // original.apply(ctx) is what the stock bundle would run.
  // We re-run it inside a wrapping slot system that re-registers root with
  // an extra child spec. Or, simpler: we re-export the original apply but
  // require a pre-registered slot declaration before it fires.
  return original
})
ctx.slots.beforeRegister('root', (spec) => ({
  ...spec,
  children: { ...spec.children, prime: { kind: 'single', scope: 'root' } },
}))
```

The HTTP-level override, the `__DSH_BOOT__` JSON parser, the `tapIndex`
rewriter, the `/prime/layout-override.js` route, and the lightningcss
rebuild at a different source path — all become unnecessary.

### Implementation sketch

In `client.js` `ClientModuleSystem.register`:

```ts
register(registration) {
  const id = stripClientSuffix(registration.id);
  if (this.bootstrapIds.has(id)) throw new Error(...)
  this.factories.set(id, registration.factory);  // ← this is the line
}

replace(id: string, factory: Factory): void {
  const key = stripClientSuffix(id);
  if (this.bootstrapIds.has(key)) throw new Error(`replace() cannot shadow a bootstrap module "${id}"`);
  if (!this.factories.has(key)) throw new Error(`replace() called for unregistered factory "${id}"`);
  this.factories.set(key, factory);
  // No memoized load to invalidate: factories are materialized lazily on
  // first import. If the entry has already materialized, that's a known
  // caveat documented below.
}

wrap(id: string, wrap: WrapFn): void {
  const key = stripClientSuffix(id);
  if (this.bootstrapIds.has(key)) throw new Error(`wrap() cannot shadow a bootstrap module "${id}"`);
  const original = this.factories.get(key);
  if (original === undefined) throw new Error(`wrap() called for unregistered factory "${id}"`);
  this.factories.set(key, (require) => wrap(original(require), require));
}
```

**Caveat: late replacement.** A bundle that has already been materialized
(by an earlier consumer's `import`) cannot be re-materialized; the cached
exports remain. The plugin author must `wrap`/`replace` **before** any
consumer imports the target bundle. The cordis fiber load order is already
deterministic (topological), so the plugin's own `apply()` is guaranteed to
run before any `renderSlot()` call, which is the first consumer. This
caveat can be surfaced as a runtime check: `if (this.loadCache.has(key))
console.warn("client-modules: replace() after materialization has no effect")`.

---

## Extension 2 — `SlotRegistry.declare(key, spec)` and `SlotRegistry.addChild(parent, key, spec)`

**Package:** `@deepseek-ai/dsh-client-runtime` (caller) — but the change
lives in **`@deepseek-ai/dsh-client-ui-slots`**'s `SlotCore` and is re-exposed
through the `SlotRegistry` cordis service.
**File:** `lib/types/client/slots.ts` and the runtime's `slots.js`.
**Backwards-compatible:** yes. New methods.

### Problem

The only way to declare a child slot under `root` is to be the plugin that
calls `slots.register({ name: 'root', children: { ... } })`. A plugin that
wants to **add** a child slot (e.g. `prime`) cannot without owning the
parent. The override works around this by replacing the layout package's
`apply()` body wholesale; a clean alternative is to let any plugin extend
the parent's children set.

### Design

```ts
/**
 * Declare one slot spec without occupying it. Idempotent: a re-declaration
 * with the same key + spec is a no-op; a re-declaration with a different spec
 * throws (slot specs are part of the host's contract; downstream consumers
 * compose against them). Available in any plugin's apply(), not only the
 * one that registers the parent. The SlotCore owns the lookup; the parent
 * slot's `register()` call merges in the previously-declared children when
 * it commits the registration.
 */
declare(key: keyof SlotMap & string, spec: SlotSpec): void;

/**
 * Add one child slot spec to a parent that is already declared (or, if not,
 * will be declared — the call queues until the parent registers). Same
 * idempotency contract as declare(): re-adding the same key+spec is a no-op;
 * re-adding a different spec throws.
 */
addChild(parent: keyof SlotMap & string, key: string, spec: SlotSpec): void;
```

The semantics are deliberately narrow: **`declare()` only adds new keys; it
never overwrites an existing child's spec.** This keeps the parent owner's
intent stable across plugin composition. If a plugin author needs to *change*
a slot's spec, the answer is to coordinate with the parent plugin — there is
no API for one plugin to silently rewrite another plugin's contract.

### How it composes with the existing `register({ name, children })` path

In `SlotCore.register(...)`:

```ts
register(options, component) {
  const merged = mergeDeclaredChildren(options.name, options.children ?? {});
  // ...
}
```

`mergeDeclaredChildren` is a tiny lookup helper:

```ts
function mergeDeclaredChildren(parent: string, declared: ChildrenDecl): ChildrenDecl {
  const accumulated = declaredChildren.get(parent) ?? {};
  // declared wins on conflict (the parent's own children: object is authoritative
  // for keys it names); declared wins because the parent is in the same fiber.
  return { ...accumulated, ...declared };
}
```

The parent's own `children:` block is still the source of truth for keys it
names. Plugins calling `addChild` add **new** keys. If a plugin calls
`addChild('root', 'prime', spec)` and the layout package's stock
`children: { prime: ... }` is also present, the parent's wins (it's already
in the fiber; no surprise). If the parent's stock has *no* `prime`, the
plugin's add is what brings it in.

### Why this also obsoletes the override

The override's `apply()` exists to re-register `root` with an extra child
slot. With `addChild('root', 'prime', { kind: 'single', scope: 'root' })`,
the plugin does not need to own the parent registration at all. It calls:

```ts
ctx.slots.addChild('root', 'prime', { kind: 'single', scope: 'root' })
ctx.slots.addChild('root', 'shell.overlay', { kind: 'list', scope: 'root' })
// Then just register the prime column itself:
ctx.slots.register({ name: 'prime' }, PrimePanel)
```

No factory replacement, no HTTP-level rewrite, no vendored copy of the
stock bundle.

### Implementation sketch

In `client-runtime/lib/client.js`'s `SlotRegistry`:

```ts
declare(key: string, spec: SlotSpec): () => void {
  if (key === 'root') throw new Error(`declare('root') is reserved; register({ name: 'root' }) is the declaration path`);
  return this.ctx.effect(() => this._core.declare(key, spec), `slots.declare(${JSON.stringify(key)})`);
}

addChild(parent: string, key: string, spec: SlotSpec): () => void {
  if (parent !== 'root') throw new Error(`addChild() currently supports the 'root' parent only (got "${parent}")`);
  return this.ctx.effect(() => this._core.addChild(parent, key, spec), `slots.addChild(${JSON.stringify(parent)}, ${JSON.stringify(key)})`);
}
```

In `@deepseek-ai/dsh-client-ui-slots`' `SlotCore`:

```ts
class SlotCore {
  _declared = new Map<string, SlotSpec>();
  _declaredChildren = new Map<string, Map<string, SlotSpec>>();

  declare(key: string, spec: SlotSpec): () => void {
    const existing = this._declared.get(key);
    if (existing !== undefined && !specEquals(existing, spec))
      throw new Error(`slots: re-declaration of "${key}" with a different spec`);
    this._declared.set(key, spec);
    return () => { this._declared.delete(key); };
  }

  addChild(parent: string, key: string, spec: SlotSpec): () => void {
    let bucket = this._declaredChildren.get(parent);
    if (bucket === undefined) { bucket = new Map(); this._declaredChildren.set(parent, bucket); }
    const existing = bucket.get(key);
    if (existing !== undefined && !specEquals(existing, spec))
      throw new Error(`slots: re-declaration of "${parent}.${key}" with a different spec`);
    bucket.set(key, spec);
    return () => { bucket?.delete(key); };
  }

  register(options, component) {
    const declared = this._declaredChildren.get(options.name);
    const mergedChildren = declared ? Object.assign({}, ...Array.from(declared, ([k, v]) => ({ [k]: v }))) : {};
    const finalChildren = { ...mergedChildren, ...(options.children ?? {}) };
    // ... rest of the existing register logic, with `finalChildren` instead of `options.children`
  }
}
```

The fiber-scoped disposal (the returned `() => void`) means a plugin unload
removes its declared children — no stale declarations from a removed plugin
leak into a subsequent fiber.

---

## Extension 3 — `SlotSpec.version` + a "soft requirement" registration mode

**Package:** `@deepseek-ai/dsh-client-ui-slots` + `@deepseek-ai/dsh-client-runtime`
**File:** `lib/types/client/slots.ts`, plus a small addition to `SlotSpec`.
**Backwards-compatible:** yes. New optional field, new opt-in mode.

### Problem

A plugin that wants to render into `prime` has two failure modes today:

1. **Host doesn't ship the `prime` slot** (DSH <0.1.1-rc.2). Render fails
   with "no slot registered for 'prime'."
2. **Host ships `prime` but with a different `owner` props shape** than this
   plugin expects. Type-check passes; runtime is silent. The PrimePanel
   just sees no `collapsed` / `width` props.

The override handles #1 by *forcing* the host to ship the slot. But the
right answer is for the plugin to be able to say "I need slot X with these
owner props; if you don't have it, please skip me silently and surface a
diagnostic."

### Design

Extend `SlotSpec` with an optional `version`:

```ts
interface SlotSpec {
  kind: 'single' | 'list';
  scope: 'root' | 'session' | 'session-maybe';
  /** Optional: the version of the contract this spec represents. SlotCore
   * stores it but does not enforce it; consumers can read it. */
  version?: string;
}
```

And add a sibling registration mode:

```ts
register(options: BaseOptions & { optional: true }, component): () => void;
```

When `optional: true`:

- If the slot spec exists and matches the parent's children block, the
  registration proceeds normally.
- If the slot spec is **absent**, the registration is silently dropped
  (and a single diagnostic is logged via the cordis plugin's
  `ctx.logger.warn` if available).
- If the slot spec is **present but mismatched** (different `kind` or
  `scope`), the registration is also dropped with a louder diagnostic.

The semantic is "best-effort": a plugin that depends on a slot the host
doesn't have is degraded, not crashed.

### Why this is the right shape (and not a try/catch around `register`)

A `register` call has **side effects** beyond just attaching the component:
it injects the entry into the slot table, allocates a store instance if a
`store:` handle is present, and triggers a `slots/changed` event. A
try/catch around `register` would leave a half-registered entry in the
table. The optional mode must short-circuit **before** any of those side
effects.

### Why this also obsoletes the override

The override's defensive `entry.url.startsWith('/plugins/...')` guard
(`src/layout-override.ts:95`) is exactly this kind of "soft requirement"
expressed at the URL layer. With optional mode, the plugin can write:

```ts
ctx.slots.register(
  { name: 'prime', optional: true },
  PrimePanel
)
```

If `prime` exists, PrimePanel renders. If it doesn't, PrimePanel is silently
dropped and a single diagnostic fires. The plugin no longer needs to
rewrite the boot manifest to force the host to ship `prime`.

### Implementation sketch

In `SlotCore`:

```ts
register(options, component) {
  if (options.optional === true) {
    const spec = this._declared.get(options.name) ?? this._childrenSpecOf(options.name);
    if (spec === undefined || !specCompatible(spec, options)) {
      console.warn(`slots: optional registration "${options.name}" skipped (slot absent or spec mismatch)`);
      return () => {};
    }
  }
  // ... existing register body unchanged
}
```

`specCompatible(spec, options)` checks `kind` and `scope` (the only two
runtime-enforceable fields); the optional `version` field is exposed to the
registrant for its own compatibility check if it cares.

---

## What changes for `dsh-prime-orchestrator` once all three land

The plugin can delete:

- `src/layout-override.ts` — no more `webServer.tapIndex` rewrite.
- `layout-override/` source tree — no more vendored copy of the layout
  bundle.
- `lib/layout-override.js` + `.js.map` — same.
- `src/index.ts:67` `installLayoutOverride(webCtx)` call.
- `tsdown.config.ts` entry for the layout-override build.
- `package.json` `files` array entries.

The plugin's `client/` browser half shrinks to: register `PrimePanel` into
`prime` (with `optional: true` if it cares about older hosts), and the
`shell.overlay` banner. The compiled output goes from 24 KB `client.js` to
~10 KB. The README's "The layout override" section (`README.md:61-68`)
deletes, and the compatibility table (`README.md:39-46`) drops the
"0.1.0-rc.7 / 0.1.1-rc.2 ✅, 0.1.2-alpha ❌" line because the plugin no
longer carries a host-version dependency.

The migration is automatic for users: reinstalling `dsh-prime-orchestrator`
@ the next version produces the same UI on the same DSH versions, but with
no HTTP-level rewrite happening at boot — measurable as a small page-load
improvement on hosts with slow disk or non-trivial profile plugin stacks.

---

## Suggested PR sequencing

1. **PR 1 — Extension 1 (`replace` / `wrap`)**: smallest, most general,
   unblocks the override deletion entirely. Land in DSH 0.1.2-alpha.6 or
   whichever release branch is open. The plugin's `optional` mode is also
   useful for many other "best-effort" plugins and is small enough to land
   in the same PR if the reviewer prefers one large PR.
2. **PR 2 — Extension 2 (`declare` / `addChild`)**: slightly larger surface
   area but trivially small implementation. Land alongside or after PR 1.
3. **Plugin PR** — drop `layout-override/`, `src/layout-override.ts`, and
   the related `tsdown` / `package.json` entries. Verify against DSH
   0.1.1-rc.2 (no change), DSH 0.1.2-alpha (plugin becomes compatible), and
   any version that has neither extension installed (plugin still works
   because the optional mode silently drops).

The three extensions are deliberately orthogonal: each one closes a
specific gap and is independently useful. PR 1 alone obsoletes the
override for plugins that just need to *augment* a stock bundle's
behavior. PR 2 closes the structural slot-declaration gap that no
plugin should have to work around. PR 3 makes the host/plugin contract
honest about its dependency surface.

---

## Acceptance criteria

1. A plugin that adds a child slot to `root` via `addChild('root', 'prime', spec)`
   followed by `register({ name: 'prime' }, Component)` renders correctly
   on a stock DSH host that does **not** ship `prime` natively — without
   any HTTP-level manifest rewrite.
2. The dsh-prime-orchestrator package builds with `layout-override/`,
   `src/layout-override.ts`, `tsdown` config for layout-override, and
   `lib/layout-override.js` deleted; `pnpm run build` and `pnpm test`
   pass; the rendered UI is byte-equivalent on DSH 0.1.1-rc.2 and 0.1.2-alpha.
3. `webServer.tapIndex` is no longer called by any plugin code path; the
   plugin's `installLayoutOverride` is removed; no vendored copy of
   `@deepseek-ai/dsh-client-ui-layout` ships in the plugin's `lib/`.
4. A plugin that uses `wrap('@deepseek-ai/dsh-client-ui-layout', fn)` to
   add a CSS-in-JS provider sees the wrapper run exactly once per import,
   on first materialization, with the original factory's exports handed
   to the wrapper.
5. A plugin that uses `register({ name: 'unknown-slot', optional: true }, X)`
   does not crash on a host that lacks the slot; a single diagnostic is
   surfaced via the cordis plugin logger.
