/**
 * fleet-core :: shared state, gates, and enforcement for the Macro Architecture Fleet
 *
 * This module is the single source of truth for:
 *   - the phase table
 *   - the artifact/phase contract (which file belongs to which phase)
 *   - the canonical persisted store (architecture/fleet-state.json)
 *   - artifact-existence gate evaluation
 *   - the `tool_call` write gate that forces phase discipline on the model
 *
 * Every other fleet-* extension imports from here. Nothing else should define
 * its own `archPath`, `loadFleetState`, or `checkGate` — duplicated copies of
 * those are how the gates drifted apart in the first place.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";

// ─── Phases ──────────────────────────────────────────────────────────────────

export interface PhaseDef {
  n: number;
  label: string;
}

export const PHASES: PhaseDef[] = [
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
];

export const MAX_PHASE = PHASES.length - 1;

/** First phase at which writing implementation code is permitted. */
export const IMPLEMENTATION_PHASE = 10;

/** Phase at which contracts freeze and design artifacts become immutable. */
export const FREEZE_PHASE = 9;

// ─── Artifacts ───────────────────────────────────────────────────────────────

export const ARCH_DIR = "architecture";
export const STORE_FILE = "fleet-state.json";
export const AUDIT_FILE = "fleet-audit.log";
export const OVERRIDE_FILE = "fleet-overrides.json";

export const JOB_FILE = "00_JOB.md";
export const REQ_FILE = "01_REQUIREMENTS.md";
export const RISK_FILE = "02_RISK_REGISTER.md";
export const PRIM_FILE = "03_PRIMITIVE.md";
export const FMT_FILE = "04_FORMAT_REGISTRY.md";
export const MOD_FILE = "05_MODULE_REGISTRY.md";
export const INT_FILE = "06_INTERFACE_REGISTRY.md";
export const DEP_FILE = "07_DEPENDENCY_REGISTER.md";
export const EXT_FILE = "08_EXTENSION_REGISTRY.md";
export const TOOL_FILE = "09_TOOLING_PLAN.md";
export const MIG_FILE = "10_MIGRATION_PLAN.md";
export const VER_FILE = "11_VERIFICATION_PLAN.md";
export const DECISION_FILE = "12_DECISION_REGISTER.md";

/** phase -> artifacts that phase is responsible for producing */
export const ARTIFACTS: Record<number, string[]> = {
  0: [JOB_FILE],
  1: [REQ_FILE, RISK_FILE],
  2: [PRIM_FILE],
  3: [FMT_FILE, INT_FILE],
  4: [MOD_FILE],
  5: [DEP_FILE, EXT_FILE],
  6: [TOOL_FILE, MIG_FILE],
};

/**
 * artifact filename -> owning phase.
 * MIG_FILE is optional for greenfield work, so it is deliberately not required
 * by the gate, but it still belongs to phase 6 and must not be written early.
 */
export const ARTIFACT_PHASE: Record<string, number> = {
  [JOB_FILE]: 0,
  [REQ_FILE]: 1,
  [RISK_FILE]: 1,
  [PRIM_FILE]: 2,
  [FMT_FILE]: 3,
  [INT_FILE]: 3,
  [MOD_FILE]: 4,
  [DEP_FILE]: 5,
  [EXT_FILE]: 5,
  [TOOL_FILE]: 6,
  [MIG_FILE]: 6,
  [VER_FILE]: 7,
  [DECISION_FILE]: 8,
};

// ─── Paths ───────────────────────────────────────────────────────────────────

export function cwd(): string {
  return process.cwd();
}

export function archPath(...parts: string[]): string {
  return join(cwd(), ARCH_DIR, ...parts);
}

export function ensureArchDir(): string {
  const p = archPath();
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  return p;
}

// ─── State ───────────────────────────────────────────────────────────────────

export interface Job {
  objective: string;
  scope: string[];
  non_goals: string[];
  source_material: string[];
  existing_system: string;
  known_constraints: string[];
  decision_authority: "director" | "fleet" | "auto";
}

export interface Decision {
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

export interface Override {
  at: string;
  phase: number;
  rule: string;
  reason: string;
}

export interface FleetState {
  job: Job;
  currentPhase: number;
  decisionsRequired: string[];
  frozenContracts: string[];
  phaseGates: Record<number, boolean>;
  overrides: Override[];
  /** Registries. Empty/undefined until the owning extension populates them. */
  requirements?: any[];
  risks?: any[];
  lifecycle?: { nfrCount: number; teamSize: number };
  primitive?: any;
  contracts?: any[];
  modules?: any[];
  dependencies?: any[];
  adapters?: any[];
  extensionPoints?: any[];
  hostIntegrations?: any[];
  migrationPhases?: any[];
  compatMappings?: any[];
  tooling?: any[];
  verification?: { ranAt?: string; summary?: string; results?: any[] } | null;
  decisions?: Record<string, Decision>;
}

export function emptyState(): FleetState {
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
    decisionsRequired: [],
    frozenContracts: [],
    phaseGates: {},
    overrides: [],
    verification: null,
    decisions: {},
  };
}

