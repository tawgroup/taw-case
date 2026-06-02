#!/usr/bin/env node
// taw-case — a Case-style, YAML-driven state-machine harness for coding agents.
//
// Mental model: this is a CI-style RUNNER, not a chat app.
//   You give it ONE task + point it at a repo. It loops through the workflow
//   defined in <repo>/.taw-case/harness.yaml, spawning an agent (Pi/Claude/…)
//   for the "agent" steps and running real commands for the "command" steps.
//   Agents ACT; the harness VERIFIES with exit codes + hashed evidence.
//   The agent never gets to certify its own work.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");

const argv = process.argv.slice(2);
const args = parseArgs(argv);

// ---- subcommands -----------------------------------------------------------
if (args.help || (!args._cmd && !args.task)) {
  printHelp();
  process.exit(args.help ? 0 : 1);
}

if (args._cmd === "init") {
  await cmdInit();
  process.exit(0);
}

// ---- main run --------------------------------------------------------------
const cwd = resolve(args.cwd ?? process.cwd());
const configPath = resolve(args.config ?? join(cwd, ".taw-case", "harness.yaml"));

if (!existsSync(configPath)) {
  console.error(`[taw-case] no config at ${configPath}`);
  console.error(`[taw-case] run  taw-case init --cwd ${cwd}  to scaffold one.`);
  process.exit(1);
}

const config = loadConfig(configPath);

// pick which named workflow to run (config may define one or many)
const workflowNames = Object.keys(config.workflows);
const workflowName =
  args.workflow ??
  config.default_workflow ??
  (workflowNames.length === 1 ? workflowNames[0] : "default");
const steps = config.workflows[workflowName];
if (!steps) {
  console.error(`[taw-case] no workflow "${workflowName}". Available: ${workflowNames.join(", ")}`);
  console.error(`[taw-case] choose one with --workflow <name>`);
  process.exit(1);
}

const stepIndex = Object.fromEntries(steps.map((s, i) => [s.id, i]));
const maxCycles = Number(args["max-cycles"] ?? config.settings?.max_cycles ?? 3);
const agentCmd = args["agent-cmd"] ?? config.agent?.cmd ?? "pi";

const runId = stampRunId(args.runid);
const caseDir = join(cwd, ".taw-case");
const runDir = join(caseDir, "runs", runId);
const memoryDir = join(caseDir, "memory");

// conventions.md (if present) becomes the rubric injected into every SOFT gate
const conventionsFile = join(caseDir, "conventions.md");
const conventions = existsSync(conventionsFile) ? readFileSync(conventionsFile, "utf8") : "";

const firstAgentStep = steps.find((s) => s.type === "agent")?.id ?? steps[0].id;

if (args["dry-run"]) {
  printDryRun();
  process.exit(0);
}

mkdirSync(runDir, { recursive: true });
mkdirSync(memoryDir, { recursive: true });

const state = {
  task: args.task,
  cwd,
  runId,
  runDir,
  cycle: 1,
  lastFailure: "",
  passed: new Set(),
  history: [],
};

await run().catch((err) => {
  console.error(`\n[taw-case] fatal: ${err?.stack ?? err}`);
  writeManifest(false);
  process.exit(1);
});

// ===========================================================================

