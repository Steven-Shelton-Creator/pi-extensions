/**
 * fleet-verify :: Phase 7 — Structural architecture verification
 *
 * This replaces the previous implementation, which tested architecture by
 * searching the markdown for magic strings:
 *
 *     content.includes("Storage hidden: ✅")
 *     (content.match(/responsibility/gi) || []).length <= 3
 *
 * Those tests could not fail for the reason they claimed to. "Alternative
 * implementation" is emitted unconditionally by the writer, so that test was
 * vacuous; the word count was a proxy for a concept; and the two registries
 * serialize the same field with different labels and inverted polarity, so the
 * format-registry assertions failed against a correctly written interface
 * registry.
 *
 * This version parses the registries back into structure and checks properties
 * of the architecture itself:
 *
 *   - cross-reference integrity (every FMT-/MOD-/DEP-/EXT- id resolves)
 *   - module dependency graph is acyclic
 *   - contracts actually withhold implementation detail
 *   - modules own bounded state and declare a test strategy
 *
 * A REJECT verdict is reachable and blocks the transition to Phase 9.
 *
 * Usage: pi -e extensions/fleet-verify.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  PHASES, PRIM_FILE, FMT_FILE, INT_FILE, MOD_FILE, DEP_FILE, VER_FILE,
  archPath, ensureArchDir, loadState, saveState, audit,
  readRegistry, phaseBrief, aborted, ABORTED_RESULT,
} from "./fleet-core.ts";
import type { ParsedBlock, FleetState } from "./fleet-core.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// ─── Drift (C2) ─────────────────────────────────────────────────────────────
//
// The store is the source of truth; the markdown is a rendered view. 0.3.0
// verifies against the store and reports divergence between the two as its own
// finding kind. A stale render is housekeeping, never a design defect, so it
// never contributes to REJECT.

export interface DriftFinding {
  file: string;
  kind: "missing" | "stale" | "unparsable";
  detail: string;
}

function storeIds(items: any[] | undefined): Set<string> {
  return new Set((items || []).map((x: any) => x.id).filter(Boolean));
}

function blockIds(blocks: ParsedBlock[] | null): Set<string> {
  return new Set((blocks || []).map((b) => b.id));
}

/** Compare each rendered document against the store it is supposed to depict. */
export function detectDrift(state: FleetState): DriftFinding[] {
  const findings: DriftFinding[] = [];

  const allContracts = state.contracts || [];
  const interfaceContracts = allContracts.filter((c: any) => c.type === "interface" || c.type === "plugin");

  const pairs: { file: string; store: Set<string> }[] = [
    { file: FMT_FILE, store: storeIds(allContracts) },
    // INT_FILE is deliberately a filtered rendering of the same registry — only
    // interface and plugin contracts. Comparing it against the whole store would
    // report every event/protocol contract as missing.
    { file: INT_FILE, store: storeIds(interfaceContracts) },
    { file: MOD_FILE, store: storeIds(state.modules) },
    // DEP_FILE also renders the adapter table, so adapters are expected in it.
    {
      file: DEP_FILE,
      store: new Set([...storeIds(state.dependencies), ...storeIds(state.adapters)]),
    },
  ];

  for (const { file, store } of pairs) {
    const path = archPath(file);
    if (!existsSync(path)) {
      if (store.size > 0) {
        findings.push({
          file,
          kind: "missing",
          detail: `${store.size} entr(ies) in the store have no rendered document`,
        });
      }
      continue;
    }
    const blocks = readRegistry(file);
    if (!blocks || blocks.length === 0) {
      if (store.size > 0) {
        findings.push({
          file,
          kind: "unparsable",
          detail: "document exists but yields no registry blocks",
        });
      }
      continue;
    }
    const rendered = blockIds(blocks);
    const only = [...store].filter((id) => !rendered.has(id));
    const extra = [...rendered].filter((id) => !store.has(id));
    if (only.length > 0 || extra.length > 0) {
      const bits: string[] = [];
      if (only.length) bits.push(`in store but not rendered: ${only.join(", ")}`);
      if (extra.length) bits.push(`rendered but not in store: ${extra.join(", ")}`);
      findings.push({ file, kind: "stale", detail: bits.join("; ") });
    }
  }
  return findings;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface VerifyTest {
  name: string;
  passed: boolean;
  detail: string;
  severity: "low" | "medium" | "high";
}

export interface VerificationResult {
  id: string;
  target: string;
  targetType: "primitive" | "contract" | "module" | "dependency" | "overall";
  tests: VerifyTest[];
  summary: "PASS" | "PASS_WITH_CORRECTIONS" | "BLOCKED_BY_DECISION" | "REJECT";
  findings: string[];
  rejectedAssumptions: string[];
  requiredCorrections: string[];
}

type Registry = ParsedBlock[] | null;

// ─── Parsing helpers ─────────────────────────────────────────────────────────

const EMPTY_MARKERS = ["_none_", "_none explicitly_", "_not specified_", "_pending_", "_unassigned_", "_none yet_"];

function isEmpty(v: string | undefined): boolean {
  if (!v) return true;
  const t = v.trim().toLowerCase();
  return EMPTY_MARKERS.some((m) => t === m || t.startsWith(m));
}

function bulletItems(block: ParsedBlock, section: string): string[] {
  return (block.bullets[section] || []).filter((b) => !isEmpty(b));
}

/**
 * Normalize the two serialization styles used by the registries.
 *
 *   04_FORMAT_REGISTRY.md   "- Storage hidden: ✅"
 *   06_INTERFACE_REGISTRY.md "- Storage technology exposed? ✅ No"
 *
 * Both encode the same fact with opposite polarity. Anything that reads these
 * documents has to handle both, or it will report correct artifacts as broken.
 */
/** Collapse the several label styles onto a stable dimension key. */
function canonDim(raw: string): string {
  const d = raw.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z_]/g, "");
  if (d.includes("storage")) return "storage";
  if (d.includes("vendor")) return "vendor";
  if (d.includes("platform")) return "platform";
  if (d.includes("algorithm")) return "algorithm";
  if (d.includes("alternative")) return "alternative_implementable";
  return d;
}

