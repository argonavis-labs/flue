---
title: flue console
description: Reference for interactively exercising an agent or inspecting one workflow invocation.
lastReviewedAt: 2026-06-22
---

## Synopsis

```bash
flue console <name> [--target <node|cloudflare>] [--id <id>] [--input <json>] [--server <path|url>] [--header 'Name: value'] [--root <path>] [--output <path>] [--config <path>] [--env <path>]
```

## Description

`flue console` opens a terminal UI for one discovered agent or workflow. With no absolute `--server`, it starts a temporary Node.js or Cloudflare HTTP runtime, runs the authored `app.ts` and its middleware, and reaches the resource through an existing authored `flue()` mount. It does not watch or reload source files.

The temporary runtime makes route-free discovered resources available through that mount. It does not create a mount or change the application's route structure. Authored resource middleware still runs when present.

An agent console keeps one agent instance open for sequential prompts. A workflow console invokes one workflow and remains open as a read-only transcript after completion. Exit the console to stop its temporary runtime.

## Resource names

`<name>` may identify an agent or workflow. If both kinds use the same name, qualify it:

```bash
flue console agent:report
flue console workflow:report --input '{"period":"week"}'
```

An absolute `--server` always requires `agent:<name>` or `workflow:<name>` because no local project is available for discovery.

## Input and identity

Agent `--input` uses the public prompt body:

```json
{ "message": "Review the open issues." }
```

It may also include the public `images` field. Without `--input`, an agent console opens ready for the first message. Text entered in the composer is submitted as `{ "message": "..." }`; only one prompt is active at a time.

`--id` selects the persistent agent-instance ID. If omitted, Flue generates an ID and displays it. Reusing an ID resumes persisted state only when the configured persistence adapter survives the temporary process. Workflow `--id` is not supported; workflows use their generated run IDs.

Workflow `--input` is parsed as JSON and passed unchanged. It may be omitted when the workflow accepts omitted input.

## Server and headers

`--server` selects the Flue base URL:

```bash
flue console assistant --server /api/flue
flue console agent:assistant --server https://example.com/api/flue
```

A path starts a temporary local runtime and points the SDK at that authored mount. An absolute URL attaches to an existing local or deployed application and skips local configuration, discovery, build, and startup. `--server` never creates, moves, or alters routes.

Repeat `--header` to send authentication or application context on admission, stream reads, and reconnects:

```bash
flue console assistant --header 'Authorization: Bearer ...' --header 'X-User-Id: customer-123'
```

For repeated header names, the final value wins case-insensitively.

## Target support

Temporary consoles support both `--target node` and `--target cloudflare`. The selected target defaults to project configuration. Cloudflare uses the normal local Vite/workerd runtime and its persisted development state.

## Limitations

The console does not live-reload source files, accept slash commands, queue concurrent agent prompts, or start multiple workflows. Start another console for a new instance or invocation.

See [`flue run`](/docs/cli/run/) for a non-interactive operation that exits after completion.
