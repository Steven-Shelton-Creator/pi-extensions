/**
 * Functional smoke test for the Macro Architecture Fleet extensions.
 *
 * Exercises the enforcement layer end to end: phase gates, the tool_call write
 * gate, contract freeze, and the structural verifier (including the two
 * conflicting label styles the old verifier could not reconcile).
 *
 * Run from the repo root:  node test/smoke.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

// ─── Harness ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗ ${name}\x1b[0m ${detail}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

function makePi() {
  const tools = {};
  const commands = {};
  const hooks = {};
  return {
    tools, commands, hooks,
    registerTool(def) { tools[def.name] = def; },
    registerCommand(name, def) { commands[name] = def; },
    on(event, fn) { (hooks[event] ||= []).push(fn); },
  };
}

function makeCtx(cwd) {
  const notices = [];
  return {
    notices,
    cwd,
    model: { id: "test-model", provider: "test" },
    getSystemPrompt: () => "base system prompt",
    getContextUsage: () => ({ percent: 10 }),
    ui: {
      notify: (msg, level) => notices.push({ msg, level }),
      confirm: async () => true,
      input: async () => "",
    },
  };
}

/** Fire every registered tool_call hook and return the first block verdict. */
async function runWriteGate(pi, ctx, toolName, input) {
  for (const fn of pi.hooks["tool_call"] || []) {
    const verdict = await fn({ toolName, input }, ctx);
    if (verdict && verdict.block) return verdict;
  }
  return null;
}

async function callTool(pi, name, params, ctx, signal) {
  const tool = pi.tools[name];
  if (!tool) throw new Error(`tool not registered: ${name}`);
  const res = await tool.execute("test-call", params, signal, undefined, ctx);
  const text = res.content?.[0]?.text ?? "";
  return { text, details: res.details ?? {} };
}

// ─── Workspace ───────────────────────────────────────────────────────────────

const workdir = mkdtempSync(join(tmpdir(), "fleet-test-"));
process.chdir(workdir);
const ctx = makeCtx(workdir);

section("Loading extensions");

const MODULES = [
  "fleet-core", "fleet-orchestrator", "fleet-requirements", "fleet-primitive",
  "fleet-format", "fleet-module", "fleet-dependency", "fleet-extension",
  "fleet-migration", "fleet-tooling", "fleet-verify",
];

const loaded = {};
for (const m of MODULES) {
  const mod = await import(pathToFileURL(join(ROOT, `${m}.ts`)).href);
  loaded[m] = mod;
  check(`${m}.ts imports`, typeof mod === "object");
}

const core = loaded["fleet-core"];
const detectDriftOf = (s) => loaded["fleet-verify"].detectDrift(s);

const pi = makePi();
for (const m of MODULES.filter((x) => x !== "fleet-core")) {
  const ext = loaded[m].default;
  check(`${m} exports a default factory`, typeof ext === "function");
  if (typeof ext === "function") ext(pi);
}

section("Tool surface");

const EXPECTED_TOOLS = [
  "fleet_status", "fleet_advance_phase", "fleet_record_decision", "fleet_resolve_decision",
  "fleet_freeze_contracts", "fleet_add_requirement", "fleet_add_risk",
  "fleet_propose_primitive", "fleet_select_primitive", "fleet_define_entity",
  "fleet_define_contract", "fleet_list_contracts",
  "fleet_define_module", "fleet_edit_module", "fleet_list_modules",
  "fleet_add_dependency", "fleet_add_adapter", "fleet_list_dependencies",
  "fleet_add_extension_point", "fleet_add_host", "fleet_list_extensions",
  "fleet_add_migration_phase", "fleet_add_compat_mapping", "fleet_list_migration",
  "fleet_add_harness", "fleet_untested_targets", "fleet_list_tooling",
  "fleet_verify_architecture",
];
for (const t of EXPECTED_TOOLS) {
  check(`tool ${t} registered`, !!pi.tools[t]);
}
check("write gate installed", (pi.hooks["tool_call"] || []).length > 0,
  `hooks: ${JSON.stringify(Object.keys(pi.hooks))}`);

section("Phase gate with no job");

