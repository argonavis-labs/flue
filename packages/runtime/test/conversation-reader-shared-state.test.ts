import { describe, expect, it } from 'vitest';
import { loadReducedConversationState } from '../src/conversation-reader.ts';
import type { ConversationRecord } from '../src/conversation-records.ts';
import { reductionDiagnostics } from '../src/conversation-reducer.ts';
import { InMemoryConversationStreamStore } from '../src/runtime/conversation-stream-store.ts';

const path = 'agents/assistant/instance-1';

function scope(conversationId: string) {
	return {
		v: 1 as const,
		conversationId,
		harness: 'default',
		session: 'default',
		timestamp: '2026-06-26T00:00:00.000Z',
	};
}

function createdRecord(conversationId: string): ConversationRecord {
	return {
		...scope(conversationId),
		id: `created-${conversationId}`,
		type: 'conversation_created',
		kind: 'root',
		affinityKey: `affinity-${conversationId}`,
		createdAt: '2026-06-26T00:00:00.000Z',
	};
}

function userRecord(
	conversationId: string,
	entry: string,
	parentId: string | null,
): ConversationRecord {
	return {
		...scope(conversationId),
		id: `record-${entry}`,
		type: 'user_message',
		messageId: entry,
		parentId,
		content: [{ type: 'text', text: entry }],
	};
}

async function setupStream(store: InMemoryConversationStreamStore, producerId: string) {
	await store.createStream(path, { agentName: 'assistant', instanceId: 'instance-1' });
	const claim = await store.acquireProducer(path, producerId);
	let sequence = claim.nextProducerSequence;
	const append = async (records: ConversationRecord[]) => {
		const result = await store.append({
			path,
			producerId: claim.producerId,
			producerEpoch: claim.producerEpoch,
			incarnation: claim.incarnation,
			producerSequence: sequence++,
			records,
		});
		return result.offset;
	};
	return append;
}

describe('shared reduced state per store', () => {
	it('hands the second full-state load the cached state without re-replaying the log', async () => {
		const store = new InMemoryConversationStreamStore();
		const append = await setupStream(store, 'producer-1');
		await append([createdRecord('conversation-1'), userRecord('conversation-1', 'entry_user_1', null)]);

		reductionDiagnostics.reset();
		const first = await loadReducedConversationState({ store, path });
		expect(reductionDiagnostics.recordsReplayed).toBe(2);

		// Nothing arrived since, so the warm load hands back the very same object:
		// no replay, no fork.
		const second = await loadReducedConversationState({ store, path });
		expect(second).toBe(first);
		expect(reductionDiagnostics.recordsReplayed).toBe(2);
		expect(reductionDiagnostics.fullStateClones).toBe(0);
	});

	it('forks once before applying a new batch, leaving the earlier caller\'s state unmutated', async () => {
		const store = new InMemoryConversationStreamStore();
		const append = await setupStream(store, 'producer-1');
		const offsetA = await append([
			createdRecord('conversation-1'),
			userRecord('conversation-1', 'entry_user_1', null),
		]);
		const before = await loadReducedConversationState({ store, path });
		expect(before.recordsThroughOffset).toBe(offsetA);

		const offsetB = await append([userRecord('conversation-1', 'entry_user_2', 'entry_user_1')]);

		reductionDiagnostics.reset();
		const after = await loadReducedConversationState({ store, path });

		// The load forked the shared state exactly once and replayed only the new
		// record — not the whole log.
		expect(reductionDiagnostics.fullStateClones).toBe(1);
		expect(reductionDiagnostics.recordsReplayed).toBe(1);
		expect(after).not.toBe(before);
		expect(after.recordsThroughOffset).toBe(offsetB);
		expect(after.conversations.get('conversation-1')?.entries.has('entry_user_2')).toBe(true);

		// The handle obtained before the append was never mutated underneath its
		// caller: it still ends at offsetA and never gained the new entry.
		expect(before.recordsThroughOffset).toBe(offsetA);
		expect(before.conversations.get('conversation-1')?.entries.has('entry_user_2')).toBe(false);
	});

	it('rebuilds from scratch when the stream incarnation changes', async () => {
		const store = new InMemoryConversationStreamStore();
		const append = await setupStream(store, 'producer-1');
		await append([createdRecord('conversation-1'), userRecord('conversation-1', 'entry_user_1', null)]);
		const stale = await loadReducedConversationState({ store, path });
		expect([...stale.conversations.keys()]).toEqual(['conversation-1']);

		// Recreating the stream restarts its offsets at the same path. Serving the
		// previous incarnation's cached state would skip (or misapply) the new log,
		// so the load must rebuild cold from the new stream's records only.
		await store.delete(path);
		const appendRecreated = await setupStream(store, 'producer-2');
		await appendRecreated([createdRecord('conversation-2')]);

		reductionDiagnostics.reset();
		const rebuilt = await loadReducedConversationState({ store, path });
		expect(rebuilt).not.toBe(stale);
		expect(reductionDiagnostics.recordsReplayed).toBe(1);
		expect([...rebuilt.conversations.keys()]).toEqual(['conversation-2']);
	});

	it('exposes the store and writer seams on /internal', async () => {
		// The contract tests downstream drive the record writer and the SQL
		// submission store directly; the commit promises them on /internal.
		const internal = await import('../src/internal.ts');
		expect(typeof internal.ConversationRecordWriter).toBe('function');
		expect(typeof internal.createSqlAgentExecutionStoreFromSql).toBe('function');
		expect(typeof internal.ensureSqlAgentExecutionTables).toBe('function');
	});
});
