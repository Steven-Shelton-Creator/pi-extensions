/**
 * fleet-core :: shared state, gates, and enforcement for the pi-force
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
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from "node:fs";
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

// ─── Target ──────────────────────────────────────────────────────────────────
//
// `architecture/` describes a *target*: the system being architected. It is not
// the session's working directory, and it is never the literal `/architecture`.
// Before this existed, cwd() stood in for the target, which meant the gate
// governed whatever tree pi happened to be launched in — and, because the gate
// refused every write outside architecture/, launching pi in $HOME silently
// put the whole home directory under phase lock.
//
// The target is therefore a user input, resolved in this order:
//
//   1. FLEET_TARGET                      (environment — one-off or scripted)
//   2. .pi/fleet-target.json  at cwd    (session intent; committable)
//   3. .pi/fleet-target.json  at root   (a project carrying its own identity)
//   4. the job's pinned target           (recorded at /fleet:new-job)
//   5. cwd, flagged `inferred`           (never silent — see targetStatus)
//
// ARCH_DIR remains the default *name* of the artifact directory inside the
// target, and is overridable per-target for stations with their own convention.

export const TARGET_CONFIG_PATH = ".pi/fleet-target.json";

/** What the gate does with a write that lands outside the target. */
export type OutOfScopePolicy = "audit" | "block";

export interface TargetConfig {
  /** Absolute path to the system being architected. */
  root: string;
  /** Artifact directory name, relative to root. */
  archDir: string;
  /** Handling of writes outside `root`. */
  outOfScope: OutOfScopePolicy;
  /** Where the value came from — surfaced, never hidden. */
  source: "env" | "config-cwd" | "config-root" | "job" | "inferred";
  /** True when no source declared a target and cwd was assumed. */
  inferred: boolean;
}

export const DEFAULT_ARCH_DIR = ARCH_DIR;
// Default is deny, not audit. An out-of-target write is out of this job's
// business either way, but "recorded" is a promise the agent can fulfil later
// and usually does not; "refused" is a boundary that holds on the first try.
// Widen deliberately with `outOfScope: "audit"` when auditing is what you want.
export const DEFAULT_OUT_OF_SCOPE: OutOfScopePolicy = "block";

let cachedTarget: { key: string; config: TargetConfig } | null = null;