{
  const r = await callTool(pi, "fleet_advance_phase", { phase: 1 }, ctx);
  check("advance refused without a job", !r.details.ok, r.text);
}

// ─── Build a job ─────────────────────────────────────────────────────────────

section("Job definition (Phase 0)");

mkdirSync(join(workdir, "architecture"), { recursive: true });
const state = loaded["fleet-core"].loadState();
state.job.objective = "Build a durable ingestion pipeline";
state.job.scope = ["ingest", "store", "query"];
state.job.non_goals = ["web UI"];
state.job.source_material = ["spec.md"];
state.job.known_constraints = ["FOSS only"];
loaded["fleet-core"].saveState(state);

// Write the job artifact the way the extension does.
writeFileSync(
  join(workdir, "architecture", "00_JOB.md"),
  `# Architecture Job: ${state.job.objective}\n\n## Objective\n${state.job.objective}\n\n## Scope\n- ingest\n- store\n- query\n`,
  "utf8"
);

{
  const status = await callTool(pi, "fleet_status", {}, ctx);
  check("status reads the job", status.text.includes("durable ingestion"), status.text.slice(0, 80));
  check("phase 0 artifact detected", status.text.includes("✅ [P0] 00_JOB.md"));
}

// ─── Write gate ──────────────────────────────────────────────────────────────

section("Write gate");

{
  const blocked = await runWriteGate(pi, ctx, "write", {
    file_path: join(workdir, "architecture", "05_MODULE_REGISTRY.md"),
    content: "## MOD-001 — Thing",
  });
  check("phase-4 artifact refused at phase 0", !!blocked, "expected a block");
  check("  reason names the owning phase", /belongs to Phase 4/.test(blocked?.reason || ""), blocked?.reason);
}

{
  const blocked = await runWriteGate(pi, ctx, "write", {
    file_path: join(workdir, "src", "index.ts"),
    content: "export const x = 1;",
  });
  check("implementation write refused before freeze", !!blocked, "expected a block");
  check("  reason mentions CONTRACT FREEZE", /CONTRACT FREEZE/.test(blocked?.reason || ""), blocked?.reason);
}

{
  const allowed = await runWriteGate(pi, ctx, "write", { file_path: join(workdir, "README.md") });
  check("blocked until phase 0 artifact is written — README also gated", !!allowed);
}

{
  const blocked = await runWriteGate(pi, ctx, "bash", { command: "git commit -m 'wip'" });
  check("mutating bash refused before implementation", !!blocked, "expected a block");
}

{
  const allowed = await runWriteGate(pi, ctx, "read", { file_path: join(workdir, "README.md") });
  check("reads are never gated", !allowed, JSON.stringify(allowed));
}

{
  const blocked = await runWriteGate(pi, ctx, "bash", { command: "ls -la" });
  check("read-only bash is allowed", !blocked, JSON.stringify(blocked));
}

section("Advance blocked without artifacts");

{
  // Phase 0's artifact exists, so Phase 1 is legitimately open. Phase 2 is not.
  const r = await callTool(pi, "fleet_advance_phase", { phase: 2 }, ctx);
  check("advance past an empty phase refused", !r.details.ok, r.text);
  check("  blocker names the missing file", /01_REQUIREMENTS\.md/.test(r.text), r.text);
}

// ─── Phase 1 ─────────────────────────────────────────────────────────────────

section("Phase 1 — requirements and risks");

{
  const r = await callTool(pi, "fleet_add_requirement", {
    description: "Ingest must tolerate 10k events/second",
    type: "functional", category: "throughput", priority: "critical",
  }, ctx);
  check("requirement recorded", r.details.ok, r.text);
}

{
  const r = await callTool(pi, "fleet_add_risk", {
    title: "Broker outage", likelihood: "medium", impact: "high",
    mitigation: "Local queue with replay",
  }, ctx);
  check("risk recorded", r.details.ok, r.text);
}

{
  const r = await callTool(pi, "fleet_advance_phase", { phase: 1 }, ctx);
  check("advance to phase 1 succeeds", r.details.ok, r.text);
}

