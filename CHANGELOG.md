# Changelog

All notable changes to the Macro Architecture Fleet are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Release status.** All three versions are on `main`. Commits are the current
hashes; branch names are where each version was developed, and those branches
still exist.

| Version | On `main` | Developed on | Landed via |
|---|---|---|---|
| 0.1.0 | `926ecc9` | `main` | direct push (baseline) |
| 0.2.0 | `a1697ad` | `feat/enforced-phase-machine` | merge commit — PR #1 |
| 0.3.0 | `ce1da26` | `feat/gate-hardening` | direct push |

`main` is at `ce1da26`, clean, with 181 assertions passing. Two commits sit
unreleased on `fc/target-directory`: `9c4f0fb` (target as user input) and
`8cd4721` (typebox import specifier), taking the suite to 209 assertions.

Two notes on history. PR #1 merged as a no-content merge commit — `a1697ad`'s
tree is byte-identical to `a10c5fb`, its parent — so 0.3.0 could not fast-forward
onto it and was rebased instead. Its feature commits are therefore `57e44d0` and
`d6b4d05` on `main`, not the `0bb5fff` and `7006a71` on their branch. The rebase
changed history, not content: `git diff` before and after was empty.

---

## [Unreleased] — confinement toggles

**Branch:** `fc/target-directory` · **Tests:** 209 assertions, 0 failures

The target can be declared now, but a declaration alone is not a boundary.
Three policy decisions were being made implicitly by defaults rather than by
the user, so each became a toggle that ships in the strict position.

### Fixed

- **The extensions could not load in pi at all (High).** All ten files imported
  `{ Type }` from `@sinclair/typebox` — the pre-1.0 scoped name. pi ships
  `typebox@1.3.7` under the unscoped name, and its extension loader aliases
  exactly one spelling (`"typebox": _bundledTypebox`), which is also what pi's
  own docs, examples, and internal tools use. `@sinclair/typebox` is not in the
  alias table and this package declared no dependencies, so every module failed
  to resolve with `ERR_MODULE_NOT_FOUND`. The suite missed it because a
  hand-written stand-in package named `@sinclair/typebox` sat in `node_modules`;
  the harness invokes handlers directly and never inspects generated schemas,
  and `fleet-core.ts` — where all the gate logic lives — does not import
  typebox at all. Imports are now `from "typebox"`, matching the loader.
- **`outOfScope: "audit"` was unreachable from config.** `normalizeOutOfScope`
  returned the *default* for any value that was not literally `"block"`, so with
  the default flipped to `"block"` an explicit `"audit"` silently resolved to
  `"block"`. Harmless while the default was `"audit"`; a deny-by-default gate
  that cannot be loosened by configuration once the change landed.
- **`node_modules/` in `.gitignore`** did not match the symlink that was
  shadowing the stub, because a trailing slash matches directories only.

### Changed

- **`outOfScope` now defaults to `"block"`.** Previously an out-of-target write
  before the implementation phase was allowed and logged as `OUT-OF-SCOPE`.
  Refused by default now; `"audit"` is the deliberate opt-in. A boundary that
  records rather than refuses is a promise the agent can defer.
- **`requireDeclaredTarget` (default `true`).** A target inferred from cwd is
  flagged but no longer sufficient to write into. An unassigned agent has no
  business writing anywhere, and cwd is the one directory nobody chose.
- **`pinTarget` (default `true`).** `/fleet:target` and `fleet_set_target` are
  refused while a job exists. A pinned target is part of the job record;
  re-pointing it relocates the boundary underneath work already recorded
  against it. A second repository means a second agent.

### Added

- `docs/assignment-confinement.md` — the read half of confinement, recorded and
  deliberately unimplemented. Reads are not gated in any phase under any policy;
  an agent confined to one repository can still read the rest of the vault and
  fold it into the architecture, which no write gate can detect.
- `fleet_describe_target` now reports the resolved out-of-scope policy.

### Notes

- The three toggles live in `.pi/fleet-gate.json` — "how hard to enforce".
  `fleet-target.json` keeps "what to enforce it over". All three ship strict.
- Tests declare a real target in the fixture, so the suite exercises the
  shipping configuration rather than an inferred one.

---

## [Unreleased] — target directory

**Branch:** `fc/target-directory` · **Tests:** 198 assertions, 0 failures (up from 181)