/** Legacy per-extension state files, imported once into the canonical store. */
const LEGACY: { file: string; keys: string[] }[] = [
  { file: "req-state.json", keys: ["requirements", "risks", "lifecycle"] },
  { file: "prim-state.json", keys: ["primitive"] },
  { file: "fmt-state.json", keys: ["contracts"] },
  { file: "mod-state.json", keys: ["modules"] },
  { file: "dep-state.json", keys: ["dependencies", "adapters"] },
  { file: "ext-state.json", keys: ["extensionPoints", "hostIntegrations"] },
  { file: "mig-state.json", keys: ["migrationPhases", "compatMappings"] },
  { file: "tool-state.json", keys: ["tooling"] },
  { file: "ver-state.json", keys: ["verification"] },
];

export function loadState(): FleetState {
  const jsonPath = archPath(STORE_FILE);
  let state = emptyState();

  if (existsSync(jsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
      state = { ...emptyState(), ...parsed };
      state.job = { ...emptyState().job, ...(parsed.job || {}) };
      state.decisions = parsed.decisions || {};
      state.overrides = parsed.overrides || [];
      state.decisionsRequired = parsed.decisionsRequired || [];
      state.frozenContracts = parsed.frozenContracts || [];
      return state;
    } catch {
      /* corrupt store — fall through to legacy import rather than losing work */
    }
  }

  // Migration: pull the old per-extension blobs into the canonical shape.
  for (const { file, keys } of LEGACY) {
    const p = archPath(file);
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      for (const k of keys) {
        const v = raw[k];
        if (v !== undefined && (state as any)[k] === undefined) {
          (state as any)[k] = v;
        }
      }
    } catch {
      /* skip an unreadable legacy blob */
    }
  }
  return state;
}

export function saveState(state: FleetState): void {
  ensureArchDir();
  writeFileSync(archPath(STORE_FILE), JSON.stringify(state, null, 2), "utf8");
}

export function audit(line: string, state?: FleetState): void {
  ensureArchDir();
  const phase = state ? `phase=${state.currentPhase}` : "";
  appendFileSync(archPath(AUDIT_FILE), `${new Date().toISOString()} ${phase} ${line}\n`, "utf8");
}

// ─── Gates ───────────────────────────────────────────────────────────────────

/** A file counts as produced if it exists and is not an empty placeholder. */
export function artifactSatisfied(file: string): boolean {
  const p = archPath(file);
  if (!existsSync(p)) return false;
  const body = readFileSync(p, "utf8");
  if (/^\*No .* yet\.\*$/m.test(body)) return false;
  const substantive = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("<!--") && !l.startsWith("*Generated by") && !/^\|?-+\|?$/.test(l));
  return substantive.length > 4;
}

export function artifactStatus(): { file: string; phase: number; ok: boolean }[] {
  return Object.entries(ARTIFACT_PHASE).map(([file, phase]) => ({
    file,
    phase,
    ok: existsSync(archPath(file)) && artifactSatisfied(file),
  }));
}

/**
 * Can the job enter phase `n`?
 *
 * Every phase below `n` must have actually produced its artifacts, and the
 * decision queue must be clear. This replaces the old bookkeeping check, which
 * only read booleans the extension set itself and therefore passed when the
 * corresponding documents did not exist.
 */
export function gateForPhase(state: FleetState, n: number): string[] {
  const missed: string[] = [];

  for (let p = 0; p < n; p++) {
    for (const file of ARTIFACTS[p] || []) {
      if (!artifactSatisfied(file)) {
        missed.push(`Phase ${p} (${PHASES[p].label}): ${file} missing or empty`);
      }
    }
  }

  // Verification must have run and must not have rejected.
  if (n > 7) {
    const v = state.verification;
    if (!v || !v.summary) {
      missed.push("Phase 7 (ARCHITECTURE VERIFICATION): /fleet:verify has not produced a verdict");
    } else if (v.summary === "REJECT") {
      missed.push("Phase 7 (ARCHITECTURE VERIFICATION): last verdict was REJECT — fix findings and re-verify");
    }
  }

  // Contract freeze requires a clean decision queue.
  if (n >= 9 && state.decisionsRequired.length > 0) {
    missed.push(
      `Unresolved decisions: ${state.decisionsRequired.join(", ")} (use /fleet:decision resolve <id> <option>)`
    );
  }

  // Implementation requires an actual freeze.
  if (n >= 10 && state.frozenContracts.length === 0) {
    missed.push("Phase 9 (CONTRACT FREEZE): no contracts frozen — run /fleet:contract-freeze");
  }

  return missed;
}