async function run() {
  banner();
  let i = 0;
  // hard safety cap so a misconfigured on_fail loop can never spin forever
  const maxTransitions = steps.length * (maxCycles + 2) + 8;
  let transitions = 0;

  while (i < steps.length) {
    if (++transitions > maxTransitions) {
      throw new Error(`exceeded ${maxTransitions} transitions — likely an on_fail loop in config`);
    }
    const step = steps[i];

    // gate on `requires:` — every named prereq must have passed already
    const missing = (step.requires ?? []).filter((r) => !state.passed.has(r));
    if (missing.length) {
      throw new Error(`step "${step.id}" requires [${missing.join(", ")}] which have not passed`);
    }

    log(`\n▶ ${step.id}  (${describeStep(step)})  cycle ${state.cycle}/${maxCycles}`);

    let result;
    if (step.type === "command") result = await runCommandStep(step);
    else if (step.type === "agent") result = await runAgentStep(step);
    else throw new Error(`unknown step type "${step.type}" in step "${step.id}"`);

    record(step, result);

    if (result.ok) {
      state.passed.add(step.id);
      i += 1;
      continue;
    }

    // failure
    if (step.blocking === false) {
      log(`  ⚠ ${step.id} failed but is non-blocking — continuing`);
      i += 1;
      continue;
    }

    // blocking failure → jump back to on_fail target and burn a cycle
    state.lastFailure = result.failure ?? `step "${step.id}" failed`;
    const target = step.on_fail ?? firstAgentStep;
    state.cycle += 1;
    if (state.cycle > maxCycles) {
      log(`\n✗ FAILED after ${maxCycles} cycles at step "${step.id}".`);
      log(`  last failure: ${state.lastFailure}`);
      writeManifest(false);
      log(`  evidence: ${runDir}`);
      process.exit(2);
    }
    log(`  ↩ back to "${target}" (${state.lastFailure})`);
    // anything past the target is no longer "passed"
    for (const id of [...state.passed]) {
      if (stepIndex[id] >= stepIndex[target]) state.passed.delete(id);
    }
    i = stepIndex[target];
  }

  log(`\n✓ DONE`);
  writeManifest(true);
  log(`  evidence: ${runDir}`);
}

// ---- step runners ----------------------------------------------------------

async function runCommandStep(step) {
  if (!step.run) throw new Error(`command step "${step.id}" has no \`run\``);
  const wantCode = step.pass?.exit_code ?? 0;
  const res = await runShell(step.run, cwd);

  const body =
    `$ ${step.run}\n\n[exit_code] ${res.code} (expected ${wantCode})\n\n` +
    `${res.stdout}${res.stderr ? `\n[stderr]\n${res.stderr}` : ""}`;
  const logFile = join(runDir, `${step.id}.log`);
  writeFileSync(logFile, body);

  // hashed evidence: prove this exact output, unaltered
  const sha = sha256(body);
  writeFileSync(join(runDir, `${step.id}.sha256`), `${sha}  ${logFile}\n`);

  const ok = res.code === wantCode;
  log(`  exit=${res.code} ${ok ? "✓" : "✗"}  sha256=${sha.slice(0, 12)}…`);
  return {
    ok,
    sha256: sha,
    exitCode: res.code,
    logFile,
    failure: ok ? undefined : `\`${step.run}\` exited ${res.code} (expected ${wantCode}); see ${logFile}`,
  };
}

async function runAgentStep(step) {
  const role = step.role ?? step.id;
  const prompt = buildPrompt(step, role);
  const out = await runAgent(role, step, prompt);
  const logFile = join(runDir, `${step.id}.log`);
  writeFileSync(logFile, out);

  if (step.gate) {
    // a soft gate: agent must return JSON with an explicit verdict + evidence
    const verdict = extractJson(out) ?? {
      approved: false,
      issues: ["agent did not return parseable JSON verdict"],
    };
    writeFileSync(join(runDir, `${step.id}.verdict.json`), JSON.stringify(verdict, null, 2));
    const ok = verdict.approved === true || verdict.pass === true;
    log(`  verdict approved=${ok} ${ok ? "✓" : "✗"}`);
    return {
      ok,
      logFile,
      verdict,
      failure: ok ? undefined : `${role} rejected: ${(verdict.issues ?? []).join("; ") || "no reason given"}`,
    };
  }

  // an "act" agent (implementer/closer/retro): it ran, harness moves on
  log(`  ${role} done ✓`);
  return { ok: true, logFile };
}

// ---- prompt construction ---------------------------------------------------

function buildPrompt(step, role) {
  const base = step.prompt
    ? interpolate(step.prompt)
    : (DEFAULT_PROMPTS[role] ?? DEFAULT_PROMPTS._act)();
  // SOFT gates get the repo's conventions.md appended as a review rubric
  const rubric =
    step.gate && conventions
      ? `\n\n--- REVIEW RUBRIC (.taw-case/conventions.md) ---\n${conventions}\n--- end rubric ---\nJudge the diff against EVERY rule above; cite file:line for each issue.`
      : "";
  return base + rubric + commonContext(role);
}

