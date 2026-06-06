---
title: Durable Execution
description: Understand how Flue agents and workflows handle server restarts, interrupted connections, and other disruptions.
---

Durable execution is about recovering safely when running work is disrupted by a server restart, deployment, lost connection, or unexpected failure. Flue handles that recovery differently for continuing agents and finite workflows.

## Durable Agents

Agents are continuing, stateful contexts. An agent instance can own named sessions, and each session records conversation history so later operations can continue from where earlier work ended. The next message may arrive immediately or months later.

Direct prompts and asynchronous `dispatch(...)` inputs are operations inside these continuing sessions. They are not workflow runs. When you need to send application-owned events such as webhooks or chat messages to an agent, see [Message-Driven Agents](/docs/guide/message-driven-agents/).

```txt
agent input → stored session history → operation completes
                     ↓
later input → reopens the same session → continues with earlier context
```

### Persist session history

A stored session includes messages and compacted context needed to reopen the conversation later. This makes the session history the durable record that lets an agent continue working after an earlier operation has finished.

Return a custom store through the `persist` option when conversation history belongs in an application-controlled database. See the [Data Persistence API](/docs/api/data-persistence-api/) for the public storage contract.

### Durable Agents on Cloudflare

On Cloudflare, generated Durable Object-backed agents store session history in SQLite by default. They also protect accepted agent input while it is being processed. Direct HTTP, SSE, and WebSocket prompts and asynchronous `dispatch(...)` inputs enter the same durable queue for their session. Inputs for one session keep their accepted order, while separate sessions can progress independently.

```txt
direct HTTP, SSE, or WebSocket prompt ─┐
                                       ├→ durable per-session queue → stored session history
dispatch(...) input ────────────────────┘
```

The connection that submitted a prompt observes the work but does not own it. If an HTTP response, SSE stream, or WebSocket closes after Cloudflare accepts the prompt, the backend work can continue. Flue does not reconstruct the lost connection or replay missed direct-agent stream events.

When the Cloudflare runtime is interrupted, Flue checks the stored input and session history before deciding what to do next. It starts work again only when it can prove that the input was not applied. If a completed response was already stored, Flue recognizes that completion. When the outcome is uncertain, Flue records a visible interruption message in the session instead of blindly repeating model or tool activity.

This recovery is intentionally conservative. Once model or tool activity may have started, repeating it could duplicate external effects such as creating a ticket, posting a reply, or sending a payment request. Use application-owned idempotency keys where repeated effects would be harmful. For dispatched input, use `dispatchId` to correlate one accepted delivery with application records.

See [Deploy Agents on Cloudflare](/docs/ecosystem/deploy/cloudflare/) for Durable Object configuration, migrations, and platform-specific recovery details.

### Durable Agents on Node.js

On Node.js, sessions and accepted input live in process memory by default. Restarting the process loses all in-flight work and session history.

Asynchronous `dispatch(...)` inputs go through an ordered submission lifecycle with SQL admission, per-session FIFO ordering, and journal tracking. Dispatches queue behind earlier same-session work, and separate sessions progress independently. Direct prompts are processed inline while the connection is open.

Because the default backing store is in-memory SQLite, this lifecycle tracking protects against concurrent access within a running process but does not survive a restart. Return a custom store through the `persist` option when conversation history must survive restarts or multiple application replicas.

See [Deploy Agents on Node.js](/docs/ecosystem/deploy/node/) for session persistence setup and deployment guidance.

### Keep workspace state separate

Persisting a conversation does not make sandbox files durable. The default virtual sandbox is an in-memory workspace, even when the session history is stored in a database. Likewise, a durable remote workspace does not preserve conversation history by itself.

Use the [Sandboxes](/docs/guide/sandboxes/) guide to choose a workspace lifecycle separately from session persistence. Keep durable application data, such as customer records or ticket state, in your own data layer.

## Durable Workflows

Workflows are finite function invocations. Each invocation runs your authored `run(...)` function once and receives its own `runId`. A workflow may load data, call external services, initialize agents, and return a result or error.

Flue workflows are not resumable. If a workflow is interrupted, Flue does not checkpoint arbitrary TypeScript execution and continue the function from the last completed line or step. Your application decides whether starting the workflow again is appropriate.

### Retry workflows explicitly

Design workflows so they can be invoked again when retry is appropriate, much like CI jobs. Make repeated steps safe where practical, and use application-owned idempotency keys around external effects whose earlier outcome may be unknown.

Starting a workflow again creates a new invocation. It does not continue the previous function call.

```txt
workflow invocation → run(...) → result or error

interrupted invocation
  └→ start a new invocation when retry is appropriate
```

If a job requires checkpointed steps that resume automatically after disruption, use a durable orchestration system appropriate to your deployment.

### Inspect workflow runs

Use a workflow's `runId` to inspect its recorded outcome and events independently of the connection that started it. This is useful for debugging, live progress, and operational tooling.

Agent prompts and dispatched agent input do not create workflow runs. Use agent operation observation for continuing agents, and reserve workflow history and `flue logs` for workflow invocations. See [Workflows](/docs/guide/workflows/) for authoring and run inspection, and [Observability](/docs/guide/observability/) for runtime events and telemetry.
