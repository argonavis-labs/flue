# Build Agents for GitHub Actions

Build and run Flue agents in GitHub Actions. This guide walks you through creating your first agent, running it locally with the CLI, and wiring it into a CI workflow.

By the end, you will have a Flue agent running inside GitHub Actions, and you will know how to use agent definitions, bundled skills, external CLIs, subagents, and typed results to build CI workflows.

## Hello World

A minimal agent that runs in CI whenever an issue is opened.

### 1. Set up your project

```bash
mkdir my-flue-project && cd my-flue-project
npm init -y
npm install @flue/runtime valibot
npm install -D @flue/cli
```

### 2. Create your first agent

`.flue/actions/hello.ts`:

```typescript
import type { ActionContext } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import * as v from 'valibot';

export const triggers = {};

export default async function ({ init, payload }: ActionContext) {
  const harness = await init({ sandbox: local(), model: 'anthropic/claude-sonnet-4-6' });
  const session = await harness.session();

  const { data } = await session.prompt(
    `Say hello to ${payload.name ?? 'the user'} and share an interesting fact.`,
    {
      result: v.object({
        greeting: v.string(),
        fact: v.string(),
      }),
    },
  );

  return data;
}
```

A few things to note:

- **`triggers = {}`** — This agent has no HTTP trigger. It's designed to be run from the CLI, which is perfect for CI.
- **`model`** — Every session needs a model. If you do not pass one to `init()` or a specific `prompt()` / `skill()` call, no model is chosen.
- **`local()`** — The `local()` sandbox runs the agent directly against the host filesystem and shell. In CI, that's the checked-out repo plus whatever binaries are on `$PATH` (`gh`, `git`, `npm`, etc.). Agent definitions and bundled skills still come from your Flue source code; sandbox context loading is an optional separate feature. By default only shell-essential env vars (`PATH`, `HOME`, locale, etc.) are inherited from `process.env` — pass `local({ env: { GH_TOKEN: process.env.GH_TOKEN } })` to expose more. Use `local()` only when the runner itself provides the isolation boundary.
- **Schemas** — The [Valibot](https://valibot.dev) schema defines the expected output shape. Flue parses the agent's response and returns it on `response.data`, fully typed.

### 3. Test it locally

```bash
npx flue run hello --target node --id test-1 \
  --payload '{"name": "World"}'
```

`flue run` builds the project, starts a temporary server, invokes the agent, streams progress to stderr, and prints the final result as JSON to stdout. This is the fastest way to iterate on an agent — no deployment needed.

### 4. Wire it into GitHub Actions

`.github/workflows/hello.yml`:

```yaml
name: Hello Flue

on:
  issues:
    types: [opened]

jobs:
  hello:
    runs-on: ubuntu-latest
    permissions:
      issues: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - name: Run agent
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          npx flue run hello --target node --id "hello-${{ github.event.issue.number }}" \
            --payload '{"name": "${{ github.event.issue.user.login }}"}'
```

Add `ANTHROPIC_API_KEY` as a repository secret (**Settings > Secrets and variables > Actions**). Open an issue and you'll see the agent's greeting in the job logs.

## Building a real agent

Now let's build something useful — an issue triage agent that analyzes an issue and reports back. This is where Flue's agent features start to shine.

### The agent handler

The agent handler is where orchestration lives. The `ActionContext` gives you everything you need: `init()` to create a session, `payload` for input data, and `env` for environment bindings.

Once you have a session, you have three core methods:

- **`session.shell(cmd)`** — Run a shell command in the sandbox. Returns `{ stdout, stderr, exitCode }`.
- **`session.prompt(text, opts)`** — Send a prompt to the agent and get back a result.
- **`session.skill(skillValue, opts)`** — Run a bundled Agent Skills `SKILL.md` value. String names are also supported for opt-in sandbox-discovered skills.

Both `prompt()` and `skill()` accept a `result` option — a [Valibot](https://valibot.dev) schema that defines the expected output shape. Flue parses the agent's response and returns it on `response.data`, fully typed:

```typescript
import reproduceIssue from '../skills/reproduce-issue/SKILL.md' with { type: 'skill' };
import * as v from 'valibot';

// summary: string
const { data: summary } = await session.prompt(`Summarize this diff:\n${diff}`, {
  result: v.string(),
});

// diagnosis: { reproducible: boolean, skipped: boolean }
const { data: diagnosis } = await session.skill(reproduceIssue, {
  args: { issueNumber, issue },
  result: v.object({
    reproducible: v.boolean(),
    skipped: v.boolean(),
  }),
});
```

### Connecting external CLIs

Your agent often needs to interact with tools like `gh`, `npm`, or `git`. With `local()`, the agent's bash tool runs against the host shell directly — anything on `$PATH` is reachable. Host env vars are opt-in: only shell essentials (`PATH`, `HOME`, locale, etc.) are inherited by default, so you pass the specific vars your CLIs need via `local({ env: { ... } })`.

In GitHub Actions, this means you set the secrets you want the agent's CLIs to see in the workflow `env:` block, then forward them explicitly into the sandbox. The runner is your isolation boundary; flue makes the inner boundary (host → spawned shell) explicit.

`.flue/actions/triage.ts`:

```typescript
import { defineAgent, type ActionContext } from '@flue/runtime';
import reproduceIssue from '../skills/reproduce-issue/SKILL.md' with { type: 'skill' };
import { local } from '@flue/runtime/node';
import * as v from 'valibot';

export const triggers = {};

const triageAgent = defineAgent({
  name: 'issue-triage',
  model: 'anthropic/claude-opus-4-7',
  instructions: 'Triage GitHub issues carefully. Use the available reproduction skill before deciding severity.',
  skills: [reproduceIssue],
});

export default async function ({ init, payload }: ActionContext) {
  const harness = await init({
    agent: triageAgent,
    sandbox: local({
      env: {
        GH_TOKEN: process.env.GH_TOKEN,
        NPM_TOKEN: process.env.NPM_TOKEN,
      },
    }),
  });
  const session = await harness.session();

  const reproduction = await session.skill(reproduceIssue, {
    args: { issueNumber: payload.issueNumber },
    result: v.object({ reproducible: v.boolean(), notes: v.string() }),
  });
  const { data } = await session.prompt(`Complete triage for issue ${payload.issueNumber}.\n\nReproduction notes: ${reproduction.data.notes}`, {
    result: v.object({
      severity: v.picklist(['low', 'medium', 'high', 'critical']),
      reproducible: v.boolean(),
      summary: v.string(),
      fix_applied: v.boolean(),
    }),
  });

  return data;
}
```

If you want a tighter boundary — the agent can call a specific operation but never see the underlying token — wrap the operation as a custom tool with `init({ tools: [...] })`. The tool implementation reads the secret from `process.env`; the agent only sees the tool's parameters and result.

### Bundled skills and subagents

Treat a full triage workflow as an agent. Smaller reusable playbooks become bundled skills the agent can run as explicit steps. For example, the action above imports this skill into `triageAgent`:

`.flue/skills/reproduce-issue/SKILL.md`:

```markdown
---
name: reproduce-issue
description: Attempt to reproduce a GitHub issue before severity is assigned.
---

Use the issue number from the arguments. Inspect the report with `gh issue view`, read relevant project files, and run only the smallest commands needed to confirm whether the behavior reproduces. Return concise notes and whether reproduction succeeded.
```

If triage needs a specialist, add a subagent:

```typescript
const patchAuthor = defineAgent({
  name: 'patch-author',
  model: 'anthropic/claude-sonnet-4-6',
  instructions: 'Propose the smallest safe patch after triage is complete.',
});

const triageAgent = defineAgent({
  name: 'issue-triage',
  model: 'anthropic/claude-opus-4-7',
  skills: [reproduceIssue],
  subagents: [patchAuthor],
});

await session.task('Draft a patch for this reproduced issue.', { agent: patchAuthor });
```

`loadFromSandbox: true` is available for advanced cases where an action intentionally consumes repo-local `AGENTS.md` or sandbox skills, but this guide's primary shape keeps the agent and its skills in the Flue source tree so they build and deploy together.

### Wiring it into GitHub Actions

`.github/workflows/issue-triage.yml`:

```yaml
name: Issue Triage

on:
  issues:
    types: [opened]

jobs:
  triage:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
      issues: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - name: Run triage agent
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          npx flue run triage --target node \
            --id "triage-${{ github.event.issue.number }}" \
            --payload '{"issueNumber": ${{ github.event.issue.number }}}'
```

The `--payload` flag passes JSON data to the agent's `payload` property. `GITHUB_TOKEN` is provided automatically by GitHub Actions.

## Typed results and orchestration

Result schemas aren't just for type safety — they're how you orchestrate multi-step workflows. Because you get typed data back from `prompt()` and `skill()`, you can branch on results within a single agent:

```typescript
import { type ActionContext } from '@flue/runtime';
import autoFix from '../skills/auto-fix/SKILL.md' with { type: 'skill' };
import reproduceIssue from '../skills/reproduce-issue/SKILL.md' with { type: 'skill' };
import { local } from '@flue/runtime/node';
import * as v from 'valibot';

export default async function ({ init, payload }: ActionContext) {
  const harness = await init({
    sandbox: local(),
    model: 'anthropic/claude-sonnet-4-6',
    skills: [reproduceIssue, autoFix],
  });
  const session = await harness.session();
  const { data } = await session.skill(reproduceIssue, {
    args: { issueNumber: payload.issueNumber },
    result: v.object({ severity: v.picklist(['low', 'medium', 'high', 'critical']), reproducible: v.boolean(), summary: v.string() }),
  });

  if (data.severity === 'critical' && data.reproducible) {
    await session.skill(autoFix, {
      args: { issueNumber: payload.issueNumber },
      result: v.object({ fix_applied: v.boolean(), pr_url: v.optional(v.string()) }),
    });
  }

  return data;
}
```

This pattern — prompt or skill call, check the result, decide what to do next — is how you build sophisticated agents that go beyond single-shot prompts.

## Running agents locally

During development, `flue run` is your main tool. It builds the project and runs the agent in one step:

```bash
# Run with a payload
npx flue run triage --target node --id test-1 \
  --payload '{"issueNumber": 42}'

# Pipe the result to jq
npx flue run triage --target node --id test-2 \
  --payload '{"issueNumber": 42}' | jq '.severity'
```

The CLI builds your project root, starts a temporary server, invokes the agent via SSE, streams progress to stderr, and prints the final result to stdout. The `--id` flag identifies the agent instance — use a consistent ID to resume the default harness/session, or a unique one for a fresh start.