function commonContext(role) {
  return [
    "",
    "--- harness context (read-only) ---",
    `task: ${state.task}`,
    `role: ${role}`,
    `cycle: ${state.cycle}/${maxCycles}`,
    `run_dir: ${state.runDir}`,
    `last_failure: ${state.lastFailure || "none"}`,
    "You are ONE subprocess in a state-machine harness. The harness — not you —",
    "decides whether this state passes. Do not claim a gate passed; the harness",
    "runs the real checks after you stop.",
  ].join("\n");
}

const DEFAULT_PROMPTS = {
  implementer: () =>
    "You are the IMPLEMENTER. Make focused code changes to satisfy the task. " +
    "If there is a last_failure, fix exactly that. Keep the diff minimal. " +
    "Do NOT run or fake the verification gates; just write correct code.",
  reviewer: () =>
    "You are the REVIEWER. Inspect the working-tree changes (use `git diff`) for the task. " +
    "Do NOT edit files. Return ONLY compact JSON:\n" +
    '{"approved":true|false,"issues":["..."],"evidence":["path:line — why"],"summary":"..."}\n' +
    "Approve only if the change is focused, correct, and matches the task. " +
    "Every claim in `issues`/`evidence` must point at a real file:line.",
  closer: () =>
    "You are the CLOSER. The gates have passed. Write a PR-ready summary to " +
    "`.taw-case/runs/<run>/PR_BODY.md` (use the run_dir above): what changed, why, " +
    "and the evidence (test/lint logs + their sha256 files in run_dir). Do not modify source code.",
  retro: () =>
    "You are the RETRO agent. Inspect the logs in run_dir and update " +
    "`.taw-case/memory/general.md` (and a per-stack file if relevant) with SHORT, durable " +
    "lessons for future runs (real gotchas only, not generic advice). Keep it tight.",
  _act: () => "You are an ACT agent. Perform your step for the task, then stop.",
};

// ---- agent / shell processes ----------------------------------------------

async function runAgent(role, step, prompt) {
  const rolePrompt = `You are taw-case/${role}, one subprocess in a deterministic harness.`;
  // sensible defaults for Pi; override via config.agent.args for other CLIs
  const base = config.agent?.args ?? ["--no-session", "-p", "--append-system-prompt", rolePrompt];
  const extra = [];
  const tools = step.tools ?? config.agent?.tools;
  if (tools && agentCmd.includes("pi")) extra.push("--tools", Array.isArray(tools) ? tools.join(",") : tools);
  if (config.agent?.provider) extra.push("--provider", config.agent.provider);
  if (config.agent?.model) extra.push("--model", config.agent.model);
  const agentArgs = [...base, ...extra, prompt];

  const res = await runProcess(agentCmd, agentArgs, cwd);
  if (res.code !== 0) {
    writeFileSync(join(runDir, `${step.id}.err.log`), res.stdout + "\n[stderr]\n" + res.stderr);
    throw new Error(`agent "${agentCmd}" (${role}) exited ${res.code}; see ${role}.err.log`);
  }
  return res.stdout;
}

function runShell(command, cwd) {
  const isWin = process.platform === "win32";
  return runProcess(
    isWin ? "cmd" : "bash",
    isWin ? ["/d", "/s", "/c", command] : ["-lc", command],
    cwd
  );
}

function runProcess(command, processArgs, cwd) {
  return new Promise((res) => {
    const child = spawn(command, processArgs, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { const s = String(d); stdout += s; process.stdout.write(s); });
    child.stderr.on("data", (d) => { const s = String(d); stderr += s; process.stderr.write(s); });
    child.on("close", (code) => res({ code: code ?? 1, stdout, stderr }));
    child.on("error", (e) => res({ code: 127, stdout, stderr: `${stderr}\n${e.message}` }));
  });
}

// ---- bookkeeping -----------------------------------------------------------

