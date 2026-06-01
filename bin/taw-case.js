#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));

if (args.help || !args.task) {
  printHelp();
  process.exit(args.help ? 0 : 1);
}

const cwd = resolve(args.cwd ?? process.cwd());
const maxCycles = Number(args["max-cycles"] ?? 3);
const piBin = args.pi ?? "pi";
const testCmd = args["test-cmd"];
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const caseDir = join(cwd, ".taw-case");
const runDir = join(caseDir, "runs", runId);
const memoryDir = join(caseDir, "memory");

if (args["dry-run"]) {
  console.log(`taw-case dry run\n cwd: ${cwd}\n task: ${args.task}\n flow: implement -> verify -> review -> close -> retro`);
  process.exit(0);
}

mkdirSync(runDir, { recursive: true });
mkdirSync(memoryDir, { recursive: true });

const state = {
  task: args.task,
  cwd,
  runId,
  runDir,
  cycles: 0,
  lastFailure: "",
  testPassed: false,
  review: null,
};

await main().catch((error) => {
  console.error(`\n[taw-case] fatal: ${error?.stack ?? error}`);
  process.exit(1);
});

async function main() {
  console.log(`[taw-case] run ${runId}`);
  console.log(`[taw-case] cwd ${cwd}`);

  while (state.cycles < maxCycles) {
    state.cycles += 1;
    console.log(`\n[taw-case] cycle ${state.cycles}/${maxCycles}: implement`);
    await implement();

    console.log(`\n[taw-case] cycle ${state.cycles}/${maxCycles}: verify`);
    const verify = await verifyWithTestCommand();
    state.testPassed = verify.passed;
    if (!verify.passed) {
      state.lastFailure = `Verification failed. Exit code: ${verify.exitCode}. See ${verify.outputFile}`;
      console.log(`[taw-case] verify failed, looping back to implementer`);
      continue;
    }

    console.log(`\n[taw-case] cycle ${state.cycles}/${maxCycles}: review`);
    const review = await reviewCode();
    state.review = review;
    if (!review.approved) {
      state.lastFailure = `Review failed: ${(review.issues ?? []).join("; ")}`;
      writeFileSync(join(runDir, `review-fail-${state.cycles}.json`), JSON.stringify(review, null, 2));
      console.log(`[taw-case] review failed, looping back to implementer`);
      continue;
    }

    console.log(`\n[taw-case] close`);
    await closeRun();

    console.log(`\n[taw-case] retro`);
    await retro();

    console.log(`\n[taw-case] done. Evidence: ${join(runDir, "summary.md")}`);
    return;
  }

  await writeSummary(false);
  console.error(`\n[taw-case] failed after ${maxCycles} cycles. Evidence: ${join(runDir, "summary.md")}`);
  process.exit(2);
}

async function implement() {
  const prompt = `Task:\n${state.task}\n\nLast failure to fix:\n${state.lastFailure || "None yet."}\n\nYou are the IMPLEMENTER. Modify the repo to satisfy the task. Keep changes focused. Do not claim tests passed; the harness will run verification after you stop.`;
  await runPi("implementer", prompt, ["read", "bash", "edit", "write", "grep", "find", "ls"]);
}

async function verifyWithTestCommand() {
  if (!testCmd) {
    const note = "No --test-cmd supplied, so taw-case cannot enforce verification.";
    writeFileSync(join(runDir, `test-output-${state.cycles}.txt`), note);
    return { passed: true, exitCode: 0, outputFile: join(runDir, `test-output-${state.cycles}.txt`) };
  }

  const outputFile = join(runDir, `test-output-${state.cycles}.txt`);
  const result = await runShell(testCmd, cwd);
  const output = `$ ${testCmd}\n\n[exit_code] ${result.code}\n\n${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`;
  writeFileSync(outputFile, output);

  const digest = createHash("sha256").update(output).digest("hex");
  const hashFile = join(runDir, `test-output-${state.cycles}.sha256`);
  writeFileSync(hashFile, `${digest}  ${outputFile}\n`);

  const verified = createHash("sha256").update(readFileSync(outputFile)).digest("hex") === digest;
  writeFileSync(join(runDir, `verified-${state.cycles}.json`), JSON.stringify({
    passed: result.code === 0 && verified,
    exitCode: result.code,
    outputFile,
    hashFile,
    sha256: digest,
    hashVerified: verified,
  }, null, 2));

  console.log(`[taw-case] test exit=${result.code} sha256=${digest.slice(0, 12)}...`);
  return { passed: result.code === 0 && verified, exitCode: result.code, outputFile, hashFile };
}