function extractFreedom(block: ParsedBlock): { dim: string; ok: boolean }[] {
  const out: { dim: string; ok: boolean }[] = [];

  for (const section of ["Implementation Freedom", "Implementation Freedom Check"]) {
    for (const raw of bulletItems(block, section)) {
      // "Storage technology exposed? ✅ No"  (inverted polarity)
      const formB = raw.match(/^(.+?)\s+exposed\?\s*(?:✅|❌)?\s*(yes|no)?\s*$/i);
      if (formB) {
        const answer = (formB[2] || "").toLowerCase();
        const exposed = answer ? answer === "yes" : /❌/.test(raw) ? true : /✅/.test(raw);
        out.push({ dim: canonDim(formB[1]), ok: !exposed });
        continue;
      }
      // "Can another implementation satisfy this contract? ✅ Yes"
      const formC = raw.match(/^can another implementation satisfy[^?]*?\?\s*(?:✅|❌)?\s*(yes|no)?/i);
      if (formC) {
        const answer = (formC[1] || "").toLowerCase();
        out.push({ dim: "alternative_implementable", ok: answer ? answer === "yes" : /✅/.test(raw) });
        continue;
      }
      // "Storage hidden: ✅" and "Alternative implementation: ✅"
      const formD = raw.match(/^(.+?):\s*(✅|❌)\s*$/);
      if (formD) {
        out.push({ dim: canonDim(formD[1]), ok: formD[2] === "✅" });
        continue;
      }
    }
  }
  return out;
}

function collectRefs(
  blocks: Registry,
  sections: string[],
  prefix: string,
  fields: string[] = []
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!blocks) return map;
  const re = new RegExp(`\\b(${prefix}-[A-Za-z0-9_-]+)\\b`, "g");
  for (const b of blocks) {
    const haystack: string[] = [];
    for (const s of sections) for (const item of bulletItems(b, s)) haystack.push(item);
    for (const f of fields) if (b.fields[f]) haystack.push(b.fields[f]);
    for (const text of haystack) {
      for (const m of text.matchAll(re)) {
        if (m[1] === b.id) continue;
        const list = map.get(b.id) || [];
        if (!list.includes(m[1])) list.push(m[1]);
        map.set(b.id, list);
      }
    }
  }
  return map;
}