/** Which artifacts still stand between the job and phase `n`. */
export function blockersBefore(state: FleetState, n: number): string[] {
  return gateForPhase(state, n);
}

// ─── Write gate ──────────────────────────────────────────────────────────────

const WRITE_TOOLS = new Set(["write", "edit", "multi_edit", "multiedit", "patch", "apply_patch"]);
const MUTATING_BASH = [
  /\bgit\s+commit\b/,
  /\brm\s+-[a-z]*r/,
  /\bnpm\s+(install|i|publish)\b/,
  /\bcargo\s+(add|publish)\b/,
  /\bgo\s+get\b/,
  /\bpip\s+install\b/,
  /\bcurl\b.*\|\s*(ba)?sh/,
];

function targetPathOf(input: any): string | null {
  if (!input || typeof input !== "object") return null;
  for (const k of ["file_path", "filePath", "path", "target", "filename"]) {
    if (typeof input[k] === "string") return input[k];
  }
  return null;
}

function insideArchitecture(p: string): boolean {
  const rel = relative(archPath(), resolve(cwd(), p));
  return !rel.startsWith("..") && !rel.startsWith("/") && rel !== "";
}

/**
 * The enforcement layer.
 *
 * Returns a block verdict, or null to allow. This is what turns phase order
 * from a document the model reads into a rule the model cannot route around:
 * a write tool call is refused before it reaches the filesystem.
 */
export function evaluateWriteGate(
  state: FleetState,
  toolName: string,
  input: any
): { block: true; reason: string } | null {
  const phase = state.currentPhase;

  if (WRITE_TOOLS.has(toolName)) {
    const target = targetPathOf(input);
    if (!target) return null;

    if (insideArchitecture(target)) {
      const file = target.split(/[\\/]/).pop() || "";
      const owner = ARTIFACT_PHASE[file];

      if (owner === undefined) return null;

      if (phase < owner) {
        return {
          block: true,
          reason:
            `Fleet gate: ${file} belongs to Phase ${owner} (${PHASES[owner].label}), ` +
            `but the job is in Phase ${phase} (${PHASES[phase].label}). ` +
            `Advance with fleet_advance_phase once the earlier artifacts exist.`,
        };
      }

      if (phase >= FREEZE_PHASE && owner < FREEZE_PHASE) {
        return {
          block: true,
          reason:
            `Fleet gate: contracts are frozen at Phase ${FREEZE_PHASE}; ` +
            `${file} (Phase ${owner}) is immutable. Open a decision to revise it.`,
        };
      }

      return null;
    }

    // Implementation code requires frozen contracts.
    if (phase < IMPLEMENTATION_PHASE) {
      return {
        block: true,
        reason:
          `Fleet gate: the job is in Phase ${phase} (${PHASES[phase].label}). ` +
          `Implementation writes outside ${ARCH_DIR}/ are only permitted from Phase ` +
          `${IMPLEMENTATION_PHASE} (CONTRACT FREEZE), reached via fleet_advance_phase.`,
      };
    }

    return null;
  }

  if (toolName === "bash" || toolName === "shell") {
    const cmd = typeof input?.command === "string" ? input.command : "";
    if (!cmd) return null;
    if (phase < IMPLEMENTATION_PHASE && MUTATING_BASH.some((re) => re.test(cmd))) {
      return {
        block: true,
        reason:
          `Fleet gate: '${cmd.trim().slice(0, 60)}' mutates state and the job is in Phase ` +
          `${phase} (${PHASES[phase].label}). Planning artifacts only until Phase ${IMPLEMENTATION_PHASE}.`,
      };
    }
    return null;
  }

  return null;
}

/** Register the write gate. Idempotent per extension instance. */
export function installEnforcement(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event: any, _ctx: any) => {
    const state = loadState();
    if (!state.job.objective) return null; // no job — nothing to enforce
    const verdict = evaluateWriteGate(state, event.toolName, event.input);
    if (!verdict) return null;
    audit(`BLOCK ${event.toolName} — ${verdict.reason}`);
    return verdict;
  });
}