async function reviewCode() {
  const prompt = `You are the REVIEWER. Review the current repository changes for this task:\n${state.task}\n\nUse git diff and relevant files. Return ONLY compact JSON with this shape:\n{"approved":true|false,"issues":["..."],"summary":"..."}\n\nApprove only if the implementation is focused, safe, and consistent with the task. Do not edit files.`;
  const output = await runPi("reviewer", prompt, ["read", "bash", "grep", "find", "ls"]);
  const review = extractJson(output) ?? { approved: false, issues: ["Reviewer did not return parseable JSON."], summary: output.slice(-1000) };
  writeFileSync(join(runDir, `review-${state.cycles}.json`), JSON.stringify(review, null, 2));
  console.log(`[taw-case] review approved=${Boolean(review.approved)}`);
  return review;
}

async function closeRun() {
  await writeSummary(true);
}

async function retro() {
  const memoryFile = join(memoryDir, "general.md");
  if (!existsSync(memoryFile)) writeFileSync(memoryFile, "# taw-case memory\n\n");

  const prompt = `You are the RETRO agent. Inspect these artifacts and update ${memoryFile} with short lessons for future runs.\n\nRun dir: ${runDir}\nTask: ${state.task}\nCycles: ${state.cycles}\n\nOnly write durable gotchas, not generic advice.`;
  await runPi("retro", prompt, ["read", "bash", "edit", "write", "grep", "find", "ls"]);
}

async function writeSummary(success) {
  const files = [
    `# taw-case run ${runId}`,
    "",
    `- Task: ${state.task}`,
    `- Cwd: ${cwd}`,
    `- Success: ${success}`,
    `- Cycles: ${state.cycles}`,
    `- Last failure: ${state.lastFailure || "none"}`,
    `- Review approved: ${state.review ? Boolean(state.review.approved) : "n/a"}`,
    "",
    "## Evidence",
    "",
    testCmd ? `- Test command: \`${testCmd}\`` : "- Test command: not supplied",
    `- Run directory: \`${runDir}\``,
    "- Test outputs and SHA-256 files are stored in the run directory.",
    "",
  ];
  writeFileSync(join(runDir, "summary.md"), files.join("\n"));
}

async function runPi(role, prompt, tools) {
  const rolePrompt = `You are taw-case/${role}. You are one subprocess in a state-machine harness. Follow your role exactly. The orchestrator, not you, decides whether the state passes.`;
  const piArgs = ["--no-session", "-p", "--append-system-prompt", rolePrompt, "--tools", tools.join(",")];
  if (args.provider) piArgs.push("--provider", args.provider);
  if (args.model) piArgs.push("--model", args.model);
  if (args.thinking) piArgs.push("--thinking", args.thinking);
  piArgs.push(prompt);

  const result = await runProcess(piBin, piArgs, cwd);
  const logFile = join(runDir, `${role}-${state.cycles || 0}.log`);
  writeFileSync(logFile, result.stdout + (result.stderr ? `\n[stderr]\n${result.stderr}` : ""));
  if (result.code !== 0) throw new Error(`pi ${role} failed with exit code ${result.code}. See ${logFile}`);
  return result.stdout;
}

function runShell(command, cwd) {
  return runProcess(process.platform === "win32" ? "cmd" : "bash", process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command], cwd);
}

function runProcess(command, args, cwd) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { const s = String(d); stdout += s; process.stdout.write(s); });
    child.stderr.on("data", (d) => { const s = String(d); stderr += s; process.stderr.write(s); });
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
    child.on("error", (error) => resolvePromise({ code: 127, stdout, stderr: `${stderr}\n${error.message}` }));
  });
}

function extractJson(text) {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function parseArgs(argv) {
  const out = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      if (key === "dry-run") out[key] = true;
      else out[key] = argv[++i];
    } else rest.push(a);
  }
  out.task = rest.join(" ").trim();
  return out;
}

function printHelp() {
  console.log(`taw-case\n\nUsage:\n  taw-case "task" [options]\n\nOptions:\n  --cwd <dir>            target repo, default current directory\n  --test-cmd <cmd>       command the harness runs for verification\n  --max-cycles <n>       default 3\n  --provider <name>      forwarded to pi\n  --model <name>         forwarded to pi\n  --thinking <level>     forwarded to pi\n  --pi <bin>             Pi binary, default pi\n  --dry-run              print planned flow only\n  --help                 show help\n`);
}