/** Tarjan-free cycle detection: iterative DFS with a colour map. */
function findCycles(adj: Map<string, string[]>): string[][] {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map<string, number>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  for (const node of adj.keys()) colour.set(node, WHITE);

  const visit = (start: string) => {
    const work: { node: string; idx: number }[] = [{ node: start, idx: 0 }];
    colour.set(start, GREY);
    stack.push(start);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const neighbours = adj.get(frame.node) || [];

      if (frame.idx < neighbours.length) {
        const next = neighbours[frame.idx++];
        const c = colour.get(next) ?? WHITE;
        if (c === GREY) {
          const start = stack.indexOf(next);
          if (start >= 0) cycles.push([...stack.slice(start), next]);
        } else if (c === WHITE) {
          colour.set(next, GREY);
          stack.push(next);
          work.push({ node: next, idx: 0 });
        }
        continue;
      }

      colour.set(frame.node, BLACK);
      stack.pop();
      work.pop();
    }
  };

  for (const node of adj.keys()) if ((colour.get(node) ?? WHITE) === WHITE) visit(node);
  return cycles;
}

// ─── Verification ────────────────────────────────────────────────────────────

function verifyContracts(blocks: Registry, known: Set<string>, source: string): VerificationResult[] {
  if (!blocks || blocks.length === 0) return [];
  return blocks.map((c) => {
    const tests: VerifyTest[] = [];

    tests.push({
      name: "Semantics documented",
      passed: !isEmpty(c.sections["Semantics"] ?? c.sections["Contract"]),
      detail: isEmpty(c.sections["Semantics"] ?? c.sections["Contract"])
        ? "Contract states no semantics"
        : `${(c.sections["Semantics"] ?? c.sections["Contract"]).split(/\s+/).length} words`,
      severity: "medium",
    });

    tests.push({
      name: "Structure documented",
      passed: !isEmpty(c.sections["Structure"]),
      detail: isEmpty(c.sections["Structure"]) ? "Contract states no structure" : "Structure present",
      severity: "medium",
    });

    tests.push({
      name: "Invariants documented",
      passed: !isEmpty(c.sections["Invariants"]),
      detail: isEmpty(c.sections["Invariants"]) ? "Contract states no invariants" : "Invariants present",
      severity: "medium",
    });

    const freedom = extractFreedom(c);
    const dims = new Map(freedom.map((f) => [f.dim, f.ok]));
    const withheld = ["storage", "vendor", "platform"].filter((k) => dims.get(k) === true).length;

    tests.push({
      name: "Implementation detail withheld",
      passed: withheld >= 2,
      detail:
        freedom.length === 0
          ? "No implementation-freedom declaration found for this contract"
          : `${withheld}/3 implementation details withheld (storage, vendor, platform)`,
      severity: "high",
    });

    tests.push({
      name: "Alternative implementation possible",
      passed: dims.get("alternative_implementable") === true,
      detail:
        dims.get("alternative_implementable") === true
          ? "Contract admits a second implementation"
          : "Contract is not implementable independently of the chosen technology",
      severity: "high",
    });

    const refs = collectRefs([c], [], "MOD", ["Consumers", "Producers"]);
    for (const ref of refs.get(c.id) || []) {
      tests.push({
        name: `Declared reference ${ref} resolves`,
        passed: known.has(ref),
        detail: known.has(ref) ? `${ref} exists` : `${ref} is referenced but not defined`,
        severity: "high",
      });
    }

    const failed = tests.filter((t) => !t.passed);
    return {
      id: `VRFY-${source === "interface" ? "IFACE-" : ""}${c.id}`,
      target: `${c.id} — ${c.name}`,
      targetType: "contract" as const,
      tests,
      summary: failed.some((t) => t.severity === "high")
        ? "REJECT"
        : failed.length > 0
          ? "PASS_WITH_CORRECTIONS"
          : "PASS",
      findings: failed.map((t) => `${t.name}: ${t.detail}`),
      rejectedAssumptions: failed.filter((t) => t.severity === "high").map((t) => t.name),
      requiredCorrections: failed.filter((t) => t.severity === "high").map((t) => `Fix ${c.id}: ${t.name}`),
    };
  });
}