function readTargetConfigFile(at: string): { root?: string; archDir?: string; outOfScope?: string } | null {
  const p = join(at, TARGET_CONFIG_PATH);
  try {
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

function normalizeOutOfScope(v: unknown): OutOfScopePolicy {
  // Honour 'audit' explicitly. Falling through to the default for anything
  // that is not 'block' makes 'audit' unreachable the moment the default is
  // 'block' — the lenient policy would silently be a deny policy.
  return v === "audit" ? "audit" : DEFAULT_OUT_OF_SCOPE;
}

interface PinnedTarget {
  root: string;
  archDir: string;
  outOfScope?: string;
  source: "config-root" | "config-cwd" | "job";
}

/**
 * Read a target declared by something other than cwd's config file — either a
 * `.pi/fleet-target.json` sitting in the target it names, or the target pinned
 * inside an existing job store. Both are located by direct path from cwd.
 */
function readPinnedTarget(here: string): PinnedTarget | null {
  // The store may sit under a non-default archDir; collect both candidates.
  const archDirs = new Set<string>([DEFAULT_ARCH_DIR]);
  const cfg = readTargetConfigFile(here);
  if (cfg?.archDir?.trim()) archDirs.add(cfg.archDir.trim());

  for (const dir of archDirs) {
    const storePath = join(here, dir, STORE_FILE);
    try {
      if (!existsSync(storePath)) continue;
      const job = JSON.parse(readFileSync(storePath, "utf8"))?.job;
      if (!job?.targetRoot) continue;
      return {
        root: resolve(here, job.targetRoot),
        archDir: job.archDir?.trim() || dir,
        outOfScope: job.out_of_scope,
        source: "job",
      };
    } catch {
      /* unreadable or corrupt store — keep looking */
    }
  }

  // No job yet: a config file at cwd may name a root that carries its own copy.
  if (cfg?.root) {
    const root = resolve(here, cfg.root);
    const own = readTargetConfigFile(root);
    if (own && root !== here) {
      return {
        root: resolve(root, own.root || "."),
        archDir: own.archDir?.trim() || cfg.archDir?.trim() || DEFAULT_ARCH_DIR,
        outOfScope: own.outOfScope ?? cfg.outOfScope,
        source: "config-root",
      };
    }
    return {
      root,
      archDir: cfg.archDir?.trim() || DEFAULT_ARCH_DIR,
      outOfScope: cfg.outOfScope,
      source: "config-cwd",
    };
  }

  return null;
}

/**
 * Resolve the target. Pure with respect to the filesystem — it reads config but
 * creates nothing, so it is safe to call from the tool_call hook.
 */
export function targetConfig(): TargetConfig {
  const here = cwd();
  const envRoot = process.env.FLEET_TARGET?.trim();

  if (envRoot) {
    return { root: resolve(here, envRoot), archDir: DEFAULT_ARCH_DIR, outOfScope: DEFAULT_OUT_OF_SCOPE, source: "env", inferred: false };
  }

  for (const [at, source] of [[here, "config-cwd"]] as const) {
    const raw = readTargetConfigFile(at);
    if (raw?.root) {
      return {
        root: resolve(at, raw.root),
        archDir: raw.archDir?.trim() || DEFAULT_ARCH_DIR,
        outOfScope: normalizeOutOfScope(raw.outOfScope),
        source,
        inferred: false,
      };
    }
  }

  // A project may carry its own identity, and an existing job pins its target
  // at /fleet:new-job. Both are read by path from cwd — never through
  // archDirName(), which would resolve the target by asking the target.
  const pinned = readPinnedTarget(here);
  if (pinned) {
    return {
      root: pinned.root,
      archDir: pinned.archDir,
      outOfScope: normalizeOutOfScope(pinned.outOfScope),
      source: pinned.source,
      inferred: false,
    };
  }

  return { root: here, archDir: DEFAULT_ARCH_DIR, outOfScope: DEFAULT_OUT_OF_SCOPE, source: "inferred", inferred: true };
}

function keyFor(cfg: TargetConfig): string {
  return `${cfg.root}|${cfg.archDir}|${cfg.outOfScope}|${cfg.source}`;
}

function targetConfigCached(): TargetConfig {
  const cfg = targetConfig();
  if (cachedTarget && cachedTarget.key === keyFor(cfg)) return cachedTarget.config;
  cachedTarget = { key: keyFor(cfg), config: cfg };
  return cfg;
}

/** Drop the memoized target. Required after anything writes a target config. */
export function resetTargetCache(): void {
  cachedTarget = null;
}

/** Absolute path to the system being architected. */
export function targetRoot(): string {
  return targetConfigCached().root;
}

/** Name of the artifact directory inside the target. */
export function archDirName(): string {
  return targetConfigCached().archDir;
}

/**
 * Path relative to the target root, or null when the path lies outside it.
 * The root itself yields "" — inside, and not inside any subdirectory.
 */
export function relToTarget(p: string): string | null {
  const abs = resolve(targetRoot(), p);
  const rel = relative(targetRoot(), abs);
  if (rel === "") return "";
  if (rel.startsWith("..") || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return null;
  return rel;
}

export function isInsideTarget(p: string): boolean {
  return relToTarget(p) !== null;
}

/** One line naming the target and where it came from. Never empty. */
export function targetStatus(): string {
  const t = targetConfigCached();
  const where = t.source === "inferred" ? "inferred from cwd — set a target" : `from ${t.source}`;
  return `Target: ${t.root} · artifacts in ${t.archDir}/ · ${where}`;
}

export function archPath(...parts: string[]): string {
  return join(targetRoot(), archDirName(), ...parts);
}

export function ensureArchDir(): string {
  const p = archPath();
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  return p;
}

// ─── State ───────────────────────────────────────────────────────────────────

export interface Job {
  objective: string;
  /** Absolute path to the system this job architectures. Pinned at /fleet:new-job. */
  targetRoot: string;
  /** Artifact directory name inside the target. Defaults to ARCH_DIR. */
  archDir: string;
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
  /** `phase` is written by fleet-verify and read by the gate's staleness check. */
  verification?: { ranAt?: string; phase?: number; summary?: string; results?: any[] } | null;
  decisions?: Record<string, Decision>;
}

export function emptyState(): FleetState {
  return {
    job: {
      objective: "",
      targetRoot: "",
      archDir: DEFAULT_ARCH_DIR,
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

// ─── Abort (C4) ─────────────────────────────────────────────────────────────
//
// Nothing in the fleet is long-running, so this does not make anything
// interruptible. It removes one correctness hazard: a turn aborted between an
// operation's computation and its saveState could still persist.

export function aborted(signal?: AbortSignal): boolean {
  return !!signal?.aborted;
}

export const ABORTED_RESULT = {
  content: [{ type: "text" as const, text: "Aborted before persisting." }],
  details: { aborted: true },
};

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

const DEFAULT_WRITE_TOOLS = ["write", "edit", "multi_edit", "multiedit", "patch", "apply_patch"];
const DEFAULT_SHELL_TOOLS = ["bash", "shell"];

// ─── Shell tokenizer (C1) ────────────────────────────────────────────────────
//
// Replaces the 0.2.0 regex list, which matched anywhere in the line: it fired on
// `echo "git commit"`, missed `git -c k=v commit`, and blocked `/usr/bin/git`
// while allowing the hypothetical `./GIT` would not be. Classification is now by
// command name plus argument inspection, case-sensitively, against a basename.

export interface ShellSegment {
  argv: string[];
  raw: string;
  redirects: boolean;
  /** True when this segment receives the output of a preceding pipe. */
  piped: boolean;
}

const SEPARATORS = ["&&", "||", ";", "|", "\n"];

/** Split a command line into segments, honouring single and double quotes. */
export function tokenizeShell(command: string): ShellSegment[] {
  if (!command || typeof command !== "string") return [];

  const segments: ShellSegment[] = [];
  const nested: ShellSegment[] = [];   // command substitutions, appended at the end
  let argv: string[] = [];
  let current = "";
  let raw = "";
  let redirects = false;
  let quote: '"' | "'" | null = null;
  let pipeNext = false;

  const endToken = () => {
    if (current !== "") { argv.push(current); current = ""; }
  };

  const flush = (piped: boolean) => {
    endToken();
    if (argv.length > 0 || raw.trim()) {
      segments.push({ argv, raw: raw.trim(), redirects, piped });
    }
    argv = [];
    raw = "";
    redirects = false;
    // pipeNext is NOT reset here — the caller clears it after a separator has
    // been consumed, so that the *next* segment is the one marked as destination.
  };

  let i = 0;
  while (i < command.length) {
    const ch = command[i];

    if (quote) {
      if (ch === quote) { quote = null; i++; continue; }
      if (quote === '"' && ch === "\\" && i + 1 < command.length) {
        current += command[i + 1];
        raw += ch + command[i + 1];
        i += 2;
        continue;
      }
      current += ch;
      raw += ch;
      i++;
      continue;
    }

    // Redirection is mutation even when it targets a harmless command.
    if (ch === ">") {
      endToken();
      redirects = true;
      raw += ch;
      i++;
      continue;
    }

    const two = command.slice(i, i + 2);
    if (SEPARATORS.includes(two)) {
      // The NEXT segment is the pipe destination, not this one. Marking the
      // source made the interpreter rule dead code and let the curl rule work
      // only by accident.
      flush(pipeNext);
      pipeNext = two === "|";
      i += 2;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "\n") {
      flush(pipeNext);
      pipeNext = ch === "|";
      i++;
      continue;
    }

    if (/\s/.test(ch)) {
      endToken();
      raw += ch;
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      raw += ch;
      i++;
      continue;
    }

    // Command substitution: $( ... ) and ` ... `. The inner text is tokenized
    // and classified as its own segments, because anything that mutates inside
    // a substitution mutates the same as if it had been typed directly.
    if (ch === "`") {
      const end = command.indexOf("`", i + 1);
      const inner = end === -1 ? command.slice(i + 1) : command.slice(i + 1, end);
      nested.push(...tokenizeShell(inner));
      raw += inner;
      i = end === -1 ? command.length : end + 1;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < command.length; j++) {
        if (command[j] === "(") depth++;
        else if (command[j] === ")") { depth--; if (depth === 0) break; }
      }
      const inner = command.slice(i + 2, j);
      nested.push(...tokenizeShell(inner));
      raw += inner;
      i = j < command.length ? j + 1 : command.length;
      continue;
    }
    // ${...} is variable expansion, not a command — consume it as one token.
    if (ch === "$" && command[i + 1] === "{") {
      const end = command.indexOf("}", i + 2);
      const stop = end === -1 ? command.length : end + 1;
      current += command.slice(i, stop);
      raw += command.slice(i, stop);
      i = stop;
      continue;
    }

    current += ch;
    raw += ch;
    i++;
  }

  flush(pipeNext);
  return [...segments, ...nested];
}

const WRAPPERS = new Set(["sudo", "env", "command", "nohup", "time", "nice", "doas", "xargs"]);

/** Strip env assignments and wrappers; return the basename of the real command. */
function bareCommand(argv: string[]): string | null {
  let i = 0;
  // Assignments and wrappers may interleave: `env FOO=1 sudo rm -rf /x`.
  for (;;) {
    if (i >= argv.length) return null;
    const t = argv[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }
    if (WRAPPERS.has(t)) { i++; continue; }
    break;
  }
  const token = argv[i];
  if (!token) return null;
  const parts = token.split(/[\\/]/);
  return parts[parts.length - 1];
}

/** git short options that consume the following token as their value. */
const VCS_SHORT_WITH_VALUE = new Set(["C", "c", "f", "p"]);
/** git long options that consume the following token as their value. */
const VCS_LONG_WITH_VALUE = new Set([
  "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env",
]);

/**
 * Subcommand for revision-control tools, which accept options before it.
 *
 * `git -c user.email=x commit`, `git -C /repo commit` and
 * `git --work-tree=/tmp commit` all put a flag ahead of the verb. Missing these
 * resolves the subcommand to a flag and the mutation is never seen.
 */
function vcsSubcommand(argv: string[]): string | null {
  let i = 1;
  while (i < argv.length) {
    const t = argv[i];
    if (!t.startsWith("-")) return t;
    if (t.includes("=")) { i += 1; continue; }               // --work-tree=/tmp
    if (t.startsWith("--")) {                                // --git-dir /path
      i += VCS_LONG_WITH_VALUE.has(t) ? 2 : 1;
      continue;
    }
    if (t.length === 2) {                                    // -C /repo  |  -c k=v
      i += VCS_SHORT_WITH_VALUE.has(t.slice(1)) ? 2 : 1;
      continue;
    }
    i += 1;                                                  // -ab combined flags
  }
  return null;
}

const VCS_MUTATIONS: Record<string, string[]> = {
  git: ["commit", "merge", "rebase", "push", "reset", "revert", "cherry-pick", "clean", "filter-branch"],
  hg: ["commit", "push", "rebase"],
  svn: ["commit", "delete"],
};

const PACKAGE_MANAGERS: Record<string, string[]> = {
  npm: ["install", "i", "ci", "publish", "add"],
  cargo: ["add", "publish", "install"],
  go: ["get", "install"],
  pip: ["install", "uninstall"],
  pip3: ["install", "uninstall"],
  gem: ["install"],
  apt: ["install", "remove", "purge"],
  "apt-get": ["install", "remove", "purge"],
  brew: ["install", "uninstall"],
};

const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "ksh", "dash", "fish"]);

/**
 * Classify a segment as a mutation.
 *
 * Returns null when the segment does not mutate. `extra` lets `.pi/fleet-gate.json`
 * add commands without editing source.
 */
export function classifySegment(
  seg: ShellSegment,
  extra: Record<string, string[]> = {}
): { kind: string; why: string } | null {
  const name = bareCommand(seg.argv);
  if (!name) return null;

  // A pipe whose destination is a shell interpreter is remote execution,
  // regardless of what fed it and of what flags the interpreter carries.
  // `curl x | sh`, `cat s.sh | bash -s`, `make | sh` all land here.
  if (seg.piped && SHELL_INTERPRETERS.has(name)) {
    return { kind: "remote-exec", why: `pipe into ${name}` };
  }

  // `bash -c '<command>'` runs an inline command; classify the payload.
  if (SHELL_INTERPRETERS.has(name)) {
    const cIdx = seg.argv.indexOf("-c");
    if (cIdx !== -1 && seg.argv[cIdx + 1]) {
      const inner = classifyCommand(seg.argv[cIdx + 1], extra);
      if (inner.length > 0) {
        return {
          kind: "remote-exec",
          why: `${name} -c '${seg.argv[cIdx + 1].slice(0, 40)}' (${inner[0].kind})`,
        };
      }
    }
  }

  if (VCS_MUTATIONS[name]) {
    const sub = vcsSubcommand(seg.argv);
    if (sub && VCS_MUTATIONS[name].includes(sub)) {
      return { kind: "vcs-mutation", why: `${name} ${sub}` };
    }
  }

  if (PACKAGE_MANAGERS[name]) {
    const sub = seg.argv.slice(1).find((t) => !t.startsWith("-"));
    if (sub && PACKAGE_MANAGERS[name].includes(sub)) {
      return { kind: "package-install", why: `${name} ${sub}` };
    }
  }

  const extraSubs = extra[name];
  if (extraSubs && seg.argv.slice(1).some((t) => extraSubs.includes(t))) {
    return { kind: "external-mutation", why: `${name} ${seg.argv.slice(1).find((t) => extraSubs.includes(t))}` };
  }

  if (name === "rm") {
    const recursive = seg.argv.slice(1).some((t) => /^-[a-zA-Z]*r/.test(t));
    if (recursive) return { kind: "destructive-fs", why: "rm -r" };
  }
  if (name === "find" && seg.argv.includes("-delete")) {
    return { kind: "destructive-fs", why: "find -delete" };
  }
  if (["dd", "mkfs", "shred", "fdisk", "parted"].includes(name)) {
    return { kind: "destructive-fs", why: name };
  }
  if (name === "tee") {
    return { kind: "redirect-write", why: "tee" };
  }

  if (seg.redirects) {
    return { kind: "redirect-write", why: "output redirection" };
  }

  return null;
}

/** Every mutating segment in a command line, with the ones that failed to parse. */
export function classifyCommand(
  command: string,
  extra: Record<string, string[]> = {}
): { kind: string; why: string }[] {
  const hits: { kind: string; why: string }[] = [];
  let segments: ShellSegment[] = [];
  try {
    segments = tokenizeShell(command);
  } catch {
    return hits; // fail open on tokenizer error
  }
  for (const seg of segments) {
    const hit = classifySegment(seg, extra);
    if (hit) hits.push(hit);
  }
  return hits;
}

// ─── Gate config (C5) ───────────────────────────────────────────────────────
//
// Coverage is declared, not buried. Defaults reproduce 0.2.0 behaviour exactly,
// so an absent file changes nothing. Deliberately outside architecture/, which
// is gitignored workspace output — this is config a user must be able to commit.

export const GATE_CONFIG_PATH = ".pi/fleet-gate.json";

export interface GateConfig {
  enabled: boolean;
  writeTools: string[];
  shellTools: string[];
  extraMutatingCommands: Record<string, string[]>;
  sessionGuards: boolean;
  /** Refuse writes when the target was only inferred from cwd, never declared. */
  requireDeclaredTarget: boolean;
  /** Freeze a job's target once it exists. More repositories means more agents. */
  pinTarget: boolean;
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  enabled: true,
  writeTools: DEFAULT_WRITE_TOOLS,
  shellTools: DEFAULT_SHELL_TOOLS,
  extraMutatingCommands: {},
  sessionGuards: true,
  requireDeclaredTarget: true,
  pinTarget: true,
};

let cachedConfig: { mtime: number; config: GateConfig } | null = null;

export function loadGateConfig(): GateConfig {
  const p = join(cwd(), GATE_CONFIG_PATH);
  try {
    const mtime = existsSync(p) ? statSync(p).mtimeMs : 0;
    if (cachedConfig && cachedConfig.mtime === mtime) return cachedConfig.config;

    if (!existsSync(p)) {
      cachedConfig = { mtime, config: { ...DEFAULT_GATE_CONFIG } };
      return cachedConfig.config;
    }
    const raw = JSON.parse(readFileSync(p, "utf8"));
    cachedConfig = {
      mtime,
      config: {
        enabled: raw.enabled !== false,
        writeTools: Array.isArray(raw.writeTools) && raw.writeTools.length
          ? raw.writeTools : DEFAULT_WRITE_TOOLS,
        shellTools: Array.isArray(raw.shellTools) && raw.shellTools.length
          ? raw.shellTools : DEFAULT_SHELL_TOOLS,
        extraMutatingCommands: raw.extraMutatingCommands && typeof raw.extraMutatingCommands === "object"
          ? raw.extraMutatingCommands : {},
        sessionGuards: raw.sessionGuards !== false,
        requireDeclaredTarget: raw.requireDeclaredTarget !== false,
        pinTarget: raw.pinTarget !== false,
      },
    };
    return cachedConfig.config;
  } catch {
    return { ...DEFAULT_GATE_CONFIG };
  }
}

export interface GateCoverage {
  enabled: boolean;
  configPath: string;
  writeTools: string[];
  shellTools: string[];
  extraMutatingCommands: Record<string, string[]>;
  sessionGuards: boolean;
  enforced: string[];
  unenforced: string[];
}

/** What the gate reaches, and — more usefully — what it does not. */
export function gateCoverage(): GateCoverage {
  const cfg = loadGateConfig();
  return {
    enabled: cfg.enabled,
    configPath: GATE_CONFIG_PATH,
    writeTools: cfg.writeTools,
    shellTools: cfg.shellTools,
    extraMutatingCommands: cfg.extraMutatingCommands,
    sessionGuards: cfg.sessionGuards,
    enforced: [
      ...cfg.writeTools.map((t) => `${t} (path-scoped)`),
      ...cfg.shellTools.map((t) => `${t} (command-classified)`),
    ],
    unenforced: [
      "writes outside the target when outOfScope is 'audit' (default is 'block' — refused before the implementation phase)",
      "writes issued by MCP servers (not tool calls in this process)",
      "writes by subprocesses spawned by other extensions",
      "writes from extensions that return their own tool_call verdict",
      "in-process mutation via pi.exec or direct fs calls",
      "shell commands that tokenize to nothing (empty/blank input)",
    ],
  };
}

function targetPathOf(input: any): string | null {
  if (!input || typeof input !== "object") return null;
  for (const k of ["file_path", "filePath", "path", "target", "filename"]) {
    if (typeof input[k] === "string") return input[k];
  }
  return null;
}

function insideArchitecture(p: string): boolean {
  // Scoped to the target, not to cwd: architecture/ is a directory *inside* the
  // system being architected, wherever that system happens to live.
  const abs = resolve(targetRoot(), p);
  const rel = relative(archPath(), abs);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/");
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
  input: any,
  config: GateConfig = loadGateConfig()
): { block: true; reason: string } | null {
  if (!config.enabled) return null;
  const phase = state.currentPhase;

  if (config.writeTools.includes(toolName)) {
    const target = targetPathOf(input);
    if (!target) return null;

    // An inferred target is not an assignment. If nothing declared a target,
    // cwd is standing in for one — the same defect class as the 0.1.0
    // self-seeding and 0.3.0 stale-verdict bugs. Refuse, and say how to fix it.
    if (config.requireDeclaredTarget && targetConfigCached().inferred) {
      return {
        block: true,
        reason:
          `Fleet gate: no target is declared, so the target is inferred from the ` +
          `working directory (${cwd()}) and nothing here has been assigned. Declare one ` +
          `with /fleet:target <path>, the fleet_set_target tool, or FLEET_TARGET.`,
      };
    }

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

    // Implementation code requires frozen contracts — but only *within* the
    // target. A write outside the target is not this job's business, so it is
    // recorded rather than refused unless the policy says otherwise.
    if (phase < IMPLEMENTATION_PHASE) {
      const rel = relToTarget(target);
      if (rel === null) {
        if (targetConfigCached().outOfScope === "block") {
          return {
            block: true,
            reason:
              `Fleet gate: ${target} is outside the target ` +
              `(${targetRoot()}) and the job is in Phase ${phase} ` +
              `(${PHASES[phase].label}). outOfScope is 'block'. ` +
              `Widen the target with /fleet:target <path>, or write to the project.`,
          };
        }
        return null;
      }
      return {
        block: true,
        reason:
          `Fleet gate: the job is in Phase ${phase} (${PHASES[phase].label}). ` +
          `Implementation writes inside ${targetRoot()} are only permitted from Phase ` +
          `${IMPLEMENTATION_PHASE} (CONTRACT FREEZE), reached via fleet_advance_phase.`,
      };
    }

    return null;
  }

  if (config.shellTools.includes(toolName)) {
    const cmd = typeof input?.command === "string" ? input.command : "";
    if (!cmd) return null;
    if (phase >= IMPLEMENTATION_PHASE) return null;

    const hits = classifyCommand(cmd, config.extraMutatingCommands);
    if (hits.length === 0) return null;

    const why = hits.map((h) => `${h.why} [${h.kind}]`).join(", ");
    return {
      block: true,
      reason:
        `Fleet gate: '${cmd.trim().slice(0, 60)}' mutates state (${why}) and the job is in ` +
        `Phase ${phase} (${PHASES[phase].label}). Planning artifacts only until Phase ${IMPLEMENTATION_PHASE}.`,
    };
  }

  return null;
}

/** Register the write gate. Idempotent per extension instance. */
export function installEnforcement(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event: any, _ctx: any) => {
    const state = loadState();
    if (!state.job.objective) return null; // no job — nothing to enforce
    const verdict = evaluateWriteGate(state, event.toolName, event.input);
    if (!verdict) {
      // Out-of-scope writes are allowed but never invisible.
      if (targetConfigCached().outOfScope === "audit" &&
          loadGateConfig().writeTools.includes(event.toolName)) {
        const t = targetPathOf(event.input);
        if (t && relToTarget(t) === null) {
          audit(`OUT-OF-SCOPE ${event.toolName} ${t} (target: ${targetRoot()})`, state);
        }
      }
      return null;
    }
    audit(`BLOCK ${event.toolName} — ${verdict.reason}`);
    return verdict;
  });

  // ── Session guards (C3) ────────────────────────────────────────────────
  //
  // Narrow on purpose: losing unresolved decisions at contract-freeze time is
  // unrecoverable; losing them at Phase 2 is not. Never a trap — `sessionGuards:
  // false` disables it, and every cancel is audited so the block is visible.

  pi.on("session_before_switch", async (_event: any, _ctx: any) => {
    if (!loadGateConfig().sessionGuards) return null;
    const state = loadState();
    if (!state.job.objective) return null;
    if (state.decisionsRequired.length === 0) return null;
    if (state.currentPhase < 8) {
      audit(`session switch allowed at phase ${state.currentPhase} with ${state.decisionsRequired.length} open decision(s)`);
      return null;
    }
    const why =
      `Fleet gate: ${state.decisionsRequired.length} decision(s) unresolved at Phase ${state.currentPhase} ` +
      `(${state.decisionsRequired.join(", ")}). Resolving them or setting sessionGuards:false in ` +
      `${GATE_CONFIG_PATH} allows the switch.`;
    audit(`session switch cancelled — ${why}`);
    return { cancel: true, reason: why };
  });

  pi.on("session_before_fork", async (_event: any, _ctx: any) => {
    // Fork copies state; losing nothing. Audited, never blocked.
    const state = loadState();
    if (state.job.objective) {
      audit(`session fork allowed at phase ${state.currentPhase}`);
    }
    return null;
  });
}

// ─── Narration ───────────────────────────────────────────────────────────────

/** Compact state brief injected at before_agent_start so the model knows the rules. */
export function phaseBrief(state: FleetState): string {
  if (!state.job.objective) return "";
  const phase = PHASES[state.currentPhase];
  const lines: string[] = [];
  lines.push(`## pi-force — active`);
  lines.push(`Job: ${state.job.objective}`);
  lines.push(`Target: ${targetRoot()} (artifacts in ${archDirName()}/)`);
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
  if (state.currentPhase >= FREEZE_PHASE) {
    lines.push(`Contracts are frozen. Design artifacts in ${archDirName()}/ are immutable; propose changes as decisions.`);
  }
  lines.push(
    `Write flow: use the fleet_* tools to record architecture. Direct writes to ` +
    `${targetRoot()}/${archDirName()}/ are gated by phase; writes elsewhere in the target ` +
    `need Phase ${IMPLEMENTATION_PHASE}. Writes outside the target are out of scope.`
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