function record(step, result) {
  state.history.push({
    step: step.id,
    type: step.type,
    cycle: state.cycle,
    ok: result.ok,
    exitCode: result.exitCode,
    sha256: result.sha256,
    failure: result.failure,
  });
}

function writeManifest(success) {
  const manifest = {
    runId,
    task: state.task,
    cwd,
    success,
    cycles: state.cycle,
    config: configPath,
    agentCmd,
    history: state.history,
  };
  writeFileSync(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const md = [
    `# taw-case run ${runId}`,
    "",
    `- task: ${state.task}`,
    `- repo: ${cwd}`,
    `- success: ${success}`,
    `- cycles: ${state.cycle}/${maxCycles}`,
    `- agent: ${agentCmd}`,
    "",
    "## Transitions",
    "",
    ...state.history.map(
      (h) =>
        `- \`${h.step}\` (${h.type}, cycle ${h.cycle}) → ${h.ok ? "PASS" : "FAIL"}` +
        (h.sha256 ? ` \`sha256:${h.sha256.slice(0, 12)}…\`` : "") +
        (h.failure ? ` — ${h.failure}` : "")
    ),
    "",
  ].join("\n");
  writeFileSync(join(runDir, "summary.md"), md);
}

// ---- config / init ---------------------------------------------------------

function loadConfig(path) {
  let cfg;
  try {
    cfg = parseYaml(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`[taw-case] cannot parse ${path}: ${e.message}`);
    process.exit(1);
  }
  if (!cfg) die("config is empty");

  // normalize to a { name: steps[] } map.
  //   workflows: { feature: [...], hotfix: [...] }   (multi, named)
  //   workflow:  [...]                                (single, becomes "default")
  if (cfg.workflows && typeof cfg.workflows === "object") {
    if (Array.isArray(cfg.workflow)) cfg.workflows.default = cfg.workflow;
  } else if (Array.isArray(cfg.workflow)) {
    cfg.workflows = { default: cfg.workflow };
  } else {
    die("config must have a `workflow:` list or a `workflows:` map");
  }

  for (const [name, list] of Object.entries(cfg.workflows)) {
    if (!Array.isArray(list) || list.length === 0) die(`workflow "${name}" must be a non-empty list`);
    validateWorkflow(name, list);
  }
  return cfg;
}

function validateWorkflow(name, list) {
  const seen = new Set();
  for (const s of list) {
    if (!s.id) die(`workflow "${name}": every step needs an \`id\``);
    if (seen.has(s.id)) die(`workflow "${name}": duplicate step id "${s.id}"`);
    seen.add(s.id);
    if (!["command", "agent"].includes(s.type)) {
      die(`workflow "${name}": step "${s.id}" has invalid type "${s.type}" (use command|agent)`);
    }
  }
  for (const s of list) {
    for (const ref of [s.on_fail, ...(s.requires ?? [])].filter(Boolean)) {
      if (!seen.has(ref)) die(`workflow "${name}": step "${s.id}" references unknown step "${ref}"`);
    }
  }
}

function die(msg) {
  console.error(`[taw-case] ${msg}`);
  process.exit(1);
}

async function cmdInit() {
  const target = resolve(args.cwd ?? process.cwd());
  const dest = join(target, ".taw-case");
  const destCfg = join(dest, "harness.yaml");
  if (existsSync(destCfg) && !args.force) {
    console.error(`[taw-case] ${destCfg} already exists (use --force to overwrite)`);
    process.exit(1);
  }
  mkdirSync(dest, { recursive: true });
  const tpl = join(PKG_ROOT, "templates", "harness.yaml");
  cpSync(tpl, destCfg);
  console.log(`[taw-case] wrote ${destCfg}`);
  console.log(`[taw-case] edit the gates to match THIS repo, then:`);
  console.log(`  taw-case "your task" --cwd ${target} --dry-run`);
}

// ---- small helpers ---------------------------------------------------------

function sha256(s) { return createHash("sha256").update(s).digest("hex"); }

function interpolate(s) {
  return String(s)
    .replaceAll("{{task}}", state.task ?? "")
    .replaceAll("{{run_dir}}", state.runDir ?? "")
    .replaceAll("{{last_failure}}", state.lastFailure ?? "");
}

function describeStep(step) {
  if (step.type === "command") return `cmd: ${step.run}`;
  return step.gate ? `agent gate: ${step.role ?? step.id}` : `agent: ${step.role ?? step.id}`;
}

function extractJson(text) {
  const t = text.trim();
  try { return JSON.parse(t); } catch {}
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function stampRunId(given) {
  if (given) return given;
  // Date is available here (CLI, not a workflow sandbox)
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

function banner() {
  log(`[taw-case] run ${runId}`);
  log(`[taw-case] repo ${cwd}`);
  log(`[taw-case] task ${state.task}`);
  log(`[taw-case] workflow "${workflowName}"${conventions ? " · conventions.md loaded" : ""}`);
  log(`[taw-case] agent ${agentCmd} · cycles ${maxCycles} · steps ${steps.map((s) => s.id).join(" → ")}`);
}

function printDryRun() {
  console.log(`taw-case dry run`);
  console.log(`  repo:     ${cwd}`);
  console.log(`  config:   ${configPath}`);
  console.log(`  task:     ${args.task}`);
  console.log(`  workflow: ${workflowName}  (available: ${workflowNames.join(", ")})`);
  console.log(`  rubric:   ${conventions ? "conventions.md → injected into SOFT gates" : "none"}`);
  console.log(`  agent:    ${agentCmd}  (cycles: ${maxCycles})`);
  console.log(`  flow:`);
  for (const s of steps) {
    const tag = s.type === "command" ? "HARD" : s.gate ? "SOFT" : "ACT ";
    const meta = [];
    if (s.requires) meta.push(`requires=[${s.requires.join(",")}]`);
    if (s.on_fail) meta.push(`on_fail=${s.on_fail}`);
    if (s.blocking === false) meta.push("non-blocking");
    console.log(`    [${tag}] ${s.id.padEnd(12)} ${describeStep(s)}${meta.length ? "   (" + meta.join(", ") + ")" : ""}`);
  }
  console.log(`\n  HARD = harness runs a command, exit code decides (agent can't fake it)`);
  console.log(`  SOFT = agent returns a JSON verdict + evidence`);
  console.log(`  ACT  = agent does work, harness moves on`);
}

function log(s) { console.log(s); }

function parseArgs(av) {
  const out = {};
  const rest = [];
  const SUBCMDS = new Set(["init"]);
  let i = 0;
  if (av[0] && SUBCMDS.has(av[0])) { out._cmd = av[0]; i = 1; }
  for (; i < av.length; i++) {
    const a = av[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--dry-run") out["dry-run"] = true;
    else if (a === "--force") out.force = true;
    else if (a.startsWith("--")) out[a.slice(2)] = av[++i];
    else rest.push(a);
  }
  out.task = rest.join(" ").trim();
  return out;
}

function printHelp() {
  console.log(`taw-case — Case-style state-machine harness for coding agents

USAGE
  taw-case init [--cwd <repo>] [--force]      scaffold .taw-case/harness.yaml
  taw-case "<task>" [options]                 run the workflow on a task

OPTIONS
  --cwd <dir>          target repo (default: current dir)
  --config <path>      config file (default: <cwd>/.taw-case/harness.yaml)
  --workflow <name>    which named workflow to run (default: the only one / "default")
  --dry-run            print the resolved flow and exit (no agents, no token cost)
  --max-cycles <n>     override config max_cycles
  --agent-cmd <bin>    agent CLI to spawn (default: config agent.cmd or "pi")
  --help               this help

MODEL
  Not a chat app — a CI-style runner. Give it ONE task, it loops the workflow:
  agents ACT, the harness VERIFIES with exit codes + hashed evidence, and an
  agent never certifies its own work. Each step in harness.yaml is one of:
    command  → harness runs it; pass = exit code matches (HARD gate)
    agent    → spawn the agent CLI; with gate:true it must return a JSON verdict
  Failing a blocking step jumps back to on_fail (default: first agent step) and
  burns a cycle. Evidence lands in .taw-case/runs/<id>/.
`);
}