// ─── Phase 2 ─────────────────────────────────────────────────────────────────

section("Phase 2 — primitive");

{
  await callTool(pi, "fleet_propose_primitive", {
    name: "Event", meaning: "An immutable fact that happened once",
    operations: ["append", "query"], invariants: ["append is idempotent on eventId"],
    advantages: ["Replayable"], limitations: ["No mutation"],
  }, ctx);
  await callTool(pi, "fleet_propose_primitive", {
    name: "Document", meaning: "A mutable aggregate",
    operations: ["read", "write"], advantages: ["Familiar"], limitations: ["No replay"],
  }, ctx);
  const r = await callTool(pi, "fleet_select_primitive", { name: "Event" }, ctx);
  check("primitive selected", r.details.ok, r.text);
}
{
  const r = await callTool(pi, "fleet_advance_phase", { phase: 2 }, ctx);
  check("advance to phase 2 succeeds", r.details.ok, r.text);
}

// ─── Phase 3 — contracts ─────────────────────────────────────────────────────

section("Phase 3 — contracts");

{
  const bad = await callTool(pi, "fleet_define_contract", { name: "Nameless" }, ctx);
  check("contract without semantics refused", !bad.details.ok, bad.text);

  await callTool(pi, "fleet_define_contract", {
    name: "EventEnvelope", semantics: "The wire shape of a stored event",
    type: "interface", structure: "{ eventId, type, payload }",
    invariants: "eventId is globally unique", consumers: ["MOD-002"], producers: ["MOD-001"],
  }, ctx);
  await callTool(pi, "fleet_define_contract", {
    name: "StoreQuery", semantics: "How stored events are read back",
    type: "interface", structure: "{ filter, limit }",
    invariants: "limit is bounded", consumers: ["MOD-003"],
  }, ctx);

  const r = await callTool(pi, "fleet_advance_phase", { phase: 3 }, ctx);
  check("advance to phase 3 succeeds", r.details.ok, r.text);
}

// ─── Phase 4 — modules ───────────────────────────────────────────────────────

section("Phase 4 — modules");

{
  const bad = await callTool(pi, "fleet_define_module", { name: "Ghost" }, ctx);
  check("module without responsibility refused", !bad.details.ok, bad.text);

  await callTool(pi, "fleet_define_module", {
    name: "Ingest", responsibility: "Accept and durably append events",
    owns: ["ingest buffer"], doesNotOwn: ["event persistence", "query planning"],
    consumesInterfaces: [], exposesInterfaces: ["FMT-001"],
    testStrategy: "Unit tests over the buffer plus a replay fixture",
  }, ctx);
  await callTool(pi, "fleet_define_module", {
    name: "Store", responsibility: "Persist and retrieve events",
    owns: ["event log"], doesNotOwn: ["transport", "ingest validation"],
    consumesInterfaces: ["FMT-001", "FMT-002"],
    exposesInterfaces: ["FMT-002"], testStrategy: "Integration against a real store",
  }, ctx);
  await callTool(pi, "fleet_define_module", {
    name: "Query", responsibility: "Answer read requests",
    owns: ["query planner"], doesNotOwn: ["event writes"],
    consumesInterfaces: ["FMT-002"],
    exposesInterfaces: [], testStrategy: "Golden-file query tests",
  }, ctx);

  const r = await callTool(pi, "fleet_advance_phase", { phase: 4 }, ctx);
  check("advance to phase 4 succeeds", r.details.ok, r.text);
}

// ─── Phases 5 & 6 ────────────────────────────────────────────────────────────

section("Phase 5 — dependencies, extensions, tooling");