function verifyModules(
  blocks: Registry,
  knownFormats: Set<string>,
  knownModules: Set<string>
): { results: VerificationResult[]; adjacency: Map<string, string[]> } {
  if (!blocks || blocks.length === 0) return { results: [], adjacency: new Map() };

  const adjacency = new Map<string, string[]>();
  const results = blocks.map((m) => {
    const tests: VerifyTest[] = [];

    tests.push({
      name: "Responsibility stated",
      passed: !isEmpty(m.fields["Responsibility"] ?? m.sections["Responsibility"]),
      detail: isEmpty(m.fields["Responsibility"]) ? "Module declares no responsibility" : "Responsibility stated",
      severity: "high",
    });

    const owns = bulletItems(m, "Owns");
    tests.push({
      name: "Owns bounded state",
      passed: owns.length > 0,
      detail: owns.length > 0 ? `Owns ${owns.length} concern(s)` : "Module owns no state — boundaries are unbounded",
      severity: "high",
    });

    const notOwns = bulletItems(m, "Does Not Own");
    tests.push({
      name: "Exclusions declared",
      passed: notOwns.length > 0,
      detail: notOwns.length > 0 ? `${notOwns.length} exclusion(s)` : "Module declares nothing it must not own",
      severity: "low",
    });

    const consumes = collectRefs([m], ["Consumes Interfaces"], "FMT").get(m.id) || [];
    const exposes = collectRefs([m], ["Exposes Interfaces"], "FMT").get(m.id) || [];

    for (const ref of [...consumes, ...exposes]) {
      tests.push({
        name: `Interface reference ${ref} resolves`,
        passed: knownFormats.has(ref),
        detail: knownFormats.has(ref)
          ? `${ref} defined in the format/interface registry`
          : `${ref} is required by ${m.id} but never defined`,
        severity: "high",
      });
    }

    const deps = collectRefs([m], ["Module Dependencies"], "MOD", ["Responsibility"]).get(m.id) || [];
    adjacency.set(m.id, deps.filter((d) => d !== m.id));

    for (const dep of deps) {
      tests.push({
        name: `Module dependency ${dep} resolves`,
        passed: knownModules.has(dep),
        detail: knownModules.has(dep)
          ? `${dep} defined`
          : `${dep} is a dependency of ${m.id} but not defined`,
        severity: "high",
      });
    }

    tests.push({
      name: "No self-dependency",
      passed: !deps.includes(m.id),
      detail: deps.includes(m.id) ? `${m.id} depends on itself` : "No self-dependency",
      severity: "high",
    });

    tests.push({
      name: "Test strategy declared",
      passed: !isEmpty(m.sections["Test Strategy"]),
      detail: isEmpty(m.sections["Test Strategy"]) ? "No test strategy" : "Test strategy declared",
      severity: "medium",
    });

    const failed = tests.filter((t) => !t.passed);
    return {
      id: `VRFY-${m.id}`,
      target: `${m.id} — ${m.name}`,
      targetType: "module" as const,
      tests,
      summary: (failed.some((t) => t.severity === "high")
        ? "REJECT"
        : failed.length > 0
          ? "PASS_WITH_CORRECTIONS"
          : "PASS") as VerificationResult["summary"],
      findings: failed.map((t) => `${t.name}: ${t.detail}`),
      rejectedAssumptions: failed.filter((t) => t.severity === "high").map((t) => t.name),
      requiredCorrections: failed.filter((t) => t.severity === "high").map((t) => `Fix ${m.id}: ${t.name}`),
    } satisfies VerificationResult;
  });

  return { results, adjacency };
}

