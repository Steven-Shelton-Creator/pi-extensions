# Assignment confinement — read scope is undecided

**Status:** deferred, no code. Recorded 2026-10-03 so the question survives the
session. Nothing in this document is implemented.

## The invariant

One agent, one assigned repository. The target is a user input, never an
assumption. Multi-repository work means more agents, never a wider gate.

Confinement has two halves, and only one is built:

| half | status |
|---|---|
| **writes** outside the target | enforced — `evaluateWriteGate` |
| **reads** outside the target | **not enforced** |

## The hole

`installEnforcement` subscribes to `tool_call` and consults only
`writeTools` and `shellTools`. Read-shaped tools are never examined, in any
phase, under any policy. The README states this outright: *"Reads are never
gated."*

So an agent confined to `/home/steven/projects/foo` can still read
`/home/steven/brain/`, a sibling repository, `AGENTS.md`, or anything else
reachable under the vault, and fold what it finds into the architecture.

This is the more serious half. The write gate protects the target's contents;
the read gap contaminates the target's *architecture*. An architecture derived
from material outside the project it describes is not an architecture of that
project — it is a plausible-looking document assembled partly from unrelated
context. The write gate cannot detect this, because every write is in bounds.

## Why it was not simply added

The read surface is not one shape. Path extraction already varies per tool —
`targetPathOf` handles `file_path`, `path`, and `notebook_path` — and some read
tools carry no path at all:

- `read`, `edit`-adjacent readers — single `file_path`
- `grep`, `glob` — recursive, `path` may be a directory
- `list` / `ls` — directory enumeration
- `web_fetch`, `mcp__*` — no local path; the "target" question does not apply
- `bash` — already handled, but as a *command classifier*, not a path check

Blocking `read` but not `grep` would produce an incoherent boundary. Blocking
all of them means deciding what `web_fetch` means for a confined agent — and
that question has a doctrine answer already: *other agents scout and fetch;
this agent builds.* Whether fetch belongs inside or outside the confinement is
a policy call, not an implementation detail.

## Open questions for the Director

1. **Is the boundary filesystem-only, or does it include the network?** If the
   agent is confined to one repository, `web_fetch` is an escape hatch that no
   path check can close. If fetch stays open, the invariant is "confined writes,
   confined local reads" — narrower than the doctrine as stated.
2. **Does a read violation block, or record?** The write gate blocks by default.
   Reads are cheap and often exploratory; blocking them may strand an agent that
   legitimately needs to look at a file inside the target. A read *outside* the
   target is a different proposition from a read inside it.
3. **What about subagents and MCP servers?** Already listed in
   `fleet_gate_coverage`'s `unenforced` for writes ("writes issued by MCP
   servers", "writes by subprocesses spawned by other extensions"). The same
   escape applies to reads and is at least as wide — a subagent reads whatever
   it likes and reports back prose.
4. **Is a coarse allowlist enough?** The practical version may be "reads are
   unconstrained inside the target, refused outside" plus an explicit
   `readPaths` escape hatch for the few legitimate cross-tree reads.

## What a toggle would look like, if it is built

`fleet-gate.json` already holds "how hard to enforce"; `fleet-target.json`
holds "what to enforce it over". Read scope belongs in the first:

```jsonc
{
  "readTools": ["read", "grep", "glob", "list"],
  "readScope": "target",      // "off" | "target" | "strict"
  "readPaths": [],            // explicit carve-outs, e.g. a shared spec repo
  "allowNetworkRead": false
}
```

Default should be `off`, matching today's behaviour, so enabling the extension
does not silently strand an agent mid-job — the same reasoning behind
`sessionGuards` defaulting to `true` only for the unrecoverable case.