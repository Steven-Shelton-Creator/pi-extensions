# Changelog

All notable changes to the Macro Architecture Fleet are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.2.0] — 2026-10-03

**Branch:** `feat/enforced-phase-machine` · **Commit:** `39048ee`

The rewrite that made the fleet's claims true. The previous release documented a
phase machine, a decision queue, and an architecture verifier. None of the three
could stop an agent from doing the wrong thing, because all three were
implemented as prompts and self-set booleans rather than as enforcement.

**Diff:** 16 files, +3857 / −2455.

### Added

#### Enforcement

- **`fleet-core.ts` (new, 586 lines)** — the single source of truth for the phase
  table, the artifact/phase contract, the canonical store, gate evaluation, the
  write gate, and the registry parser. Every other extension imports from here.
- **`evaluateWriteGate()` + `installEnforcement()`** — a `tool_call` hook
  returning `{ block: true, reason }`. No extension in the previous release
  registered `tool_call` at all.
- **Phase-scoped artifact writes.** Writing `05_MODULE_REGISTRY.md` (Phase 4)
  at Phase 0 is refused; the reason names the owning phase.
- **Implementation gate.** Any `write`/`edit` outside `architecture/` is refused
  until Phase 10 (CONTRACT FREEZE).
- **Mutating-bash gate.** `git commit`, `rm -r`, `npm install`, `cargo add`,
  `go get`, `pip install`, `curl … | sh` refused before Phase 10.
- **Freeze immutability.** After `/fleet:contract-freeze`, design artifacts
  cannot be written, at Phase 9 or beyond.
- **`audit()`** — every phase advance, decision, freeze, and *block* appended to
  `architecture/fleet-audit.log`.
- **`/fleet:override <rule> <reason>`** — records a deliberate gate bypass in
  `architecture/fleet-overrides.json` rather than leaving it unlogged.

#### Tools

27 `registerTool` calls added; the previous release had **zero**. Every phase
operation now exists on both surfaces — a slash command for the human, a tool
for the model:

| Tool | Purpose |
|---|---|
| `fleet_status` | Read phase, artifacts, decision queue, blockers |
| `fleet_advance_phase` | Gated phase transition |
| `fleet_record_decision` / `fleet_resolve_decision` | Decision queue |
| `fleet_freeze_contracts` | Contract freeze |
| `fleet_add_requirement` / `fleet_add_risk` | Phase 1 |
| `fleet_propose_primitive` / `fleet_select_primitive` / `fleet_define_entity` | Phase 2 |
| `fleet_define_contract` / `fleet_list_contracts` | Phase 3 |
| `fleet_define_module` / `fleet_edit_module` / `fleet_list_modules` | Phase 4 |
| `fleet_add_dependency` / `fleet_add_adapter` / `fleet_list_dependencies` | Phase 5 |
| `fleet_add_extension_point` / `fleet_add_host` / `fleet_list_extensions` | Phase 5b |
| `fleet_add_harness` / `fleet_list_tooling` / `fleet_untested_targets` | Phase 6 |
| `fleet_add_migration_phase` / `fleet_add_compat_mapping` / `fleet_list_migration` | Phase 6b |
| `fleet_verify_architecture` | Phase 7 |

Operations were extracted into exported functions shared by the command handler
and the tool, so the two surfaces cannot drift.

#### Verification

- **Cross-reference integrity** — every `FMT-`/`MOD-`/`DEP-`/`EXT-` id referenced
  anywhere must resolve to a definition. Dangling references are high severity.
- **Dependency cycle detection** — iterative DFS with a colour map over the
  module graph; cycles reported with their full path.
- **Implementation freedom** — each contract must withhold at least two of
  storage, vendor, and platform, evaluated system-wide.
- **Bounded module state** — a module with an empty `Owns` list has no state
  boundary and is rejected.
- **Dependency isolation** — a dependency marked `adapterRequired` with no
  adapter is rejected.
- **`REJECT` verdict made reachable.** Previously
  `summary = tests.every(passed) ? "PASS" : "PASS_WITH_CORRECTIONS"` — the
  `REJECT` branch existed in the type union and was counted in the summary
  block, but was unreachable.
- **`parseRegistry()`** — reads registries back into structure (ids, fields,
  bullet lists, sections) so verification inspects the architecture rather than
  searching text.

#### Structure

- **`LICENSE`** — the README claimed MIT; no LICENSE file existed.
- **`package.json`** — `type: module`, zero dependencies, no build step.
- **`test/smoke.mjs`** — 107 assertions (see below).

### Changed

- **`gateForPhase` evaluates artifacts, not bookkeeping.** It now requires each
  prior phase's documents to exist on disk with substantive content, a
  verification verdict that is not `REJECT`, a clear decision queue, and — for
  Phase 10 — an actual freeze record.
- **Verification verdict joins the Phase 9 gate.** Contracts could previously be
  frozen without ever running verification.
- **Decision queue gates Phase 9+.** Previously only case 9, which phases 10 and
  11 ignored.
- **Canonical store.** Ten scattered `*-state.json` blobs replaced by
  `architecture/fleet-state.json`, with a one-time import of the legacy blobs
  (left on disk, not deleted).
