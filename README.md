# taw-case

`taw-case` is a small **Case-style harness** for Pi: a state-machine loop that spawns Pi as role-based sub-agents, then gates progress with evidence instead of trust.

It is intentionally tiny so you can hack it.

## Flow

```text
implementer -> verifier -> reviewer -> closer -> retro
      ^            |          |
      |            fail       fail
      +------------+----------+
```

- **Implementer**: Pi can edit code.
- **Verifier**: the harness runs your test command itself and stores output + SHA-256.
- **Reviewer**: Pi reviews the diff and must output JSON.
- **Closer**: writes the final evidence summary.
- **Retro**: Pi updates `.taw-case/memory/general.md` with lessons learned.

## Install / run locally

```bash
git clone https://github.com/tawgroup/taw-case.git
cd taw-case
npm link
```

Then run in any target repo:

```bash
taw-case "Fix the login redirect bug" --cwd /path/to/project --test-cmd "npm test" --max-cycles 3
```

If your Pi default model/provider is already configured, that is enough. You can also pass Pi options:

```bash
taw-case "Add dark mode" \
  --cwd . \
  --test-cmd "npm test" \
  --provider anthropic \
  --model claude-sonnet-4-5
```

## Why SHA-256?

The verifier writes:

```text
.taw-case/runs/<run-id>/test-output.txt
.taw-case/runs/<run-id>/test-output.sha256
```

The hash is a fingerprint of the test output. If the output changes, the hash check fails. This is the basic pattern: **replace “AI said it passed” with artifacts the orchestrator can verify**.

Best practice: let the harness run tests, not the agent. That is what this repo does.

## Options

```text
--cwd <dir>            target repo, default current directory
--test-cmd <cmd>       command the harness runs for verification
--max-cycles <n>       implement/verify/review attempts, default 3
--provider <name>      forwarded to pi
--model <name>         forwarded to pi
--thinking <level>     forwarded to pi
--pi <bin>             Pi binary, default pi
--dry-run              print planned flow only
```

## Notes

This is a prototype, not a full production Case clone. The key idea is the architecture:

1. Pi is the agent runtime.
2. `taw-case` is the orchestrator.
3. Each state is a separate Pi subprocess with a different role prompt.
4. Gates are enforced by code, not by vibes.