`architecture/` is now a directory inside the system being architected, and the
target is a user input rather than an assumption.

### Fixed

- **The gate governed whatever tree pi was launched in (High).** `cwd()` returned
  `process.cwd()` and stood in for the target. Two consequences: the gate locked
  down a tree the user never named, and because `evaluateWriteGate` refused every
  write *outside* `architecture/`, launching pi in `$HOME` silently placed an
  entire home directory under phase lock. Same class as the 0.1.0 self-seeding
  and 0.3.0 stale-verdict defects: the gate trusting a value that does not
  describe what the user meant. The target is now resolved from `FLEET_TARGET`,
  `.pi/fleet-target.json`, or the job's pinned target, with a cwd fallback that
  is always flagged `inferred` and surfaced by `fleet_describe_target`.
- **Scope is now the target, not the artifact directory.** The gate's question
  changes from "is this write outside `architecture/`?" to "is this write inside
  the project being architected?" — so pointing a job at another tree no longer
  gates the old one and leaves the new one open. `archDir` is configurable too.
- **Phase brief said `architecture/` when the target was elsewhere.** The brief
  and the gate's block reasons now name the resolved target and artifact path.
- **`phaseBrief` never announced frozen contracts.** `phase.currentPhase` read a
  property that `PhaseDef` does not have, so the guard was always `undefined`
  and the frozen-contracts reminder never fired. (`state.currentPhase` was meant.)

### Added

- `/fleet:target [path] [archDir]`, `fleet_set_target`, `fleet_describe_target`.
- `outOfScope` policy: `audit` (default — out-of-target writes are allowed and
  logged as `OUT-OF-SCOPE`) or `block` (the previous conservative reading).
- 17 assertions covering target resolution, artifact gating inside a retargeted
  job, and both out-of-scope policies.

### Notes

- Narrowing the gate's reach is itself a change in what the gate promises, so it
  is declared in `fleet_gate_coverage`'s `unenforced` list rather than left to be
  discovered.
- `fleet:new-job` now asks for the target before writing anything and pins it into
  the store, so the target cannot drift onto another tree mid-job.

---

## [0.3.0] — 2026-10-03

**On `main`:** `ce1da26` (tip) · **Feature commits:** `57e44d0`, `d6b4d05`
**Tests:** 181 assertions, 0 failures (up from 107)

Hardening pass on the 0.2.0 enforcement layer. No new workflow, no new phases.

### Fixed

- **D3 — a stale verdict satisfied the Phase 9 gate (High).** Rewinding the phase
  left `state.verification` intact, and `gateForPhase` accepts a `PASS` from any
  previous run. A verdict obtained *before* the rewind therefore still unblocked
  contract freeze. Same class as the 0.1.0 self-seeding defect: the gate trusting
  a value that no longer describes reality. Verdicts now record the phase at run
  time and a rewind below that phase clears them. **Not configurable** — a switch
  that reopens a High defect is not a switch.
- **Shell tokenizer produced empty argument vectors.** `argv[argv.length - 1]`
  on an empty array writes to index `-1`, so no token was ever pushed and every
  command classified as a non-command. Caught by the new test suite; the gate was
  silently allowing mutations for the duration of the defect.
- **Interleaved wrappers and env assignments were not skipped.** `env FOO=1 rm -rf /x`
  resolved `FOO=1` as the command name.
- **git subcommand detection missed value-taking options.** `git -C /repo commit`
  resolved to `-C` rather than `commit`.
- **Drift detection reported false positives** against `06_INTERFACE_REGISTRY.md`
  (a deliberately filtered rendering of the same registry) and against adapter
  blocks inside `07_DEPENDENCY_REGISTER.md`.
- **The `piped` flag marked the pipe *source*, not the destination.** The field
  is documented as "target of a pipe" and the code did the opposite, which made
  the pipe-to-shell rule dead code — `cat s.sh | bash` was allowed. The
  curl/wget rule only appeared to work because it inspected the source.
- **Command substitution was not tokenized.** `SEPARATORS` contained no `$(`,
  backtick or `)`, so `echo $(git commit -m x)` produced a single token `$(git`
  and passed the gate. Six false negatives across `$( )`, backticks, nested
  substitution, assignment-from-substitution, and `bash -c '<command>'`.
- **`bash -c '<command>'` was not classified.** The quoted payload became
  separate tokens and resolved to the interpreter's name, which matched nothing.
