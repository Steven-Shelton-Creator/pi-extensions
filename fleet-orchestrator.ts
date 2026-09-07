/**
 * fleet-orchestrator :: Phase 0 — Job Init + Fleet State Machine
 *
 * The orchestrator extension for the Agent Fleet Architecture Execution System.
 * Maintains phase state, job definition, and dependency graph across sessions.
 * All other fleet agents register against this extension's phase gates.
 *
 * /fleet:new-job       — initialize architecture/00_JOB.md with objective/scope/non-goals
 * /fleet:status        — show current phase, ready/blocked/decision queues
 * /fleet:phase <n>     — advance phase (checks gates first)
 * /fleet:decision <id> — record or resolve a decision
 *
 * State persists via pi.appendEntry() + architecture/fleet-state.json.
 * Artifacts live in architecture/ directory (never writes code).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Constants ───────────────────────────────────────────────────────────────

const STATE_TYPE = "fleet-state";

const PHASES = [
  { n: 0, label: "JOB DEFINITION" },
  { n: 1, label: "REQUIREMENTS + RISKS" },
  { n: 2, label: "PRIMITIVE" },
  { n: 3, label: "FORMATS + CONTRACTS" },
  { n: 4, label: "MODULE BOUNDARIES" },
  { n: 5, label: "DEPENDENCIES + EXTENSIONS" },
  { n: 6, label: "TOOLING + MIGRATION" },
  { n: 7, label: "ARCHITECTURE VERIFICATION" },
  { n: 8, label: "USER DECISIONS" },
  { n: 9, label: "CONTRACT FREEZE" },
  { n: 10, label: "PARALLEL IMPLEMENTATION" },
  { n: 11, label: "INTEGRATION + REPLACEMENT TEST" },
] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

interface FleetState {
  job: {
    objective: string;
    scope: string[];
    non_goals: string[];
    source_material: string[];
    existing_system: string;
    known_constraints: string[];
    decision_authority: "director" | "fleet" | "auto";
  };
  currentPhase: number;
  readyTasks: string[];
  runningTasks: string[];
  blockedTasks: string[];
  decisionsRequired: string[];
  frozenContracts: string[];
  phaseGates: Record<number, boolean>;
}

interface Decision {
  id: string;
  topic: string;
  trigger: { reason: string };
  requirements: string[];
  options: {
    option: string;
    benefits: string[];
    costs: string[];
    constraints: string[];
  }[];
  recommendation: { option: string; rationale: string };
  status: "awaiting_user_decision" | "approved" | "rejected";
  selectedOption: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ARCH_DIR = "architecture";
const JOB_FILE = "00_JOB.md";
const DECISION_FILE = "12_DECISION_REGISTER.md";

function cwd(): string {
  return process.cwd();
}

function archPath(...parts: string[]): string {
  return join(cwd(), ARCH_DIR, ...parts);
}

function ensureArchDir() {
  const p = archPath();
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function emptyState(): FleetState {
  return {
    job: {
      objective: "",
      scope: [],
      non_goals: [],
      source_material: [],
      existing_system: "",
      known_constraints: [],
      decision_authority: "director",
    },
    currentPhase: 0,
    readyTasks: [],
    runningTasks: [],
    blockedTasks: [],
    decisionsRequired: [],
    frozenContracts: [],
    phaseGates: { 0: false },
  };
}

// ─── Phase gate checks ─────────────────────────────────────────────────────

function gateForPhase(state: FleetState, n: number): string[] {
  const missed: string[] = [];
  switch (n) {
    case 0:
      if (!state.job.objective) missed.push("job objective not set");
      if (state.job.scope.length === 0) missed.push("job scope not defined");
      break;
    case 1:
      if (!state.phaseGates[0]) missed.push("Phase 0 (JOB DEFINITION) not complete");
      break;
    case 2:
      if (!state.phaseGates[1]) missed.push("Phase 1 (REQUIREMENTS + RISKS) not complete");
      break;
    case 3:
      if (!state.phaseGates[2]) missed.push("Phase 2 (PRIMITIVE) not complete");
      break;
    case 4:
      if (!state.phaseGates[3]) missed.push("Phase 3 (FORMATS + CONTRACTS) not complete");
      break;
    case 5:
      if (!state.phaseGates[4]) missed.push("Phase 4 (MODULE BOUNDARIES) not complete");
      break;
    case 6:
      if (!state.phaseGates[5]) missed.push("Phase 5 (DEPENDENCIES + EXTENSIONS) not complete");
      break;
    case 7:
      if (!state.phaseGates[6]) missed.push("Phase 6 (TOOLING + MIGRATION) not complete");
      break;
    case 9:
      if (state.decisionsRequired.length > 0) missed.push("unresolved decisions exist");
      break;
    case 10:
      if (!state.phaseGates[9]) missed.push("Phase 9 (CONTRACT FREEZE) not complete");
      break;
  }
  return missed;
}

// ─── Write JOB.md ─────────────────────────────────────────────────────────

function writeJobFile(state: FleetState) {
  ensureArchDir();
  const lines = [
    `# Architecture Job: ${state.job.objective}`,
    "",
    "## Objective",
    state.job.objective,
    "",
    "## Scope",
    ...state.job.scope.map((s) => `- ${s}`),
    "",
    "## Non-Goals",
    ...state.job.non_goals.map((s) => `- ${s}`),
    "",
    "## Source Material",
    ...state.job.source_material.map((s) => `- ${s}`),
    "",
    "## Existing System",
    state.job.existing_system || "_none_",
    "",
    "## Known Constraints",
    ...state.job.known_constraints.map((s) => `- ${s}`),
    "",
    `## Decision Authority`,
    state.job.decision_authority,
    "",
    "---",
    `*Created by fleet-orchestrator · Phase ${state.currentPhase}*`,
  ];
  writeFileSync(archPath(JOB_FILE), lines.join("\n"), "utf8");
}

// ─── Write DECISION_REGISTER.md ──────────────────────────────────────────

function writeDecisionFile(decisions: Record<string, Decision>) {
  ensureArchDir();
  const decisionEntries = Object.values(decisions);
  if (decisionEntries.length === 0) {
    writeFileSync(archPath(DECISION_FILE), "# Decision Register\n\n*No decisions recorded yet.*\n", "utf8");
    return;
  }
  const lines = ["# Decision Register", ""];
  for (const d of decisionEntries) {
    lines.push(`## ${d.id} — ${d.topic}`);
    lines.push(`**Status:** ${d.status}`);
    if (d.trigger?.reason) lines.push(`**Trigger:** ${d.trigger.reason}`);
    lines.push("");
    if (d.requirements.length) {
      lines.push("### Requirements");
      for (const r of d.requirements) lines.push(`- ${r}`);
      lines.push("");
    }
    if (d.options.length) {
      lines.push("### Options");
      for (const o of d.options) {
        lines.push(`- **${o.option}:** ${o.benefits.join(", ")} | costs: ${o.costs.join(", ")} | constraints: ${o.constraints.join(", ")}`);
      }
      lines.push("");
    }
    lines.push(`**Recommendation:** ${d.recommendation?.option || "—"} ${d.recommendation?.rationale ? `— ${d.recommendation.rationale}` : ""}`);
    lines.push(`**Selected:** ${d.selectedOption || "_pending_"}`);
    lines.push("---");
    lines.push("");
  }
  writeFileSync(archPath(DECISION_FILE), lines.join("\n"), "utf8");
}

// ─── Save/Load ─────────────────────────────────────────────────────────────

function saveState(state: FleetState, decisions: Record<string, Decision>, pi: ExtensionAPI) {
  ensureArchDir();
  const payload = JSON.stringify({ state, decisions }, null, 2);
  writeFileSync(archPath("fleet-state.json"), payload, "utf8");
}

function loadState(): { state: FleetState; decisions: Record<string, Decision> } | null {
  const jsonPath = archPath("fleet-state.json");
  if (existsSync(jsonPath)) {
    try {
      return JSON.parse(readFileSync(jsonPath, "utf8"));
    } catch {
      /* corrupt — return null */
    }
  }
  return null;
}