function verifyPrimitive(state: FleetState): VerificationResult | null {
  const prim = state.primitive;
  if (!prim) return null;
  const p = prim.selected;
  const tests: VerifyTest[] = [];

  tests.push({
    name: "Primitive selected",
    passed: !!p,
    detail: p ? `Selected: ${p.name}` : "No primitive selected from the candidates",
    severity: "high",
  });

  if (p) {
    tests.push({
      name: "Operations defined",
      passed: Array.isArray(p.operations) && p.operations.length > 0,
      detail: p.operations?.length ? `${p.operations.length} operation(s)` : "Primitive defines no operations",
      severity: "medium",
    });
    tests.push({
      name: "Invariants defined",
      passed: Array.isArray(p.invariants) && p.invariants.length > 0,
      detail: p.invariants?.length ? `${p.invariants.length} invariant(s)` : "Primitive defines no invariants",
      severity: "medium",
    });
    tests.push({
      name: "Limitations acknowledged",
      passed: Array.isArray(p.limitations) && p.limitations.length > 0,
      detail: p.limitations?.length ? `${p.limitations.length} stated` : "No limitations recorded",
      severity: "low",
    });
  }

  const failed = tests.filter((t) => !t.passed);
  return {
    id: "VRFY-PRIMITIVE",
    target: p ? `Primitive — ${p.name}` : "Primitive",
    targetType: "primitive",
    tests,
    summary: failed.some((t) => t.severity === "high")
      ? "REJECT"
      : failed.length > 0
        ? "PASS_WITH_CORRECTIONS"
        : "PASS",
    findings: failed.map((t) => `${t.name}: ${t.detail}`),
    rejectedAssumptions: failed.filter((t) => t.severity === "high").map((t) => t.name),
    requiredCorrections: [],
  };
}

function verifyDependencies(
  blocks: Registry,
  adapters: { id: string; externalDependency?: string; internalInterface?: string }[],
  knownModules: Set<string>
): VerificationResult[] {
  if (!blocks || blocks.length === 0) return [];

  // Adapters come from the canonical store, not from a markdown registry.
  const adapterFor = new Map<string, string>();
  for (const a of adapters || []) {
    const dep = (a.externalDependency || "").trim();
    if (dep) adapterFor.set(dep, a.id);
  }

  return blocks.map((d) => {
    const tests: VerifyTest[] = [];

    const usedBy = collectRefs([d], ["Used By"], "MOD").get(d.id) || [];
    for (const m of usedBy) {
      tests.push({
        name: `Used-by reference ${m} resolves`,
        passed: knownModules.has(m),
        detail: knownModules.has(m) ? `${m} defined` : `${m} is listed as a consumer of ${d.id} but is not defined`,
        severity: "high",
      });
    }

    const needsAdapter =
      /yes|true|✅/i.test(d.fields["Adapter Required"] || "") ||
      /yes|true|✅/i.test(d.sections["Adapter"] || "");

    if (needsAdapter) {
      tests.push({
        name: "Adapter defined for isolated dependency",
        passed: adapterFor.has(d.id),
        detail: adapterFor.has(d.id)
          ? `Shielded by ${adapterFor.get(d.id)}`
          : "Dependency requires isolation but no adapter defines the boundary",
        severity: "high",
      });
    } else {
      tests.push({
        name: "Dependency isolation decided",
        passed: true,
        detail: "Dependency is not isolated — acceptable only if it is a pure library",
        severity: "low",
      });
    }

    const failed = tests.filter((t) => !t.passed);
    return {
      id: `VRFY-${d.id}`,
      target: `${d.id} — ${d.name}`,
      targetType: "dependency" as const,
      tests,
      summary: (failed.some((t) => t.severity === "high")
        ? "REJECT"
        : failed.length > 0
          ? "PASS_WITH_CORRECTIONS"
          : "PASS") as VerificationResult["summary"],
      findings: failed.map((t) => `${t.name}: ${t.detail}`),
      rejectedAssumptions: [],
      requiredCorrections: failed.filter((t) => t.severity === "high").map((t) => `Fix ${d.id}: ${t.name}`),
    } satisfies VerificationResult;
  });
}

// ─── Store → registry shape ──────────────────────────────────────────────────
//
// 0.2.0 built its input by re-parsing the rendered markdown. The store is the
// source of truth, so these converters adapt the stored objects into the same
// ParsedBlock shape the checks already consume — the verification logic is
// unchanged, only where the data comes from.

const yn = (b: boolean | undefined) => (b === false ? "❌" : "✅");