- **Pipe-to-shell required `argv.length === 1`**, missing `cat s.sh | bash -s`
  and `cat s.sh | sh -s -- --flag`.

### Added

- **C1 — quote-aware shell tokenizer and command classifier** replacing the
  seven-pattern regex list. Classifies by command name plus argument inspection,
  case-sensitively, against a basename — so `echo "git commit"` and
  `grep -r "rm -rf" .` no longer block, while `/usr/bin/git commit` still does.
  Covers vcs mutations, destructive filesystem operations, output redirection,
  package managers, and pipe-to-shell. Parse uncertainty fails open **except**
  where a pipe targets a shell interpreter.
- **C3 — session guards.** `session_before_switch` cancels when decisions are
  unresolved at Phase 8 or later; allowed and audited below that. Fork is never
  blocked, since it copies.
- **C5 — declared gate coverage** at `.pi/fleet-gate.json`, with 0.2.0 behaviour
  as the default. Adds `fleet_gate_coverage` tool and `/fleet:gate` command,
  which report what the gate reaches and — more usefully — what it cannot:
  MCP writes, subprocesses spawned by other extensions, and in-process
  mutation via `pi.exec`.
- **C2 — store-sourced verification.** Verification now reads the canonical
  store rather than re-parsing the rendered markdown. `detectDrift` reports
  store ↔ document divergence as its own finding kind at `low` severity, which
  never contributes to `REJECT`.

### Changed

- **C4 — all 29 tools honour the abort signal.** Nothing in the fleet is
  long-running, so this removes a correctness hazard (a turn aborted between
  computation and `saveState` could still persist) rather than making anything
  interruptible.
- **Command substitution and pipe destinations are now classified.** `$( … )`
  and backticks are recursively tokenized and their inner commands classified as
  their own segments, because anything that mutates inside a substitution mutates
  exactly as if it had been typed directly. `${…}` is variable expansion, not a
  command. A pipe is remote execution when its *destination* is a shell
  interpreter, regardless of source or of flags on the interpreter — so
  `make | sh` and `cat s.sh | bash -s` block while `curl x | jq .` does not.
  The curl/wget "piped onward" rule was removed: it inspected the wrong side of
  the pipe and would have blocked ordinary pipelines once the flag was corrected.

### Known limitations

- The session guard can trap a user who genuinely wants to switch sessions
  mid-decision at Phase 8+. `sessionGuards: false` is the only exit.
  Accepted as a rough edge, documented rather than solved.
- The shell tokenizer is not a full POSIX parser. It handles quoting, the common
  separators, redirection, command substitution, and pipe destinations; it does
  not expand here-docs or process substitution (`<(…)`, `>(…)`). Unbalanced
  quoting fails open.
- A shell interpreter invoked as `bash script.sh` is not classified — only
  `bash -c '<command>'` and pipes into an interpreter are. Running an arbitrary
  script is not treated as mutation.
- Gate coverage of non-tool write paths (MCP, foreign subprocesses) remains
  out of reach from `tool_call`. C5 makes the gap visible instead of implicit.
- Gate composition with other extensions that also return a `tool_call` verdict
  is still unverified.

### Tests

`node test/smoke.mjs` — **181 assertions, 0 failures**, up from 107.

New coverage: 40 tokenizer/classifier cases including the documented false
positives that must *not* block, plus command substitution and pipe-destination
forms; 7 gate-coverage, 3 abort, 6 session-guard, 8 rewind-invalidation, and
7 drift assertions. All 107 0.2.0 assertions remain green, including every
REJECT path.

Eight defects in this release's own code were found by the suite or by
pre-merge probing — three in C1 (empty argv vectors, unskipped interleaved
wrappers, missed git value-taking flags) and two more from the reviewer's
probes (mis-flagged pipe destination, unhandled command substitution).

---

## [0.2.0] — 2026-10-03

**On `main`:** `a1697ad` (merge commit, PR #1) · **Feature commit:** `39048ee`

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

[0.3.0]: https://github.com/Steven-Shelton-Creator/pi-extensions/compare/926ecc9...ce1da26
[0.2.0]: https://github.com/Steven-Shelton-Creator/pi-extensions/compare/926ecc9...a1697ad
[0.1.0]: https://github.com/Steven-Shelton-Creator/pi-extensions/releases/tag/db22a80