{
  await callTool(pi, "fleet_add_dependency", {
    name: "NATS", category: "transport", version: "2.10", usedBy: ["MOD-001"],
    adapterRequired: true, riskLevel: "medium",
  }, ctx);
  await callTool(pi, "fleet_add_adapter", {
    name: "NatsAdapter", externalDependency: "DEP-001", internalInterface: "FMT-001",
    responsibility: "Translate envelopes to and from NATS subjects",
  }, ctx);
  await callTool(pi, "fleet_add_extension_point", {
    capability: "Custom serializer", hostModule: "MOD-001",
    description: "Plug a different encoding into ingest",
  }, ctx);
  await callTool(pi, "fleet_add_host", {
    name: "IngestHost", hostModule: "MOD-001", adapterInterface: "FMT-001",
    registeredExtensions: ["EXT-001"],
  }, ctx);
  await callTool(pi, "fleet_add_harness", {
    name: "IngestReplay", targetModule: "MOD-001", harnessType: "integration",
    language: "typescript",
  }, ctx);
  await callTool(pi, "fleet_add_harness", {
    name: "StoreContract", targetModule: "MOD-002", harnessType: "contract",
  }, ctx);
  await callTool(pi, "fleet_add_harness", {
    name: "QueryGolden", targetModule: "MOD-003", harnessType: "end-to-end",
  }, ctx);
  await callTool(pi, "fleet_add_migration_phase", {
    name: "Dual-write", rollbackPlan: "Disable dual-write and fall back to the old path",
    validationCriteria: "Event counts match between old and new paths for 24h",
  }, ctx);
  await callTool(pi, "fleet_add_compat_mapping", {
    name: "EnvelopeV1ToV2", oldContract: "legacy-envelope", newContract: "FMT-001",
  }, ctx);

  const r = await callTool(pi, "fleet_advance_phase", { phase: 6 }, ctx);
  check("advance to phase 6 succeeds", r.details.ok, r.text);
}

{
  const u = await callTool(pi, "fleet_untested_targets", {}, ctx);
  check("every module has a harness", u.details.missing.length === 0, u.text);
}

// ─── Verification: coherent design ───────────────────────────────────────────

section("Phase 7 — verification of a coherent design");

{
  const r = await callTool(pi, "fleet_verify_architecture", {}, ctx);
  console.log("\n" + r.text.split("\n").map((l) => "    " + l).join("\n") + "\n");
  check("coherent architecture passes", r.details.summary === "PASS",
    `got ${r.details.summary}`);
  check("verdict persisted", loaded["fleet-core"].loadState().verification?.summary === "PASS");
}

{
  const r = await callTool(pi, "fleet_advance_phase", { phase: 7 }, ctx);
  check("advance to phase 7 succeeds", r.details.ok, r.text);
}

// ─── Verification: broken design ─────────────────────────────────────────────

section("Phase 7 — verification catches real defects");

{
  // Dangling format reference.
  await callTool(pi, "fleet_edit_module", { id: "MOD-003", field: "consumes", value: "FMT-999" }, ctx);
  const r = await callTool(pi, "fleet_verify_architecture", {}, ctx);
  check("dangling FMT-999 reference → REJECT", r.details.summary === "REJECT", `got ${r.details.summary}`);
  check("  names the dangling reference", /FMT-999/.test(r.text));
  await callTool(pi, "fleet_edit_module", { id: "MOD-003", field: "consumes", value: "FMT-002" }, ctx);
}

{
  // Dependency cycle: MOD-001 → MOD-002 → MOD-003 → MOD-001.
  await callTool(pi, "fleet_edit_module", { id: "MOD-001", field: "dependencies", value: "MOD-002" }, ctx);
  await callTool(pi, "fleet_edit_module", { id: "MOD-002", field: "dependencies", value: "MOD-003" }, ctx);
  await callTool(pi, "fleet_edit_module", { id: "MOD-003", field: "dependencies", value: "MOD-001" }, ctx);
  const r = await callTool(pi, "fleet_verify_architecture", {}, ctx);
  check("module dependency cycle → REJECT", r.details.summary === "REJECT", `got ${r.details.summary}`);
  check("  reports the cycle path", /MOD-001.*MOD-002.*MOD-003/.test(r.text), r.text.slice(0, 300));
}