// ─── Extension Export ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let state: FleetState = emptyState();
  let decisions: Record<string, Decision> = {};

  // ─── Restore state on session start ─────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const loaded = loadState();
    if (loaded) {
      state = loaded.state;
      decisions = loaded.decisions;
      ctx.ui.notify(
        `[fleet] restored: Phase ${state.currentPhase} — ${state.job.objective || "(no job)"}`,
        "info"
      );
    }
  });

  // ─── Command: fleet:new-job ─────────────────────────────────────────────

  pi.registerCommand("fleet:new-job", {
    description: "Initialize a new architecture job (Phase 0)",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /fleet:new-job <objective>", "warning");
        return;
      }
      if (state.job.objective) {
        const ok = await ctx.ui.confirm(
          "Replace existing job?",
          `Current: "${state.job.objective}"`
        );
        if (!ok) return;
      }
      state = emptyState();
      decisions = {};
      state.job.objective = args.trim();

      const scopeInput = await ctx.ui.input("Scope items (comma-separated)", "");
      if (scopeInput) state.job.scope = scopeInput.split(",").map((s: string) => s.trim()).filter(Boolean);

      const ngInput = await ctx.ui.input("Non-goals (comma-separated)", "");
      if (ngInput) state.job.non_goals = ngInput.split(",").map((s: string) => s.trim()).filter(Boolean);

      const srcInput = await ctx.ui.input("Source material (comma-separated)", "");
      if (srcInput) state.job.source_material = srcInput.split(",").map((s: string) => s.trim()).filter(Boolean);

      const conInput = await ctx.ui.input("Known constraints (comma-separated)", "");
      if (conInput) state.job.known_constraints = conInput.split(",").map((s: string) => s.trim()).filter(Boolean);

      writeJobFile(state);
      saveState(state, decisions, pi);
      ctx.ui.notify(`[fleet] Job created: "${state.job.objective}"`, "info");
    },
  });

  // ─── Command: fleet:status ─────────────────────────────────────────────

  pi.registerCommand("fleet:status", {
    description: "Show fleet state machine status",
    handler: async (_args, ctx) => {
      const phase = PHASES[state.currentPhase];
      const lines = [
        `📋 Fleet State (Phase ${state.currentPhase}: ${phase.label})`,
        `  Objective: ${state.job.objective || "(not set)"}`,
        `  Scope: ${state.job.scope.length} items`,
        `  Non-goals: ${state.job.non_goals.length} items`,
        `  Tasks — ready:${state.readyTasks.length} running:${state.runningTasks.length} blocked:${state.blockedTasks.length}`,
        `  Decisions required: ${state.decisionsRequired.length}`,
        `  Frozen contracts: ${state.frozenContracts.length}`,
      ];
      const gate = gateForPhase(state, state.currentPhase);
      if (gate.length > 0) {
        lines.push(`  ⛔ Gate blocked:`);
        for (const g of gate) lines.push(`    · ${g}`);
      } else if (state.job.objective) {
        lines.push(`  ✅ Gate clear`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ─── Command: fleet:phase ──────────────────────────────────────────────

  pi.registerCommand("fleet:phase", {
    description: "Advance to phase [0-11] (checks gates)",
    handler: async (args, ctx) => {
      if (!state.job.objective) {
        ctx.ui.notify("No job initialized. Run /fleet:new-job first.", "warning");
        return;
      }
      let target = args?.trim() ? parseInt(args.trim(), 10) : state.currentPhase + 1;
      if (isNaN(target) || target < 0 || target > 11) {
        ctx.ui.notify("Usage: /fleet:phase [0-11]", "warning");
        return;
      }

      // Check gate for target phase
      const gate = gateForPhase(state, target);
      if (gate.length > 0) {
        ctx.ui.notify(
          `⛔ Cannot advance to Phase ${target}. Gate blocked:\n${gate.map((g: string) => `  · ${g}`).join("\n")}`,
          "error"
        );
        return;
      }

      state.currentPhase = target;
      state.phaseGates[target] = true;
      // If we passed phase 0, mark it as gated
      if (target > 0) state.phaseGates[target - 1] = true;

      saveState(state, decisions, pi);
      ctx.ui.notify(`✅ Advanced to Phase ${target}: ${PHASES[target].label}`, "info");
    },
  });

  // ─── Command: fleet:decision ───────────────────────────────────────────

  pi.registerCommand("fleet:decision", {
    description: "Record or resolve a decision (/fleet:decision <id> <topic> / fleet:decision resolve <id> <option>)",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      if (parts.length < 2) {
        ctx.ui.notify("Usage: /fleet:decision <id> <topic> | /fleet:decision resolve <id> <option> | /fleet:decision list", "warning");
        return;
      }

      if (parts[0] === "list") {
        const entries = Object.values(decisions);
        if (entries.length === 0) {
          ctx.ui.notify("No decisions recorded.", "info");
          return;
        }
        const lines = entries.map(
          (d) => `${d.id}: ${d.topic} [${d.status}] → ${d.selectedOption || "?"}`
        );
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (parts[0] === "resolve") {
        const id = parts[1];
        const option = parts.slice(2).join(" ");
        const d = decisions[id];
        if (!d) {
          ctx.ui.notify(`Decision ${id} not found.`, "error");
          return;
        }
        if (!option) {
          ctx.ui.notify("Specify the selected option.", "warning");
          return;
        }
        d.status = "approved";
        d.selectedOption = option;
        decisions[id] = d;
        saveState(state, decisions, pi);
        writeDecisionFile(decisions);

        // Remove from decisionsRequired if present
        state.decisionsRequired = state.decisionsRequired.filter((x) => x !== id);
        saveState(state, decisions, pi);

        ctx.ui.notify(`✅ ${id}: approved — "${option}"`, "info");
        return;
      }

      // Record a new decision
      const id = parts[0];
      if (decisions[id]) {
        ctx.ui.notify(`Decision ${id} already exists. Use 'resolve' to approve.`, "warning");
        return;
      }
      const topic = parts.slice(1).join(" ");
      decisions[id] = {
        id,
        topic,
        trigger: { reason: "" },
        requirements: [],
        options: [],
        recommendation: { option: "", rationale: "" },
        status: "awaiting_user_decision",
        selectedOption: null,
      };

      // Add to decisions required
      if (!state.decisionsRequired.includes(id)) {
        state.decisionsRequired.push(id);
      }

      saveState(state, decisions, pi);
      writeDecisionFile(decisions);
      ctx.ui.notify(`[fleet] Decision ${id} recorded: "${topic}" — awaiting resolution`, "info");
    },
  });

  // ─── Command: fleet:contract-freeze ────────────────────────────────────

  pi.registerCommand("fleet:contract-freeze", {
    description: "Freeze contracts (Phase 9) — set contract status and version",
    handler: async (args, ctx) => {
      if (state.currentPhase < 9) {
        ctx.ui.notify(`Cannot freeze contracts in Phase ${state.currentPhase}. Advance to Phase 9 first.`, "warning");
        return;
      }
      if (state.decisionsRequired.length > 0) {
        ctx.ui.notify("Unresolved decisions exist. Resolve them before freezing contracts.", "warning");
        return;
      }
      const version = args?.trim() || "1";
      const contractId = await ctx.ui.input("Contract ID (e.g., core-api-v1)", "core-v1");
      if (!contractId) {
        ctx.ui.notify("Contract freeze cancelled.", "info");
        return;
      }
      const entry = {
        id: contractId,
        version: parseInt(version, 10),
        frozenAt: new Date().toISOString(),
      };
      if (!state.frozenContracts.includes(contractId)) {
        state.frozenContracts.push(contractId);
      }
      saveState(state, decisions, pi);
      ctx.ui.notify(`❄️ Contract frozen: ${contractId} v${version}`, "info");
    },
  });
}