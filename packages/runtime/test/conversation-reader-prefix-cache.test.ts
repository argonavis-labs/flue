import { describe, expect, it } from 'vitest';
import { putPrefixState, takePrefixState } from '../src/conversation-reader.ts';
import type { ConversationRecord } from '../src/conversation-records.ts';
import {
	createReducedInstanceState,
	reductionDiagnostics,
} from '../src/conversation-reducer.ts';
import { sqlite } from '../src/node/agent-execution-store.ts';
import type { ConversationStreamStore } from '../src/runtime/conversation-stream-store.ts';
import { handleAgentConversationRead } from '../src/runtime/handle-conversation-routes.ts';

async function setup() {
	const adapter = sqlite();
	await adapter.migrate?.();
	const stores = await adapter.connect();
	const path = 'agents/assistant/instance-1';
	await stores.conversationStreamStore.createStream(path, {
		agentName: 'assistant',
		instanceId: 'instance-1',
	});
	const claim = await stores.conversationStreamStore.acquireProducer(path, 'producer-1');
	let sequence = claim.nextProducerSequence;
	const append = async (records: ConversationRecord[]) => {
		const result = await stores.conversationStreamStore.append({
			path,
			producerId: claim.producerId,
			producerEpoch: claim.producerEpoch,
			incarnation: claim.incarnation,
			producerSequence: sequence++,
			records,
		});
		return result.offset;
	};
	return { adapter, stores, path, append };
}

const scope = {
	v: 1 as const,
	conversationId: 'conversation-1',
	harness: 'default',
	session: 'default',
	timestamp: '2026-06-26T00:00:00.000Z',
};

function readUpdates(store: ConversationStreamStore, path: string, offset: string) {
	return handleAgentConversationRead({
		store,
		path,
		request: new Request(
			`https://flue.test/agents/assistant/instance-1?view=updates&offset=${encodeURIComponent(offset)}`,
		),
	});
}

describe('reduced-state prefix cache', () => {
	it('reuses the state a page left behind, replaying each record once overall', async () => {
		const { adapter, stores, path, append } = await setup();
		const offsetA = await append([
			{
				...scope,
				id: 'created-1',
				type: 'conversation_created',
				kind: 'root',
				affinityKey: 'affinity-1',
				createdAt: scope.timestamp,
			},
			{
				...scope,
				id: 'user-1',
				type: 'user_message',
				messageId: 'entry_user_1',
				parentId: null,
				content: [{ type: 'text', text: 'first' }],
			},
		]);

		reductionDiagnostics.reset();
		const page1 = await readUpdates(stores.conversationStreamStore, path, '-1');
		const page1Items = (await page1.json()) as unknown[];
		expect(page1.headers.get('Stream-Next-Offset')).toBe(offsetA);
		expect(reductionDiagnostics.prefixCacheHits).toBe(0);
		expect(reductionDiagnostics.recordsReplayed).toBe(2);

		const offsetB = await append([
			{
				...scope,
				id: 'user-2',
				type: 'user_message',
				messageId: 'entry_user_2',
				parentId: 'entry_user_1',
				content: [{ type: 'text', text: 'second' }],
			},
		]);

		// The second page takes the state the first page left at offsetA instead of
		// rebuilding the prefix from the start of the log, so across both pages each
		// of the three appended records is replayed exactly once.
		const page2 = await readUpdates(stores.conversationStreamStore, path, offsetA);
		const page2Items = (await page2.json()) as unknown[];
		expect(page2.headers.get('Stream-Next-Offset')).toBe(offsetB);
		expect(reductionDiagnostics.prefixCacheHits).toBe(1);
		expect(reductionDiagnostics.recordsReplayed).toBe(3);
		// Paged reads own their state outright, so no full-state deep clone happens.
		expect(reductionDiagnostics.fullStateClones).toBe(0);

		// The paged projection is exactly what one cold rebuild over the same range
		// produces — reuse changes the cost, never the result.
		const cold = await readUpdates(stores.conversationStreamStore, path, '-1');
		const coldItems = (await cold.json()) as unknown[];
		expect(cold.headers.get('Stream-Next-Offset')).toBe(offsetB);
		expect([...page1Items, ...page2Items]).toEqual(coldItems);
		await adapter.close?.();
	});

	it('keys cached prefix state by stream incarnation', () => {
		const store = {} as ConversationStreamStore;
		const path = 'agents/assistant/instance-1';
		const state = createReducedInstanceState();
		putPrefixState(store, path, '0_0', 'incarnation-1', state);

		// A stream that is deleted and recreated restarts its offsets, so the new
		// incarnation must never be served the previous one's state at a colliding
		// offset.
		expect(takePrefixState(store, path, '0_0', 'incarnation-2')).toBeNull();

		// The entry survives the mismatched probe, and its own incarnation TAKES it:
		// removed from the cache, not shared, so the taker owns it exclusively.
		expect(takePrefixState(store, path, '0_0', 'incarnation-1')).toBe(state);
		expect(takePrefixState(store, path, '0_0', 'incarnation-1')).toBeNull();
	});
});