{
  // Break the cycle, introduce a leaky contract instead.
  await callTool(pi, "fleet_edit_module", { id: "MOD-001", field: "dependencies", value: "" }, ctx);
  await callTool(pi, "fleet_edit_module", { id: "MOD-002", field: "dependencies", value: "MOD-001" }, ctx);
  await callTool(pi, "fleet_edit_module", { id: "MOD-003", field: "dependencies", value: "MOD-002" }, ctx);
  await callTool(pi, "fleet_define_contract", {
    name: "RawBroker", semantics: "Direct passthrough to the message broker",
    type: "interface", structure: "raw broker frames",
    hidesStorage: false, hidesVendor: false, hidesPlatform: false,
  }, ctx);
  const r = await callTool(pi, "fleet_verify_architecture", {}, ctx);
  check("leaky contract → REJECT", r.details.summary === "REJECT", `got ${r.details.summary}`);
  check("  names the leaky contract", /RawBroker|FMT-003/.test(r.text), r.text.slice(0, 400));
}

// ─── Verification blocks the freeze ──────────────────────────────────────────

section("Verification gates the freeze");

{
  const r = await callTool(pi, "fleet_advance_phase", { phase: 8 }, ctx);
  check("advance to phase 8 refused while verdict is REJECT", !r.details.ok, r.text);
  check("  reason mentions REJECT", /REJECT/.test(r.text), r.text);
}

// ─── Repair, then proceed to freeze ──────────────────────────────────────────

section("Repair and contract freeze");

{
  await callTool(pi, "fleet_define_contract", {
    id: "FMT-003", name: "RawBroker", semantics: "A broker-agnostic frame",
    type: "interface", structure: "{ topic, body }",
    invariants: "body is opaque to the broker",
    hidesStorage: true, hidesVendor: true, hidesPlatform: true,
    alternativeImplementable: true, confirmReplace: true,
  }, ctx);
  const r = await callTool(pi, "fleet_verify_architecture", {}, ctx);
  check("repaired design passes again", r.details.summary === "PASS", `got ${r.details.summary}`);
}

{
  const r = await callTool(pi, "fleet_advance_phase", { phase: 8 }, ctx);
  check("advance to phase 8 succeeds", r.details.ok, r.text);
}

{
  const r = await callTool(pi, "fleet_record_decision", {
    id: "DEC-broker", topic: "Which broker to standardize on", reason: "Two viable options",
  }, ctx);
  check("decision recorded", r.details.ok, r.text);
}

{
  const r = await callTool(pi, "fleet_freeze_contracts", { contractId: "core-v1" }, ctx);
  check("freeze blocked by unresolved decision", !r.details.ok, r.text);
}

{
  const r = await callTool(pi, "fleet_advance_phase", { phase: 9 }, ctx);
  check("advance to phase 9 blocked by decision", !r.details.ok, r.text);
  check("  names the decision", /DEC-broker/.test(r.text), r.text);
}

{
  const r = await callTool(pi, "fleet_resolve_decision", { id: "DEC-broker", option: "NATS" }, ctx);
  check("decision resolved", r.details.ok, r.text);
}

{
  const r = await callTool(pi, "fleet_advance_phase", { phase: 9 }, ctx);
  check("advance to phase 9 succeeds", r.details.ok, r.text);
}

{
  const r = await callTool(pi, "fleet_freeze_contracts", { contractId: "core-v1" }, ctx);
  check("contract frozen", r.details.ok, r.text);
}

// ─── Freeze immutability ─────────────────────────────────────────────────────

section("Frozen contracts are immutable");

{
  const blocked = await runWriteGate(pi, ctx, "write", {
    file_path: join(workdir, "architecture", "04_FORMAT_REGISTRY.md"), content: "tampered",
  });
  check("design artifact refused after freeze", !!blocked, "expected a block");
  check("  reason mentions frozen", /frozen/i.test(blocked?.reason || ""), blocked?.reason);
}

{
  const allowed = await runWriteGate(pi, ctx, "write", {
    file_path: join(workdir, "src", "index.ts"), content: "export const x = 1;",
  });
  check("implementation still gated before phase 10", !!allowed, "expected a block");
}

{
  const r = await callTool(pi, "fleet_advance_phase", { phase: 10 }, ctx);
  check("advance to phase 10 succeeds", r.details.ok, r.text);
}