function contractsToBlocks(contracts: any[], onlyInterfaces: boolean): ParsedBlock[] {
  return contracts
    .filter((c) => (onlyInterfaces ? c.type === "interface" || c.type === "plugin" : true))
    .map((c) => ({
      id: c.id,
      name: c.name,
      fields: {
        Status: c.status,
        Version: c.version,
        Consumers: (c.consumers || []).join(", ") || "—",
        Producers: (c.producers || []).join(", ") || "—",
      },
      // Emitted in the canonical form. The interface registry's inverted
      // wording is still understood by extractFreedom, which is retained for
      // stores imported from 0.1.0.
      bullets: {
        "Implementation Freedom": [
          `Storage hidden: ${yn(c.hidesStorage)}`,
          `Vendor hidden: ${yn(c.hidesVendor)}`,
          `Platform hidden: ${yn(c.hidesPlatform)}`,
          `Algorithm hidden: ${yn(c.hidesAlgorithm)}`,
          `Alternative implementation: ${yn(c.alternativeImplementable)}`,
        ],
      },
      sections: {
        ...(onlyInterfaces ? { Contract: c.semantics || "" } : { Semantics: c.semantics || "" }),
        Structure: c.structure || "",
        Invariants: c.invariants || "",
      },
    }));
}

function modulesToBlocks(modules: any[]): ParsedBlock[] {
  return modules.map((m) => ({
    id: m.id,
    name: m.name,
    fields: {
      Responsibility: m.responsibility || "",
      Status: m.status,
      Owner: m.implementationOwner || "",
      Replaceable: m.replaceable ? "true" : "false",
    },
    bullets: {
      Owns: m.owns || [],
      "Does Not Own": m.doesNotOwn || [],
      "Consumes Interfaces": m.consumesInterfaces || [],
      "Exposes Interfaces": m.exposesInterfaces || [],
      "Module Dependencies": (m.dependencies || []).filter((d: string) => d !== m.id),
      Invariants: m.invariants || [],
    },
    sections: { "Test Strategy": m.testStrategy || "" },
  }));
}

function depsToBlocks(deps: any[]): ParsedBlock[] {
  return deps.map((d) => ({
    id: d.id,
    name: d.name,
    fields: {
      Category: d.category,
      Version: d.version,
      Risk: d.riskLevel,
      "Adapter Required": d.adapterRequired ? "yes" : "no",
      Adapter: d.adapterName || "",
    },
    bullets: { "Used By": d.usedBy || [] },
    sections: { Notes: d.notes || "" },
  }));
}

// ─── Orchestration ───────────────────────────────────────────────────────────