// ─── Narration ───────────────────────────────────────────────────────────────

/** Compact state brief injected at before_agent_start so the model knows the rules. */
export function phaseBrief(state: FleetState): string {
  if (!state.job.objective) return "";
  const phase = PHASES[state.currentPhase];
  const lines: string[] = [];
  lines.push(`## Macro Architecture Fleet — active`);
  lines.push(`Job: ${state.job.objective}`);
  lines.push(`Current phase: ${state.currentPhase} (${phase.label})`);

  const next = state.currentPhase + 1;
  const blockers = gateForPhase(state, next);
  if (blockers.length === 0 && next <= MAX_PHASE) {
    lines.push(`Next phase ${next} (${PHASES[next].label}) is UNBLOCKED — call fleet_advance_phase when ready.`);
  } else if (blockers.length > 0) {
    lines.push(`Blocked from Phase ${next}:`);
    for (const b of blockers) lines.push(`  - ${b}`);
  }

  if (state.decisionsRequired.length > 0) {
    lines.push(`Decisions awaiting a human: ${state.decisionsRequired.join(", ")} — do not guess, surface them.`);
  }
  if (phase.currentPhase >= FREEZE_PHASE) {
    lines.push(`Contracts are frozen. Design artifacts in ${ARCH_DIR}/ are immutable; propose changes as decisions.`);
  }
  lines.push(
    `Write flow: use the fleet_* tools to record architecture. Direct writes to ${ARCH_DIR}/ are gated by phase.`
  );
  return lines.join("\n");
}

// ─── Registry parser ─────────────────────────────────────────────────────────

export interface ParsedBlock {
  id: string;
  name: string;
  fields: Record<string, string>;
  bullets: Record<string, string[]>;
  sections: Record<string, string>;
}

/**
 * Read a registry document back into structure.
 *
 * This exists so verification can inspect the architecture rather than grep for
 * magic strings. It parses the exact shape the fleet-* writers emit:
 *   `## ID — Name`, `**Field:** value`, `### Section`, `- bullet`.
 */
export function parseRegistry(md: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const lines = md.split("\n");

  let cur: ParsedBlock | null = null;
  let section: string | null = null;

  const closeSection = () => {
    if (cur && section) {
      cur.sections[section] = (cur.sections[section] || "").trim();
    }
    section = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    // A horizontal rule ends the current section. Without this the rule text
    // leaks into the previous section's body.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      closeSection();
      continue;
    }

    const h2 = line.match(/^##\s+([A-Z]+-\w+)\s*[—–-]\s*(.+)$/);
    if (h2) {
      closeSection();
      if (cur) blocks.push(cur);
      cur = { id: h2[1], name: h2[2].trim(), fields: {}, bullets: {}, sections: {} };
      section = null;
      continue;
    }

    if (!cur) continue;

    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      closeSection();
      section = h3[1].trim();
      if (!cur.bullets[section]) cur.bullets[section] = [];
      if (!cur.sections[section]) cur.sections[section] = "";
      continue;
    }

    const field = line.match(/^\*\*([^*]+?):\*\*\s*(.*)$/);
    if (field) {
      cur.fields[field[1].trim()] = field[2].trim();
      // Support the combined form: **Status:** draft  **Version:** 1
      const extra = field[2].match(/\*\*([^*]+?):\*\*\s*([^*]*)/);
      if (extra) cur.fields[extra[1].trim()] = extra[2].trim();
      continue;
    }

    const bullet = line.match(/^-\s+(.*)$/);
    if (bullet && section) {
      cur.bullets[section].push(bullet[1].trim());
      continue;
    }

    if (section && line.trim()) {
      cur.sections[section] += (cur.sections[section] ? "\n" : "") + line.trim();
    }
  }

  closeSection();
  if (cur) blocks.push(cur);
  return blocks;
}

export function readRegistry(file: string): ParsedBlock[] | null {
  const p = archPath(file);
  if (!existsSync(p)) return null;
  try {
    return parseRegistry(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Every FMT-/MOD- id mentioned anywhere in a registry document. */
export function refsIn(block: ParsedBlock, keys: string[]): string[] {
  const out = new Set<string>();
  const scan = (s: string) => {
    for (const m of s.matchAll(/\b((?:FMT|MOD|DEP|EXT)-[A-Za-z0-9_-]+)\b/g)) out.add(m[1]);
  };
  for (const k of keys) if (block.fields[k]) scan(block.fields[k]);
  for (const k of keys) for (const b of block.bullets[k] || []) scan(b);
  return Array.from(out);
}