{
  const allowed = await runWriteGate(pi, ctx, "write", {
    file_path: join(workdir, "src", "index.ts"), content: "export const x = 1;",
  });
  check("implementation write allowed at phase 10", !allowed, JSON.stringify(allowed));
}

{
  const blocked = await runWriteGate(pi, ctx, "write", {
    file_path: join(workdir, "architecture", "05_MODULE_REGISTRY.md"), content: "tampered",
  });
  check("design artifact still frozen at phase 10", !!blocked);
}

// ─── Audit trail ─────────────────────────────────────────────────────────────

section("Audit trail");

{
  const fs = await import("node:fs");
  const p = join(workdir, "architecture", "fleet-audit.log");
  check("audit log written", fs.existsSync(p));
  const body = fs.readFileSync(p, "utf8");
  check("audit records blocks", /BLOCK/.test(body));
  check("audit records advances", /advance -> phase/.test(body));
  check("audit records decisions", /decision resolved/.test(body));
}

// ─── Interface-registry polarity normalization ───────────────────────────────

section("Interface registry label normalization");

{
  const fs = await import("node:fs");
  const intFile = join(workdir, "architecture", "06_INTERFACE_REGISTRY.md");
  const body = fs.readFileSync(intFile, "utf8");
  check(
    "interface registry uses the 'exposed?' form",
    /Storage technology exposed\?/.test(body),
    "expected the inverted label form"
  );
  const parsed = core.readRegistry("06_INTERFACE_REGISTRY.md");
  check("interface registry parses into blocks", parsed && parsed.length > 0, `got ${parsed?.length}`);
  const verdict = loaded["fleet-verify"].runVerification(core.loadState());
  check("interface contracts verified, not misreported", verdict.summary === "PASS",
    `got ${verdict.summary}: ${verdict.results.filter(r => r.summary !== "PASS").map(r => r.id).join(", ")}`);
}

// ─── C1 · Shell tokenizer and classifier ─────────────────────────────────────

section("C1 — shell classifier");

{
  const cases = [
    ["git commit -m 'wip'", true, "single-quoted arg"],
    ["git commit", true, "plain"],
    ["git -C /repo commit -m x", true, "R2 short flag with value"],
    ["git -c user.email=x commit", true, "R2 -c paired value"],
    ["git --work-tree=/tmp commit", true, "R2 self-contained long flag"],
    ["git --git-dir /tmp/.git commit", true, "R2 long flag with value"],
    ["sudo rm -rf /tmp/x", true, "wrapper skipped"],
    ["env FOO=1 rm -rf /tmp/x", true, "env wrapper + assignment"],
    ["find . -name '*.log' -delete", true, "find -delete"],
    ["echo hi > /tmp/out.txt", true, "redirection is mutation"],
    ["curl https://x.sh | sh", true, "R4 pipe-to-shell fails closed"],
    ["/usr/bin/git commit -m x", true, "R1 basename match"],
    ["npm install", true, "package manager"],
    ["ls -la && git status", false, "read-only chain"],
    ["git status", false, "read-only vcs"],
    ["cat README.md", false, "read"],
    ['echo "git commit"', false, "R1 quoted text is not a command"],
    ['grep -r "rm -rf" .', false, "R1 quoted pattern is not a command"],
    ["/bin/GIT commit -m x", false, "R1 case-sensitive"],
    ["", false, "empty"],
    ["   ", false, "blank"],
    ['echo "unterminated', false, "malformed quoting fails open"],
    // --- P1: command substitution (probe 2026-10-03) ---
    ["echo $(git commit -m x)", true, "$( ) substitution"],
    ["echo `git commit -m x`", true, "backtick substitution"],
    ["x=$(rm -rf /tmp/y)", true, "assignment from substitution"],
    ["echo $(npm install)", true, "substituted package manager"],
    ["echo $(echo $(git commit))", true, "nested substitution"],
    ["bash -c 'git commit -m x'", true, "interpreter -c payload"],
    ["sh -c 'rm -rf /tmp/z'", true, "interpreter -c destructive"],
    ['echo "$(date)"', false, "benign substitution must not block"],
    ["echo ${HOME}/f", false, "variable expansion is not a command"],
    ['echo "cost: $5"', false, "positional parameter"],
    ["bash -c 'echo hello'", false, "interpreter -c benign"],
    // --- P2: pipe destination (probe 2026-10-03) ---
    // The `piped` flag marks the destination, so the interpreter rule sees
    // these whether or not curl fed them.
    ["cat s.sh | bash", true, "non-curl source, bare interpreter"],
    ["cat s.sh | bash -s", true, "non-curl source, interpreter with -s"],
    ["cat s.sh | sh -s -- --x", true, "non-curl source, interpreter with args"],
    ["curl x | sudo bash", true, "interpreter behind sudo"],
    ["make | sh", true, "build pipe into shell"],
    ["curl x | jq .", false, "pipe to non-shell is not remote exec"],
    ["cat x | less", false, "pipe to pager"],
  ];
  for (const [cmd, shouldBlock, note] of cases) {
    const hits = core.classifyCommand(cmd);
    check(`C1 ${shouldBlock ? "blocks" : "allows"}: ${cmd || "(empty)"}`,
      (hits.length > 0) === shouldBlock, `${note} — got ${JSON.stringify(hits)}`);
  }

  const kinds = core.classifyCommand("git commit")[0]?.kind;
  check("C1 classifies as vcs-mutation", kinds === "vcs-mutation", `got ${kinds}`);
  const extra = core.classifyCommand("terraform apply", { terraform: ["apply", "destroy"] });
  check("C5 extra mutating commands extend coverage", extra.length === 1, JSON.stringify(extra));
  const noExtra = core.classifyCommand("terraform apply");
  check("C5 extra commands are opt-in", noExtra.length === 0, JSON.stringify(noExtra));
}