export function runVerification(state: FleetState): { results: VerificationResult[]; summary: string; drift: DriftFinding[] } {
  const allContracts = state.contracts || [];
  const formats = contractsToBlocks(allContracts, false);
  const interfaces = contractsToBlocks(allContracts, true);
  const modules = modulesToBlocks(state.modules || []);
  const deps = depsToBlocks(state.dependencies || []);
  const adapters = (state.adapters as any[]) || [];

  const knownFormats = new Set([...formats, ...interfaces].map((b) => b.id));
  const knownModules = new Set(modules.map((b) => b.id));

  const results: VerificationResult[] = [];

  const primResult = verifyPrimitive(state);
  if (primResult) results.push(primResult);

  results.push(...verifyContracts(formats, knownModules, "format"));
  results.push(...verifyContracts(interfaces, knownModules, "interface"));

  // A contract of type interface|plugin is rendered into both registries from
  // the same source data. Verify it once.
  const seenTargets = new Set<string>();
  const deduped = results.filter((r) => {
    if (r.targetType !== "contract") return true;
    if (seenTargets.has(r.target)) return false;
    seenTargets.add(r.target);
    return true;
  });
  results.length = 0;
  results.push(...deduped);

  const moduleRun = verifyModules(modules, knownFormats, knownModules);
  results.push(...moduleRun.results);

  const cycles = findCycles(moduleRun.adjacency);
  results.push({
    id: "VRFY-GRAPH",
    target: "Module dependency graph",
    targetType: "module",
    tests: [
      {
        name: "Dependency graph is acyclic",
        passed: cycles.length === 0,
        detail:
          cycles.length === 0
            ? `${moduleRun.adjacency.size} module(s), no cycles`
            : `Cycles: ${cycles.map((c) => c.join(" → ")).join("; ")}`,
        severity: "high",
      },
    ],
    summary: cycles.length === 0 ? "PASS" : "REJECT",
    findings: cycles.map((c) => `Cycle: ${c.join(" → ")}`),
    rejectedAssumptions: cycles.length ? ["acyclic module graph"] : [],
    requiredCorrections: cycles.length ? ["Break the module dependency cycle(s)"] : [],
  });

  // Contract-level implementation freedom, evaluated across the whole set.
  // `formats` already contains every contract (interface and plugin types
  // included), so it is the set-wide view; `interfaces` is the same contracts
  // re-rendered under the inverted labels and would double-count.
  if (formats.length > 0) {
    const leaky = formats.filter((c) => {
      const dims = new Map(extractFreedom(c).map((f) => [f.dim, f.ok]));
      const held = ["storage", "vendor", "platform"].filter((k) => dims.get(k) === true).length;
      return held < 2;
    });
    results.push({
      id: "VRFY-FREEDOM",
      target: "Implementation freedom (system-wide)",
      targetType: "contract",
      tests: [
        {
          name: "Contracts withhold implementation detail",
          passed: leaky.length === 0,
          detail:
            leaky.length === 0
              ? `All ${formats.length} contract(s) withhold >=2 of storage/vendor/platform`
              : `Leaky contracts: ${leaky.map((c) => c.id).join(", ")}`,
          severity: "high",
        },
      ],
      summary: leaky.length === 0 ? "PASS" : "REJECT",
      findings: leaky.map((c) => `${c.id} exposes implementation detail`),
      rejectedAssumptions: leaky.length ? ["implementation freedom across contracts"] : [],
      requiredCorrections: leaky.length ? leaky.map((c) => `Hide implementation detail behind ${c.id}`) : [],
    });
  }

  results.push(...verifyDependencies(deps, adapters, knownModules));

  const hasReject = results.some((r) => r.summary === "REJECT");
  const drift = detectDrift(state);

  // Drift is reported as its own target, severity low. It never contributes to
  // REJECT — a stale render is a housekeeping problem, not a design defect.
  if (drift.length > 0) {
    results.push({
      id: "VRFY-DRIFT",
      target: "Store ↔ rendered documents",
      targetType: "contract",
      tests: drift.map((d) => ({
        name: `${d.file} is ${d.kind}`,
        passed: false,
        detail: d.detail,
        severity: "low" as const,
      })),
      summary: "PASS_WITH_CORRECTIONS",
      findings: drift.map((d) => `${d.file} (${d.kind}): ${d.detail}`),
      rejectedAssumptions: [],
      requiredCorrections: [],
    });
  }

  const hasCorrections = results.some((r) => r.summary === "PASS_WITH_CORRECTIONS");
  const summary = hasReject ? "REJECT" : hasCorrections ? "PASS_WITH_CORRECTIONS" : "PASS";

  return { results, summary, drift };
}