- **`phaseBrief()` injected at `before_agent_start`** in every extension, so
  current phase and blockers are injected rather than requested.
- **`artifactSatisfied()` rejects `*No … yet.*` placeholders** — an empty
  registry is not a produced registry.
- **Domain invariants tightened:** a migration phase without a rollback plan is
  refused; an entity permitting none of zero/one/many is refused; an extension
  point without a host is refused; a host without an adapter interface is refused;
  an adapter without a target interface is refused; a contract without semantics
  is refused; a module without a responsibility is refused.

### Fixed

- **Self-seeding gate (`fleet-orchestrator.ts:358`).** `if (target > 0)
  state.phaseGates[target - 1] = true` marked the previous phase complete as a
  side effect of advancing into the next. The ordering check therefore passed
  when the corresponding documents did not exist — all twelve phases could be
  walked in ninety seconds against an empty directory.
- **Inverted interface-registry assertions.** `04_FORMAT_REGISTRY.md` renders
  `Storage hidden: ✅` while `06_INTERFACE_REGISTRY.md` renders
  `Storage technology exposed? ✅ No`. The old verifier searched for the first
  form in both files, so **every implementation-freedom test against the
  interface registry failed on a correctly written artifact.**
- **Vacuous verification test.** `content.includes("Alternative implementation")`
  — the writer emits that string unconditionally, so the test could not fail.
- **Proxy verification test.**
  `(content.match(/responsibility/gi) || []).length <= 3` counted word
  occurrences as a stand-in for single responsibility.
- **`REJECT` counted but unreachable** — see Added.
- **Module-global state leak (`fleet-verify.ts`).** `let results = []` at module
  scope leaked verification results across sessions.
- **CJS `require("node:path")` inline** inside an ESM extension.
- **Duplicated helpers.** `archPath`, `ensureArchDir`, `loadFleetState`, and
  `checkGate` were copy-pasted into all ten extensions with divergent behaviour.
  That duplication is how the gates drifted apart; `checkGate` in particular had
  a different rule in `fleet-verify` than in the extensions it was copied from.
- **`.gitignore` malformed.** The tracked file lacked a trailing newline, so any
  append merged into the previous line (`*.swonode_modules/`).

### Known limitations

Documented in the README rather than hidden:

- Bash inspection is a regex list, not a shell parser.
- The write gate covers `write`, `edit`, `multi_edit`, `patch`, `bash`, `shell`.
  Writes via MCP servers or foreign subprocesses are not covered.
- Verification reads the markdown, so it validates what the writers emit; a
  hand-mangled registry that does not match the emitted shape is reported as
  missing rather than wrong.
- Gate composition with other extensions (e.g. `damage-control`) is unverified.
- No subprocess isolation; the write gate does not abort in-flight work.
- `/fleet:phase` permits rewind below Phase 9; frozen contracts block rewind.

### Tests

`node test/smoke.mjs` — **107 assertions, 0 failures**, in a temporary workspace.

Coverage: write gate (5 paths), phase gates, freeze immutability, decision queue,
audit trail, interface-registry label normalization, and each verifier REJECT
path (dangling reference, dependency cycle, leaky contract) including that each
blocks the advance to Phase 8.

The suite found four real defects during development, all fixed: a crash reading
adapters from the store, an `---` rule leaking into parsed section text,
`Alternative implementation` never parsed in the format registry, and duplicate
contract result IDs across the two registries.

---

## [0.1.0] — 2026-09-07

**Commits:** `db22a80`, `926ecc9`

Initial release: ten extensions, 25 slash commands, a 12-phase state machine
persisted to `architecture/fleet-state.json` plus `pi.appendEntry()`, a decision
register, and a Phase 7 attack review.

### Added

- `fleet-orchestrator` — job init, phase transitions, decision queue, contract
  freeze.
- `fleet-requirements` / `fleet-primitive` / `fleet-format` / `fleet-module` —
  Phases 1–4 registries.
- `fleet-dependency` / `fleet-extension` / `fleet-tooling` / `fleet-migration` —
  Phases 5–6 registries.
- `fleet-verify` — attack review across published artifacts.
- Phase gate evaluation, artifact writers, per-extension state persistence.

### Known limitations at this release

Recorded retrospectively; all were addressed in 0.2.0 except where noted.

- No `tool_call` hook and no write gate. Phase order was advisory.
- `phaseGates[]` self-seeding (see 0.2.0 Fixed).
- Gate evaluation did not inspect artifacts on disk.
- Verification was string-matching, not structural (see 0.2.0 Fixed).
- `REJECT` verdict unreachable.
- Zero registered tools; the model could not advance the state machine.
- State fragmented across ten JSON files with duplicated helpers.
- Verification state leaked across sessions via module-global variable.
- No LICENSE file despite an MIT claim in the README.
- No tests.

[0.2.0]: https://github.com/Steven-Shelton-Creator/pi-extensions/compare/926ecc9...39048ee
[0.1.0]: https://github.com/Steven-Shelton-Creator/pi-extensions/releases/tag/db22a80