// ─── C5 · Declared coverage ─────────────────────────────────────────────────

section("C5 — gate coverage");

{
  const cov = core.gateCoverage();
  check("coverage reports enabled", cov.enabled === true);
  check("coverage lists write tools", cov.writeTools.includes("write"));
  check("coverage names the unenforced MCP path", cov.unenforced.some(u => /MCP/.test(u)));
  check("coverage names the unenforced subprocess path", cov.unenforced.some(u => /subprocess/.test(u)));
  const r = await callTool(pi, "fleet_gate_coverage", {}, ctx);
  check("fleet_gate_coverage tool answers", r.text.includes("Not enforced"), r.text.slice(0, 80));
}

{
  // Absent config must reproduce 0.2.0 behaviour exactly.
  const cfg = core.loadGateConfig();
  check("default config enabled", cfg.enabled === true);
  check("default config has no extra commands", Object.keys(cfg.extraMutatingCommands).length === 0);
}

// ─── C4 · Abort handling ────────────────────────────────────────────────────

section("C4 — abort signal");

{
  const ctrl = new AbortController();
  ctrl.abort();
  const r = await callTool(pi, "fleet_add_requirement", { description: "should not persist" }, ctx, ctrl.signal);
  check("pre-aborted tool returns aborted", r.details.aborted === true, JSON.stringify(r.details));
  const reqs = core.loadState().requirements || [];
  check("pre-aborted tool did not persist", !reqs.some((q) => q.description === "should not persist"));

  const live = new AbortController();
  const ok = await callTool(pi, "fleet_add_requirement", { description: "live signal persists" }, ctx, live.signal);
  check("live signal proceeds", ok.details.aborted !== true);
}

// ─── C3 · Session guards ────────────────────────────────────────────────────

section("C3 — session guards");

async function runHook(name) {
  for (const fn of pi.hooks[name] || []) {
    const v = await fn({}, ctx);
    if (v) return v;
  }
  return null;
}

