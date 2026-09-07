# pi-extensions — Fleet Architecture Execution System

10 pi extensions implementing the **Agent Fleet Architecture Execution System**. A phased, gate-checked workflow for designing software architecture using multiple specialized agents.

## Quick Install

```bash
# Drop into your project's pi extensions
cp fleet-*.ts ~/projects/your-project/.pi/extensions/

# Or global (all projects)
cp fleet-*.ts ~/.pi/agent/extensions/
```

Then `/reload` in pi to load them. All 22 commands become available.

## The 10 Extensions

| # | File | Phase | Commands | Output |
|---|---|---|---|---|
| 1 | `fleet-orchestrator.ts` | 0 — Job Init | `/fleet:new-job`, `/fleet:status`, `/fleet:phase`, `/fleet:decision`, `/fleet:contract-freeze` | `00_JOB.md`, `12_DECISION_REGISTER.md` |
| 2 | `fleet-requirements.ts` | 1 — Requirements & Risk | `/fleet:requirements`, `/fleet:risks`, `/fleet:add-req`, `/fleet:add-risk` | `01_REQUIREMENTS.md`, `02_RISK_REGISTER.md` |
| 3 | `fleet-primitive.ts` | 2 — Primitive | `/fleet:primitive`, `/fleet:multiplicity` | `03_PRIMITIVE.md` |
| 4 | `fleet-format.ts` | 3 — Format & Contract | `/fleet:format`, `/fleet:contracts` | `04_FORMAT_REGISTRY.md`, `06_INTERFACE_REGISTRY.md` |
| 5 | `fleet-module.ts` | 4 — Module Boundaries | `/fleet:modules`, `/fleet:mod-edit` | `05_MODULE_REGISTRY.md` |
| 6 | `fleet-dependency.ts` | 5 — Dependencies | `/fleet:dependencies`, `/fleet:adapters` | `07_DEPENDENCY_REGISTER.md` |
| 7 | `fleet-extension.ts` | 5b — Extensions | `/fleet:extensions`, `/fleet:exthosts` | `08_EXTENSION_REGISTRY.md` |
| 8 | `fleet-tooling.ts` | 6 — Tooling | `/fleet:tooling`, `/fleet:harness` | `09_TOOLING_PLAN.md` |
| 9 | `fleet-migration.ts` | 6b — Migration | `/fleet:migration`, `/fleet:compat` | `10_MIGRATION_PLAN.md` |
| 10 | `fleet-verify.ts` | 7 — Attack Review | `/fleet:verify`, `/fleet:verify-mod` | `11_VERIFICATION_PLAN.md` |

## Architecture

Extensions write proposals and analysis to an `architecture/` directory in your project root. They **never write code** — that's the Action Agent's job.

```
architecture/
├── 00_JOB.md
├── 01_REQUIREMENTS.md
├── 02_RISK_REGISTER.md
├── 03_PRIMITIVE.md
├── 04_FORMAT_REGISTRY.md
├── 05_MODULE_REGISTRY.md
├── 06_INTERFACE_REGISTRY.md
├── 07_DEPENDENCY_REGISTER.md
├── 08_EXTENSION_REGISTRY.md
├── 09_TOOLING_PLAN.md
├── 10_MIGRATION_PLAN.md
├── 11_VERIFICATION_PLAN.md
├── 12_DECISION_REGISTER.md
└── *-state.json          (internal state, gitignored)
```

## Workflow

Get started with the standard 11-phase sequence:

```bash
# Phase 0: Init
/fleet:new-job Build a distributed document pipeline
/fleet:phase 1

# Phase 1: Requirements + Risks
/fleet:requirements
/fleet:risks
/fleet:phase 2

# Phase 2: Primitive
/fleet:primitive
/fleet:phase 3

# Phase 3: Formats + Contracts
/fleet:format
/fleet:phase 4

# ... continue through Phase 11
```

## Decision Queue

When architecture choices need the Director:

```bash
/fleet:decision DEC-004 Storage-interface-boundary
/fleet:decision resolve DEC-004 Domain-level-API
```

Contract freeze is blocked until all decisions are resolved.

## Design Principles

- **Phase gates** prevent skipping — can't design modules before primitive is approved
- **Black-box modules** — one responsibility, documented interfaces, bounded state
- **Extraction over creation** — agents extract, propose, verify; they don't silently resolve choices
- **Replaceability** — every module should be swappable behind its contract
- **Observability** — all proposals, decisions, and verification results persist as markdown

## Requirements

- [pi](https://github.com/earendil-works/pi) v0.74+
- TypeScript (extensions are loaded via jiti, no compilation needed)

## License

MIT