# RUN-6108 conversation-stream reproduction

This runbook deterministically reproduces
[RUN-6108](https://linear.app/argonavislabs/issue/RUN-6108/v2-run-stopped-with-conversation-stream-contract-error)
on the Flue commit that [PR #52](https://github.com/argonavis-labs/flue/pull/52)
was based on (`d318a300a3453607a9c641e25612959d791c1048`). It uses the real
session, agent loop, canonical writer, and conversation reducer with in-memory
stores. Only the provider stream is controlled.

The reproduction lives in
[`packages/runtime/test/run-6108-reproduction.test.ts`](../../packages/runtime/test/run-6108-reproduction.test.ts).
Its passing assertion intentionally describes the broken behavior; a pass does
not mean the bug is fixed.

## Run it

From the Flue repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @flue/runtime build
pnpm --filter @flue/runtime exec vitest run test/run-6108-reproduction.test.ts
```

On the affected base, Vitest reports one passing test. The fixture proves this
sequence:

1. The model stream starts an assistant message and writes `Partial`.
2. The model stream throws `simulated mid-stream failure`.
3. Flue persists the agent core's completed error assistant message but leaves
   the original assistant message in progress.
4. `session.prompt('Try again.')` fails with
   `conversation_record_invariant`: `Cannot advance the conversation while an
   assistant message is in progress.`
5. The provider call count stays at one, proving Retry fails before it can call
   the provider again.

This is the poisoned-history behavior from the ticket. The first prompt's
error alone is not the bug; the bug is that the same session cannot accept a
later prompt.

## Manual fix loop

Keep the fixture unchanged while implementing. On a proper fix, its final
broken-behavior assertions fail because the second prompt now succeeds. Replace
the block after the first prompt with these post-fix assertions:

```ts
await expect(session.prompt('Try again.')).resolves.toMatchObject({
	text: 'Recovered response.',
});

const recovered = await writer.findConversation('default', 'default');
expect(recovered?.inProgressMessages.size).toBe(0);
expect(streamCalls).toBe(2);
```

Then rerun the focused command. Keep the original assertion that the first
prompt rejects: the injected provider failure is intentional, while later
session usability is the contract under repair.

## Full local-dev or Miniflare check

Use the same fault at the registered model-provider boundary if you also verify
through Runner V2:

1. Link the Flue runtime under test into Runner and rebuild the agent-runtime
   bundle.
2. Wrap the selected local provider so its first stream emits one text delta
   and then throws; let its second stream complete normally.
3. Start Runner's normal local development stack and create a fresh V2 session.
4. Send one prompt, wait for the injected failure, then press Retry.
5. On the affected runtime, Retry stops with the conversation-stream contract
   error before the provider's second call. On the fixed runtime, the second
   call runs and its response completes.

Do not use a dropped HTTP response as the fault. OpenRouter can normalize that
transport failure into a completed error message, which leaves no abandoned
assistant stream and produces a convincing false negative. Injecting at the
model-stream boundary is what makes this check equivalent to the deterministic
fixture above.