{
  check("session_before_switch installed", (pi.hooks["session_before_switch"] || []).length > 0);
  check("session_before_fork installed", (pi.hooks["session_before_fork"] || []).length > 0);

  // Early phase with an open decision — must be allowed.
  const early = core.loadState();
  early.decisions = { "DEC-x": { id: "DEC-x", topic: "t", trigger: { reason: "" }, requirements: [], options: [], recommendation: { option: "", rationale: "" }, status: "awaiting_user_decision", selectedOption: null } };
  early.decisionsRequired = ["DEC-x"];
  early.currentPhase = 2;
  core.saveState(early);
  check("switch allowed at Phase 2 with open decision", (await runHook("session_before_switch")) === null);

  // At Phase 8 — must be cancelled.
  const late = core.loadState();
  late.currentPhase = 8;
  core.saveState(late);
  const blocked = await runHook("session_before_switch");
  check("switch cancelled at Phase 8 with open decision", !!blocked && blocked.cancel === true, JSON.stringify(blocked));

  // Clean queue at Phase 8 — allowed.
  const clean = core.loadState();
  clean.decisionsRequired = [];
  core.saveState(clean);
  check("switch allowed at Phase 8 with no open decision", (await runHook("session_before_switch")) === null);

  check("fork never blocked", (await runHook("session_before_fork")) === null);

  await callTool(pi, "fleet_resolve_decision", { id: "DEC-x", option: "later" }, ctx);
}

// ─── D3 · Rewind invalidates a stale verdict ────────────────────────────────

section("D3 — rewind invalidates the verdict");

{
  const v = await callTool(pi, "fleet_verify_architecture", {}, ctx);
  check("verdict recorded with its phase", typeof core.loadState().verification?.phase === "number");
  check("verdict is PASS", v.details.summary === "PASS", v.details.summary);

  // Rewind below the phase the verdict was produced at.
  const r = await callTool(pi, "fleet_advance_phase", { phase: 3 }, ctx);
  check("rewind allowed below freeze", r.details.ok, r.text);
  check("rewind cleared the stale verdict", core.loadState().verification === null,
    JSON.stringify(core.loadState().verification));

  const forward = await callTool(pi, "fleet_advance_phase", { phase: 9 }, ctx);
  check("re-forward to 9 blocked without a verdict", !forward.details.ok, forward.text);
  check("  reason names the verdict", /verification/i.test(forward.text), forward.text);
}

{
  const v = await callTool(pi, "fleet_verify_architecture", {}, ctx);
  check("re-verification restores a usable verdict", v.details.summary === "PASS", v.details.summary);
  const forward = await callTool(pi, "fleet_advance_phase", { phase: 9 }, ctx);
  check("re-forward to 9 now permitted", forward.details.ok, forward.text);
}

// ─── C2 · Store-sourced verification and drift ──────────────────────────────

section("C2 — drift detection");

{
  const fs = await import("node:fs");
  const modFile = join(workdir, "architecture", "05_MODULE_REGISTRY.md");
  const before = fs.readFileSync(modFile, "utf8");
  check("no drift on a freshly written store", core.loadState() && detectDriftOf(core.loadState()).length === 0,
    JSON.stringify(detectDriftOf(core.loadState())));

  // Hand-edit the rendered document so it no longer matches the store.
  fs.writeFileSync(modFile, before.replace(/## MOD-003/g, "## MOD-999"), "utf8");
  const drift = detectDriftOf(core.loadState());
  check("hand-edited document reports drift", drift.length > 0, "expected drift");
  check("  drift names the file", drift.some((d) => d.file === "05_MODULE_REGISTRY.md"), JSON.stringify(drift));
  check("  drift names the divergent id", /MOD-999|MOD-003/.test(JSON.stringify(drift)), JSON.stringify(drift));

  // Drift alone must not REJECT.
  const v = await callTool(pi, "fleet_verify_architecture", {}, ctx);
  check("drift alone does not REJECT", v.details.summary !== "REJECT", v.details.summary);
  check("drift reported as its own target",
    v.text.includes("VRFY-DRIFT") || v.details.drift?.length > 0, "expected a drift finding");

  fs.writeFileSync(modFile, before, "utf8");
  const clean = await callTool(pi, "fleet_verify_architecture", {}, ctx);
  check("restoring the document clears drift", clean.details.drift.length === 0, JSON.stringify(clean.details.drift));
}

// ─── Done ────────────────────────────────────────────────────────────────────

rmSync(workdir, { recursive: true, force: true });

console.log(`\n${"─".repeat(56)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(56)}\n`);
process.exit(failed > 0 ? 1 : 0);