# pi-extensions — Macro Architecture Fleet

Phase-gated architecture workflow extensions for [pi](https://github.com/earendil-works/pi), with the phase order **enforced in code** rather than described in a prompt.

Eleven TypeScript files, zero runtime dependencies, no build step.

```shell
cp fleet-*.ts ~/.pi/agent/extensions/     # or <project>/.pi/extensions/
```

Then `/reload`. Requires pi v0.74+; extensions load through jiti, so nothing compiles.

---

## What this is

A 12-phase state machine for doing architecture work — job definition, requirements, primitive, contracts, module boundaries, dependencies, tooling, verification, decisions, contract freeze, implementation, integration. It exists to answer one question that most "architecture discipline" tooling punts: **how do you stop an agent from writing code before the architecture is settled?**

The answer here is a `tool_call` hook that refuses the write.

## The design principle

A prompt is a *declaration of intent*. A hook is an *enforcement point*. Only the second one changes what an agent can do.

Concretely:

| Mechanism | Power |
|---|---|
| "You must write architecture first" in a system prompt | advisory — the model complies when it feels like it |
| A `tool_call` hook returning `{ block: true, reason }` | the call never reaches the filesystem |

Everything in this repo is built on the second row.

## What the gate actually blocks

Once a job is initialized, `fleet-core`'s `evaluateWriteGate` refuses:

- **Writing an artifact before its phase.** `05_MODULE_REGISTRY.md` belongs to Phase 4; attempting it at Phase 0 is refused with the reason naming the owning phase.
- **Writing implementation code before contract freeze.** Any `write`/`edit` outside `architecture/` is refused until Phase 10.
- **Mutating state early.** `git commit`, `rm -r`, `npm install`, `curl … | sh` and similar are refused before Phase 10.
- **Editing frozen contracts.** After `/fleet:contract-freeze`, design artifacts are immutable. Changes go through a decision.

Reads are never gated. Every block is appended to `architecture/fleet-audit.log`, and a deliberate bypass is recorded with `/fleet:override <rule> <reason>` rather than left unlogged.

## Gates are evaluated against artifacts, not bookkeeping

The earlier version of this repo kept a `phaseGates: Record<number, boolean>` and marked phase N−1 complete as a side effect of advancing into phase N. That made the ordering check pass when the corresponding documents did not exist — you could walk all twelve phases in ninety seconds against an empty directory.

`gateForPhase` now asks what is on disk. To enter phase N, every phase below N must have produced its artifacts, with real content:

```
$ /fleet:phase 7
⛔ Cannot advance to Phase 7 (ARCHITECTURE VERIFICATION). Gate blocked:
  · Phase 4 (MODULE BOUNDARIES): 05_MODULE_REGISTRY.md missing or empty
  · Phase 5 (DEPENDENCIES + EXTENSIONS): 07_DEPENDENCY_REGISTER.md missing or empty
  · Phase 6 (TOOLING + MIGRATION): 09_TOOLING_PLAN.md missing or empty
  · Phase 7 (ARCHITECTURE VERIFICATION): /fleet:verify has not produced a verdict
```

Contract freeze additionally requires a clean decision queue and an actual freeze record, and Phase 10 requires both.

## Verification is structural

The previous `fleet-verify` tested architecture by searching the markdown for strings:

```ts
const hasAltImpl = content.includes("Alternative implementation");
const hasSingleResp = (content.match(/responsibility/gi) || []).length <= 3;
```

`"Alternative implementation"` is emitted unconditionally by the writer, so that test was vacuous. The word count was a proxy for a concept. And the two registries serialize the same field with different labels and inverted polarity — `04_FORMAT_REGISTRY.md` writes `Storage hidden: ✅` while `06_INTERFACE_REGISTRY.md` writes `Storage technology exposed? ✅ No` — so every interface-registry assertion failed against a correctly written artifact.

The rewrite parses the registries back into structure and checks properties of the architecture:

- **Cross-reference integrity** — every `FMT-`/`MOD-`/`DEP-`/`EXT-` id referenced anywhere must resolve to a definition.
- **Acyclicity** — the module dependency graph is walked for cycles (`MOD-001 → MOD-002 → MOD-003 → MOD-001` is reported as such).
- **Implementation freedom** — each contract must withhold at least two of storage, vendor, and platform. Both label styles are normalized, including the inverted one.
- **Bounded modules** — a module with an empty `Owns` list has no state boundary and is rejected.
- **Isolation** — a dependency marked `adapterRequired` with no adapter is rejected.

`REJECT` is reachable and blocks the move to contract freeze. `PASS` / `PASS_WITH_CORRECTIONS` / `REJECT` are all persisted, and the last verdict is part of the Phase 9 gate.

```
🔍 Architecture Verification — REJECT
  10 target(s) · 42 test(s) · 3 failure(s) · 3 high-severity

  ✅ VRFY-FMT-001 — PASS
  ❌ VRFY-MOD-002 — REJECT
      · [high] Interface reference FMT-004 resolves: FMT-004 is required by MOD-002 but never defined
  ❌ VRFY-GRAPH — REJECT
      · [high] Dependency graph is acyclic: Cycles: MOD-001 → MOD-002 → MOD-003 → MOD-001

  Phase 9 is blocked until the high-severity findings above are fixed and re-verified.
```

## Tools and commands

Every phase operation exists twice: as a slash **command** for the human, and as a **tool** the model can call on its own judgement. Previously the workflow had commands only, which meant the model could not advance the state machine at all — a human had to type every transition.

| Command | Tool |
|---|---|
| `/fleet:status` | `fleet_status` |
| `/fleet:phase <n>` | `fleet_advance_phase` |
| `/fleet:decision <id> <topic>` | `fleet_record_decision` |
| `/fleet:decision resolve <id> <opt>` | `fleet_resolve_decision` |
| `/fleet:contract-freeze` | `fleet_freeze_contracts` |
| `/fleet:add-req`, `/fleet:requirements` | `fleet_add_requirement` |
| `/fleet:add-risk`, `/fleet:risks` | `fleet_add_risk` |
| `/fleet:primitive` | `fleet_propose_primitive`, `fleet_select_primitive` |
| `/fleet:multiplicity` | `fleet_define_entity` |
| `/fleet:format`, `/fleet:contracts` | `fleet_define_contract`, `fleet_list_contracts` |
| `/fleet:modules`, `/fleet:mod-edit` | `fleet_define_module`, `fleet_edit_module`, `fleet_list_modules` |
| `/fleet:dependencies`, `/fleet:adapters` | `fleet_add_dependency`, `fleet_add_adapter`, `fleet_list_dependencies` |
| `/fleet:extensions`, `/fleet:exthosts` | `fleet_add_extension_point`, `fleet_add_host`, `fleet_list_extensions` |
| `/fleet:migration`, `/fleet:compat` | `fleet_add_migration_phase`, `fleet_add_compat_mapping`, `fleet_list_migration` |
| `/fleet:tooling`, `/fleet:harness` | `fleet_add_harness`, `fleet_list_tooling`, `fleet_untested_targets` |
| `/fleet:verify`, `/fleet:verify-mod` | `fleet_verify_architecture` |
| `/fleet:audit` | — |
| `/fleet:override <rule> <reason>` | — |

Operations are shared between the two surfaces: each extension exports the mutation as a plain function that both the interactive handler and the tool call, so the two cannot drift.

## The extensions

| File | Phase | Responsibility |
|---|---|---|
| `fleet-core.ts` | — | Phase table, artifact/phase contract, canonical store, gate evaluation, write gate, registry parser. Everything else imports from here. |
| `fleet-orchestrator.ts` | 0, 9 | Job init, phase transitions, decision queue, contract freeze, audit |
| `fleet-requirements.ts` | 1 | Functional/non-functional requirements, risk register |
| `fleet-primitive.ts` | 2 | System primitive, entity multiplicity |
| `fleet-format.ts` | 3 | Format and interface contracts with implementation-freedom flags |
| `fleet-module.ts` | 4 | Module boundaries, ownership, dependency graph |
| `fleet-dependency.ts` | 5 | External dependency inventory and adapter isolation |
| `fleet-extension.ts` | 5b | Extension points and host integrations |
| `fleet-tooling.ts` | 6 | Test harnesses per module or contract |
| `fleet-migration.ts` | 6b | Migration phases, compatibility mappings |
| `fleet-verify.ts` | 7 | Structural verification |

### State

One canonical store, `architecture/fleet-state.json`, holding the job, decisions, phase, overrides, and every registry. Earlier versions scattered this across ten `*-state.json` blobs with `archPath`, `loadFleetState`, and `checkGate` copy-pasted into all ten files — which is how the gates drifted apart. On first load the old blobs are imported and left in place.

Markdown in `architecture/` is a rendered view of the store, not the source of truth. The registries are written by the `fleet_*` tools; hand-editing them is how you get a store and a document that disagree.

## Tests

```shell
node test/smoke.mjs
```

181 assertions covering the write gate, phase gates, freeze immutability, the decision queue, the shell classifier (including command substitution, pipe destinations, and the documented false positives that must *not* block), gate coverage, abort handling, session guards, rewind invalidation, and drift detection.

The suite catches dangling references, dependency cycles, and leaky contracts
each producing `REJECT` and each blocking the advance to Phase 8.

The test runs against a temporary workspace and needs `@sinclair/typebox` and `@earendil-works/pi-coding-agent` resolvable; under pi both are present.

## Limitations

Worth stating plainly.

- **The session guard can trap a user.** `session_before_switch` cancels when decisions are unresolved at Phase 8 or later. The only exit is `sessionGuards: false` below. Accepted as a rough edge, not solved.
- **The shell classifier is not a POSIX parser.** It handles quoting, the common separators, output redirection, command substitution, and pipe destinations; it does not expand here-docs or process substitution. Parse uncertainty fails open — except pipe-to-shell, which fails closed.
- **`bash script.sh` is not classified.** Only `bash -c '<command>'` and pipes into an interpreter count as remote execution.
- **The write gate covers the tools declared in `.pi/fleet-gate.json`**, default `write`, `edit`, `multi_edit`, `patch`, `bash`, `shell`. `fleet_gate_coverage` (or `/fleet:gate`) reports that list alongside what the gate *cannot* reach: writes by MCP servers, writes by subprocesses spawned by other extensions, and in-process mutation via `pi.exec`.
- **Verification reads the store**, so it validates what the `fleet_*` tools wrote. Hand-edited documents are not silently trusted — they surface as drift at `low` severity, which never contributes to `REJECT`.
- **Gate composition with other extensions is unverified.** If `damage-control` also blocks a call, whether both reasons surface or one wins was not tested here.
- **Single process.** Nothing in the fleet is long-running, so the abort signal prevents a half-finished write rather than interrupting work in flight.
- **`/fleet:phase` permits rewinds** below Phase 9. A rewind clears any verification verdict produced at or above the phase rewound to.

## Configuration

Optional. Absent file ⇒ defaults, which reproduce the ungated behaviour of an earlier release.

```json
// .pi/fleet-gate.json
{
  "enabled": true,
  "writeTools": ["write", "edit", "multi_edit", "patch", "apply_patch"],
  "shellTools": ["bash", "shell"],
  "extraMutatingCommands": { "terraform": ["apply", "destroy"] },
  "sessionGuards": true
}
```

## License

MIT