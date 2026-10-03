/**
 * fleet-orchestrator :: Phase 0 — Job Init + Fleet State Machine
 *
 * Owns the canonical store, phase transitions, the decision queue, and
 * contract freeze. Every phase transition is gated on artifacts that actually
 * exist on disk (see fleet-core `gateForPhase`), not on bookkeeping booleans.
 *
 * Commands (human-paced):
 *   /fleet:new-job        initialize a job (Phase 0)
 *   /fleet:status         show phase, artifacts, gates
 *   /fleet:phase <n>      advance to phase n (gated)
 *   /fleet:decision <id> <topic> | resolve <id> <option> | list
 *   /fleet:contract-freeze  freeze contracts (Phase 9+)
 *   /fleet:audit          replay the enforcement log
 *   /fleet:override <rule> <reason>   record a deliberate gate bypass
 *
 * Tools (agent-paced): fleet_status, fleet_advance_phase, fleet_record_decision,
 * fleet_resolve_decision, fleet_freeze_contracts.
 *
 * Usage: pi -e extensions/fleet-orchestrator.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  PHASES, MAX_PHASE, FREEZE_PHASE,
  JOB_FILE, DECISION_FILE, AUDIT_FILE, OVERRIDE_FILE,
  archPath, ensureArchDir,
  loadState, saveState, audit, emptyState,
  gateForPhase, artifactStatus, installEnforcement, phaseBrief,
} from "./fleet-core.ts";
import type { FleetState, Decision } from "./fleet-core.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ─── Writers ─────────────────────────────────────────────────────────────────

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
    "## Decision Authority",
    state.job.decision_authority,
    "",
    "---",
    `*Created by fleet-orchestrator · ${new Date().toISOString()}*`,
  ];
  writeFileSync(archPath(JOB_FILE), lines.join("\n"), "utf8");
}

function writeDecisionFile(decisions: Record<string, Decision>) {
  ensureArchDir();
  const entries = Object.values(decisions);
  if (entries.length === 0) {
    writeFileSync(archPath(DECISION_FILE), "# Decision Register\n\n*No decisions recorded yet.*\n", "utf8");
    return;
  }
  const lines = ["# Decision Register", ""];
  for (const d of entries) {
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

function writeOverrides(state: FleetState) {
  writeFileSync(
    archPath(OVERRIDE_FILE),
    JSON.stringify(state.overrides, null, 2),
    "utf8"
  );
}

// ─── Operations (shared by commands and tools) ───────────────────────────────

function advancePhase(state: FleetState, target: number): { ok: boolean; message: string } {
  if (!state.job.objective) return { ok: false, message: "No job initialized. Run /fleet:new-job first." };
  if (isNaN(target) || target < 0 || target > MAX_PHASE) {
    return { ok: false, message: `Target out of range. Use 0-${MAX_PHASE}.` };
  }
  if (target === state.currentPhase) {
    return { ok: false, message: `Already in Phase ${target}.` };
  }
  if (target < state.currentPhase) {
    // Rewind is permitted only if nothing downstream depends on it.
    if (target < FREEZE_PHASE && state.currentPhase >= FREEZE_PHASE) {
      return {
        ok: false,
        message: "Contracts are frozen; rewind is blocked. Open a decision instead.",
      };
    }
  }

  const gate = gateForPhase(state, target);
  if (gate.length > 0) {
    return {
      ok: false,
      message: `Cannot advance to Phase ${target} (${PHASES[target].label}). Gate blocked:\n` +
        gate.map((g) => `  · ${g}`).join("\n"),
    };
  }

  state.currentPhase = target;
  // Record that the phase was genuinely cleared — derived from artifacts, not
  // seeded as a side effect of the advance itself.
  state.phaseGates[target] = true;
  saveState(state);
  audit(`advance -> phase ${target} (${PHASES[target].label})`, state);
  return { ok: true, message: `Advanced to Phase ${target}: ${PHASES[target].label}` };
}

function recordDecision(state: FleetState, id: string, topic: string): { ok: boolean; message: string } {
  if (state.decisions?.[id]) {
    return { ok: false, message: `Decision ${id} already exists. Use 'resolve' to approve it.` };
  }
  state.decisions = state.decisions || {};
  state.decisions[id] = {
    id,
    topic,
    trigger: { reason: "" },
    requirements: [],
    options: [],
    recommendation: { option: "", rationale: "" },
    status: "awaiting_user_decision",
    selectedOption: null,
  };
  if (!state.decisionsRequired.includes(id)) state.decisionsRequired.push(id);
  saveState(state);
  writeDecisionFile(state.decisions);
  audit(`decision recorded ${id}: ${topic}`, state);
  return { ok: true, message: `Decision ${id} recorded: "${topic}" — awaiting human resolution` };
}

function resolveDecision(state: FleetState, id: string, option: string): { ok: boolean; message: string } {
  const d = state.decisions?.[id];
  if (!d) return { ok: false, message: `Decision ${id} not found.` };
  if (!option) return { ok: false, message: "Specify the selected option." };
  d.status = "approved";
  d.selectedOption = option;
  state.decisionsRequired = state.decisionsRequired.filter((x) => x !== id);
  saveState(state);
  writeDecisionFile(state.decisions);
  audit(`decision resolved ${id} -> ${option}`, state);
  return { ok: true, message: `${id}: approved — "${option}"` };
}

function freezeContracts(state: FleetState, contractId: string, version: string): { ok: boolean; message: string } {
  if (state.currentPhase < FREEZE_PHASE) {
    return {
      ok: false,
      message: `Cannot freeze in Phase ${state.currentPhase}. Advance to Phase ${FREEZE_PHASE} first.`,
    };
  }
  if (state.decisionsRequired.length > 0) {
    return {
      ok: false,
      message: `Unresolved decisions block the freeze: ${state.decisionsRequired.join(", ")}`,
    };
  }
  if (state.frozenContracts.includes(contractId)) {
    return { ok: false, message: `${contractId} is already frozen.` };
  }
  state.frozenContracts.push(contractId);
  saveState(state);
  audit(`contract frozen ${contractId} v${version}`, state);
  return { ok: true, message: `Contract frozen: ${contractId} v${version}` };
}

function statusReport(state: FleetState): string {
  const phase = PHASES[state.currentPhase];
  const lines = [
    `📋 Fleet State (Phase ${state.currentPhase}: ${phase.label})`,
    `  Objective: ${state.job.objective || "(not set)"}`,
    `  Scope: ${state.job.scope.length} · Non-goals: ${state.job.non_goals.length}`,
    `  Decisions required: ${state.decisionsRequired.length || "0"}`,
    `  Frozen contracts: ${state.frozenContracts.length || "0"}`,
    `  Overrides: ${state.overrides.length || "0"}`,
    "",
    "  Artifacts:",
  ];
  for (const a of artifactStatus()) {
    lines.push(`    ${a.ok ? "✅" : "⬜"} [P${a.phase}] ${a.file}`);
  }
  const next = state.currentPhase + 1;
  if (next <= MAX_PHASE) {
    const gate = gateForPhase(state, next);
    lines.push("");
    if (gate.length === 0) {
      lines.push(`  ✅ Gate clear for Phase ${next} (${PHASES[next].label})`);
    } else {
      lines.push(`  ⛔ Gate blocked for Phase ${next}:`);
      for (const g of gate) lines.push(`    · ${g}`);
    }
  }
  return lines.join("\n");
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // The write gate and the phase banner are installed once, here, so every
  // phase extension inherits them without re-registering the hooks.
  installEnforcement(pi);

  pi.on("before_agent_start", async (_event: any, ctx: any) => {
    const state = loadState();
    const brief = phaseBrief(state);
    if (!brief) return null;
    return { systemPrompt: `${ctx.getSystemPrompt()}\n\n${brief}` };
  });

  // ─── Commands ─────────────────────────────────────────────────────────────

  pi.registerCommand("fleet:new-job", {
    description: "Initialize a new architecture job (Phase 0)",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /fleet:new-job <objective>", "warning");
        return;
      }
      const state = loadState();
      if (state.job.objective) {
        const ok = await ctx.ui.confirm("Replace existing job?", `Current: "${state.job.objective}"`);
        if (!ok) return;
      }
      const fresh = emptyState();
      fresh.job.objective = args.trim();

      const scope = await ctx.ui.input("Scope items (comma-separated)", "");
      if (scope) fresh.job.scope = scope.split(",").map((s) => s.trim()).filter(Boolean);
      const ng = await ctx.ui.input("Non-goals (comma-separated)", "");
      if (ng) fresh.job.non_goals = ng.split(",").map((s) => s.trim()).filter(Boolean);
      const src = await ctx.ui.input("Source material (comma-separated)", "");
      if (src) fresh.job.source_material = src.split(",").map((s) => s.trim()).filter(Boolean);
      const con = await ctx.ui.input("Known constraints (comma-separated)", "");
      if (con) fresh.job.known_constraints = con.split(",").map((s) => s.trim()).filter(Boolean);

      saveState(fresh);
      writeJobFile(fresh);
      audit(`job created: ${fresh.job.objective}`, fresh);
      ctx.ui.notify(`[fleet] Job created: "${fresh.job.objective}"`, "info");
    },
  });

  pi.registerCommand("fleet:status", {
    description: "Show fleet state, artifacts, and gate status",
    handler: async (_args, ctx) => {
      const state = loadState();
      if (!state.job.objective) {
        ctx.ui.notify("No job initialized. Run /fleet:new-job <objective>.", "warning");
        return;
      }
      ctx.ui.notify(statusReport(state), "info");
    },
  });

  pi.registerCommand("fleet:phase", {
    description: "Advance to phase [0-11] (checks artifact gates)",
    handler: async (args, ctx) => {
      const state = loadState();
      const target = args?.trim() ? parseInt(args.trim(), 10) : state.currentPhase + 1;
      const res = advancePhase(state, target);
      ctx.ui.notify(res.message, res.ok ? "info" : "error");
    },
  });

  pi.registerCommand("fleet:decision", {
    description: "Record/resolve decisions (/fleet:decision <id> <topic> | resolve <id> <option> | list)",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      const state = loadState();

      if (parts[0] === "list") {
        const entries = Object.values(state.decisions || {});
        if (entries.length === 0) {
          ctx.ui.notify("No decisions recorded.", "info");
          return;
        }
        ctx.ui.notify(
          entries.map((d) => `${d.id}: ${d.topic} [${d.status}] → ${d.selectedOption || "?"}`).join("\n"),
          "info"
        );
        return;
      }

      if (parts.length < 2) {
        ctx.ui.notify("Usage: /fleet:decision <id> <topic> | resolve <id> <option> | list", "warning");
        return;
      }

      if (parts[0] === "resolve") {
        const res = resolveDecision(state, parts[1], parts.slice(2).join(" "));
        ctx.ui.notify(res.message, res.ok ? "info" : "error");
        return;
      }

      const res = recordDecision(state, parts[0], parts.slice(1).join(" "));
      ctx.ui.notify(res.message, res.ok ? "info" : "error");
    },
  });

  pi.registerCommand("fleet:contract-freeze", {
    description: "Freeze contracts (Phase 9+) — makes design artifacts immutable",
    handler: async (args, ctx) => {
      const state = loadState();
      const version = args?.trim() || "1";
      const contractId = await ctx.ui.input("Contract ID (e.g., core-api)", "core-v1");
      if (!contractId) {
        ctx.ui.notify("Contract freeze cancelled.", "info");
        return;
      }
      const res = freezeContracts(state, contractId, version);
      ctx.ui.notify(res.message, res.ok ? "info" : "error");
    },
  });

  pi.registerCommand("fleet:audit", {
    description: "Replay the fleet enforcement log",
    handler: async (_args, ctx) => {
      const p = archPath(AUDIT_FILE);
      if (!existsSync(p)) {
        ctx.ui.notify("No audit entries yet.", "info");
        return;
      }
      const lines = readFileSync(p, "utf8").trim().split("\n");
      ctx.ui.notify(lines.slice(-40).join("\n"), "info");
    },
  });

  pi.registerCommand("fleet:override", {
    description: "Record a deliberate gate bypass (/fleet:override <rule> <reason>)",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      if (parts.length < 2) {
        ctx.ui.notify("Usage: /fleet:override <rule> <reason>", "warning");
        return;
      }
      const state = loadState();
      state.overrides.push({
        at: new Date().toISOString(),
        phase: state.currentPhase,
        rule: parts[0],
        reason: parts.slice(1).join(" "),
      });
      saveState(state);
      writeOverrides(state);
      audit(`override ${parts[0]}: ${parts.slice(1).join(" ")}`, state);
      ctx.ui.notify(`Override recorded and logged to ${OVERRIDE_FILE}.`, "info");
    },
  });

  // ─── Tools ─────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "fleet_status",
    label: "Fleet Status",
    description:
      "Read the current Macro Architecture Fleet state: phase, artifact presence, decision queue, and what blocks the next phase. Call this before acting so you do not guess where the job is.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const state = loadState();
      const text = state.job.objective ? statusReport(state) : "No job initialized.";
      ctx.ui.notify(state.job.objective ? `[fleet] status` : `[fleet] no job`, "info");
      return { content: [{ type: "text", text }], details: { state } };
    },
  });

  pi.registerTool({
    name: "fleet_advance_phase",
    label: "Advance Phase",
    description:
      "Advance the job to the given phase (0-11). The gate is evaluated against artifacts on disk: every earlier phase must have produced its documents, verification must have run without REJECT, decisions must be resolved, and contracts must be frozen before implementation. Returns the blocking reasons if the gate refuses.",
    parameters: Type.Object({
      phase: Type.Optional(Type.Number({ description: "Target phase 0-11. Omit to advance by one." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const state = loadState();
      const target = (params as any).phase ?? state.currentPhase + 1;
      const res = advancePhase(state, target);
      ctx.ui.notify(res.message, res.ok ? "info" : "error");
      return {
        content: [{ type: "text", text: res.message }],
        details: { ok: res.ok, currentPhase: state.currentPhase },
      };
    },
  });

  pi.registerTool({
    name: "fleet_record_decision",
    label: "Record Decision",
    description:
      "Record an unresolved architectural decision. Use this instead of guessing when a choice has real tradeoffs — it enters the decision queue and blocks contract freeze until a human resolves it.",
    parameters: Type.Object({
      id: Type.String({ description: "Short decision id, e.g. DEC-storage" }),
      topic: Type.String({ description: "What must be decided" }),
      reason: Type.Optional(Type.String({ description: "What forced the decision" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = params as any;
      const state = loadState();
      const res = recordDecision(state, p.id, p.topic);
      if (res.ok && p.reason) {
        state.decisions![p.id].trigger.reason = p.reason;
        saveState(state);
        writeDecisionFile(state.decisions);
      }
      ctx.ui.notify(res.message, res.ok ? "info" : "error");
      return { content: [{ type: "text", text: res.message }], details: { ok: res.ok } };
    },
  });

  pi.registerTool({
    name: "fleet_resolve_decision",
    label: "Resolve Decision",
    description:
      "Record the human's answer to a pending decision. Only call this when the user has actually chosen — do not pick an option on their behalf.",
    parameters: Type.Object({
      id: Type.String({ description: "Decision id" }),
      option: Type.String({ description: "The selected option, verbatim from the user" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = params as any;
      const state = loadState();
      const res = resolveDecision(state, p.id, p.option);
      ctx.ui.notify(res.message, res.ok ? "info" : "error");
      return { content: [{ type: "text", text: res.message }], details: { ok: res.ok } };
    },
  });

  pi.registerTool({
    name: "fleet_freeze_contracts",
    label: "Freeze Contracts",
    description:
      "Freeze the architecture contracts (Phase 9+). After freezing, design artifacts are immutable to the write gate; further changes must go through a decision.",
    parameters: Type.Object({
      contractId: Type.String({ description: "Contract identifier, e.g. core-api" }),
      version: Type.Optional(Type.String({ description: "Contract version. Defaults to 1." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = params as any;
      const state = loadState();
      const res = freezeContracts(state, p.contractId, p.version || "1");
      ctx.ui.notify(res.message, res.ok ? "info" : "error");
      return { content: [{ type: "text", text: res.message }], details: { ok: res.ok } };
    },
  });
}