function writeVerificationFile(results: VerificationResult[], summary: string, drift: DriftFinding[] = []) {
  ensureArchDir();
  const lines = [
    "# Verification Report",
    "",
    `*Generated by fleet-verify · ${new Date().toISOString()}*`,
    "",
    `**Verdict:** ${summary}`,
    "",
  ];
  const total = results.reduce((n, r) => n + r.tests.length, 0);
  const failed = results.reduce((n, r) => n + r.tests.filter((t) => !t.passed).length, 0);
  lines.push(`${results.length} target(s), ${total} test(s), ${failed} failure(s).`, "");
  if (drift.length > 0) {
    lines.push("## Store ↔ document drift", "");
    lines.push("The store is authoritative. These rendered documents do not match it.", "");
    for (const d of drift) lines.push(`- **${d.file}** (${d.kind}) — ${d.detail}`);
    lines.push("");
  }

  for (const r of results) {
    lines.push(`## ${r.id} — ${r.target}`, "");
    lines.push(`**Verdict:** ${r.summary}`, "");
    lines.push("| Test | Result | Severity | Detail |", "|---|---|---|---|");
    for (const t of r.tests) {
      lines.push(`| ${t.name} | ${t.passed ? "✅" : "❌"} | ${t.severity} | ${t.detail} |`);
    }
    lines.push("");
    if (r.requiredCorrections.length) {
      lines.push("### Required corrections", "");
      for (const c of r.requiredCorrections) lines.push(`- ${c}`);
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  }
  writeFileSync(archPath(VER_FILE), lines.join("\n"), "utf8");
}

function summarise(results: VerificationResult[], summary: string, drift: DriftFinding[] = []): string {
  const total = results.reduce((n, r) => n + r.tests.length, 0);
  const failed = results.reduce((n, r) => n + r.tests.filter((t) => !t.passed).length, 0);
  const high = results.reduce((n, r) => n + r.tests.filter((t) => !t.passed && t.severity === "high").length, 0);

  const lines = [
    `🔍 Architecture Verification — ${summary}`,
    `  ${results.length} target(s) · ${total} test(s) · ${failed} failure(s) · ${high} high-severity`,
    "",
  ];
  for (const r of results) {
    const icon = r.summary === "PASS" ? "✅" : r.summary === "REJECT" ? "❌" : "⚠️";
    lines.push(`  ${icon} ${r.id} — ${r.summary}`);
    for (const t of r.tests.filter((t) => !t.passed).slice(0, 4)) {
      lines.push(`      · [${t.severity}] ${t.name}: ${t.detail}`);
    }
  }
  if (summary === "REJECT") {
    lines.push("");
    lines.push("  Phase 9 is blocked until the high-severity findings above are fixed and re-verified.");
  }
  if (drift.length > 0) {
    lines.push("");
    lines.push("  Store ↔ document drift (housekeeping, never blocks):");
    for (const d of drift) lines.push(`    · ${d.file} (${d.kind}): ${d.detail}`);
  }
  return lines.join("\n");
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const state = loadState();
    if (state.verification?.summary) {
      ctx.ui.notify(`[fleet] last verification: ${state.verification.summary}`, "info");
    }
  });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    const state = loadState();
    const brief = phaseBrief(state);
    if (!brief) return null;
    return { systemPrompt: `${ctx.getSystemPrompt() || event.systemPrompt}\n\n${brief}` };
  });

  pi.registerCommand("fleet:verify", {
    description: "Run structural architecture verification (Phase 7)",
    handler: async (_args, ctx) => {
      const state = loadState();
      const { results, summary, drift } = runVerification(state);
      state.verification = {
        ranAt: new Date().toISOString(),
        phase: state.currentPhase,
        summary,
        results,
      };
      saveState(state);
      writeVerificationFile(results, summary, drift);
      audit(`verification ${summary}`, state);
      ctx.ui.notify(summarise(results, summary, drift), summary === "REJECT" ? "error" : "info");
    },
  });

  pi.registerCommand("fleet:verify-mod", {
    description: "Verify one target (/fleet:verify-mod <FMT-|MOD-|DEP-|PRIM-xxx>)",
    handler: async (args, ctx) => {
      const id = (args || "").trim().toUpperCase();
      if (!id) {
        ctx.ui.notify("Usage: /fleet:verify-mod <FMT-xxx|MOD-xxx|DEP-xxx|PRIM>", "warning");
        return;
      }
      const state = loadState();
      const { results } = runVerification(state);
      const hit = results.find((r) => r.id.includes(id) || r.target.toUpperCase().includes(id));
      if (!hit) {
        ctx.ui.notify(`No verification target matching "${id}".`, "warning");
        return;
      }
      ctx.ui.notify(summarise([hit], hit.summary), hit.summary === "REJECT" ? "error" : "info");
    },
  });

  pi.registerTool({
    name: "fleet_verify_architecture",
    label: "Verify Architecture",
    description:
      "Run structural verification across every registry: cross-reference integrity (FMT-/MOD-/DEP-/EXT- ids must resolve), module dependency cycle detection, implementation-freedom enforcement on contracts, and boundary/test-strategy checks on modules. Returns a PASS / PASS_WITH_CORRECTIONS / REJECT verdict. REJECT blocks the move to contract freeze.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      if (aborted(signal)) return ABORTED_RESULT;
      const state = loadState();
      const { results, summary, drift } = runVerification(state);
      state.verification = {
        ranAt: new Date().toISOString(),
        phase: state.currentPhase,
        summary,
        results,
      };
      saveState(state);
      writeVerificationFile(results, summary, drift);
      audit(`verification ${summary}`, state);
      const text = summarise(results, summary, drift);
      ctx.ui.notify(`[fleet] verification ${summary}`, summary === "REJECT" ? "error" : "info");
      return {
        content: [{ type: "text", text }],
        details: { summary, results, drift },
      };
    },
  });
}