# Marked changes — 0.3.0 candidate

Every known limitation and gap identified after 0.2.0, with a disposition.
Nothing here is speculative; each entry traces to a specific limitation
recorded in README.md or CHANGELOG.md.

## Taking into 0.3.0

| ID | Change | Traces to | Why now |
|---|---|---|---|
| **C1** | Replace the 7-pattern `MUTATING_BASH` regex list with a quote-aware shell tokenizer + command classifier | README "Bash inspection is a regex list, not a shell parser" | The gate's weakest surface, and it has both false negatives and false positives |
| **C2** | Verification reads the canonical store, not the rendered markdown; add store↔markdown drift detection | README "Verification reads the markdown… a hand-mangled registry is reported as missing rather than wrong" | The README already claims the store is truth and markdown is a view. Nothing enforces it. |
| **C3** | Session lifecycle guards: `session_before_switch` / `session_before_fork`, plus invalidate a stale verification verdict on rewind | README "Single process… does not abort in-flight work"; also a live bug (see D3) | A rewind currently leaves a stale PASS in place and the Phase 9 gate honours it |
| **C4** | Honour the tool `signal` so an aborted turn cannot persist state | README "does not abort in-flight work" | Low cost, removes a real hazard: abort between compute and `saveState` |
| **C5** | Explicit gate coverage: `.pi/fleet-gate.json` declaring gated tools and mutating commands, plus `fleet_gate_coverage` | README "The write gate covers `write`, `edit`… MCP not covered" | Coverage is currently buried in source. Make it declared, auditable, extensible. |

## Bug found during 0.3.0 design (not previously recorded)

| ID | Defect | Severity | Note |
|---|---|---|---|
| **D3** | Rewinding the phase leaves `state.verification` intact. `gateForPhase` only rejects `summary === "REJECT"`, so a stale `PASS` obtained before a rewind still satisfies the Phase 9 gate. | **High** | Same class as the 0.1.0 self-seeding defect: the gate trusts a value that no longer describes reality. Fixed by C3. |

## Explicitly out of scope for 0.3.0

| Item | Why out of scope |
|---|---|
| Subprocess / `--tools` jail | Would require spawning pi per role; that is a different architecture, not a hardening pass |
| MCP write coverage | Cannot be enforced from `tool_call` — an MCP server's writes are not tool calls in this process. C5 makes the gap *visible* instead of pretending otherwise |
| Gate composition with `damage-control` | Depends on pi's behaviour when two hooks block; needs an answer from upstream before code is worth writing |
| Merge 0.2.0 to `main` | Awaiting review |
| Language-tier doctrine exception for pi extensions | Director decision, not code |

## Out of scope but worth noting

`architecture/` is `.gitignore`d (workspace output). Any configuration a user
must commit — C5's gate config — therefore cannot live there. Called out
because it is an easy mistake and the spec review caught it.