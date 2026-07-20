import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createCloudflareAgentRuntime } from '../src/cloudflare/agent-coordinator.ts';
import type { ConversationRecord } from '../src/conversation-records.ts';
import { ConversationRecordWriter } from '../src/conversation-writer.ts';
import { ensureAgentConversation } from '../src/internal.ts';
import type { ConversationStreamStore } from '../src/runtime/conversation-stream-store.ts';
import { agentStreamPath } from '../src/runtime/event-stream-store.ts';

function queryExpectsRows(query: string): boolean {
	const trimmed = query.trimStart().toUpperCase();
	if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) return true;
	if (/\bRETURNING\b/i.test(query)) return true;
	return false;
}

function makeFakeSql() {
	const db = new DatabaseSync(':memory:');
	return {
		db,
		storage: {
			sql: {
				exec(query: string, ...bindings: unknown[]) {
					const stmt = db.prepare(query);
					let rows: unknown[];
					if (queryExpectsRows(query)) {
						rows = stmt.all(...(bindings as never[]));
					} else {
						stmt.run(...(bindings as never[]));
						rows = [];
					}
					return {
						toArray() {
							return rows as Record<string, unknown>[];
						},
					};
				},
			},
			transactionSync<T>(closure: () => T): T {
				db.exec('BEGIN');
				try {
					const result = closure();
					db.exec('COMMIT');
					return result;
				} catch (error) {
					db.exec('ROLLBACK');
					throw error;
				}
			},
		},
	};
}

function makeInstance(storage: ReturnType<typeof makeFakeSql>['storage']) {
	return {
		name: 'agent-1',
		env: {},
		ctx: {
			id: { toString: () => 'do-1' },
			storage,
		},
		async __unsafe_ensureInitialized() {},
		async schedule() {},
		async runFiber() {},
	};
}

/** Binds an agent instance the way the generated runtime does, registering the
 * instance's coordinator for ensureAgentConversation(). */
function attachInstance() {
	const { storage } = makeFakeSql();
	const runtime = createCloudflareAgentRuntime({
		agents: [],
		createContext: () => {
			throw new Error('Unexpected context creation.');
		},
		runWithInstanceContext(_instance, _agentName, callback) {
			return callback();
		},
	});
	const instance = makeInstance(storage);
	const prepared = runtime.prepare({
		storage,
		className: 'FlueAssistantAgent',
		agentName: 'assistant',
	});
	runtime.attach(instance, prepared);
	return { instance, conversationStreamStore: prepared.conversationStreamStore };
}

async function readCanonicalRecords(store: ConversationStreamStore): Promise<ConversationRecord[]> {
	const read = await store.read(agentStreamPath('assistant', 'agent-1'));
	return read.batches.flatMap((batch) => batch.records);
}

describe('ensureAgentConversation()', () => {
	it('creates the stream and root conversation with no other records', async () => {
		const { instance, conversationStreamStore } = attachInstance();

		await ensureAgentConversation(instance);

		const records = await readCanonicalRecords(conversationStreamStore);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			type: 'conversation_created',
			kind: 'root',
			harness: 'default',
			session: 'default',
		});
	});

	it('is idempotent: repeated ensures append nothing', async () => {
		const { instance, conversationStreamStore } = attachInstance();

		await ensureAgentConversation(instance);
		await ensureAgentConversation(instance);

		const records = await readCanonicalRecords(conversationStreamStore);
		expect(records).toHaveLength(1);
	});

	it('leaves an existing conversation untouched, even mid-turn', async () => {
		const { instance, conversationStreamStore } = attachInstance();
		// Seed the canonical stream mid-turn: a user message whose assistant
		// reply has started but not completed.
		const seed = await ConversationRecordWriter.create({
			store: conversationStreamStore,
			path: agentStreamPath('assistant', 'agent-1'),
			identity: { agentName: 'assistant', instanceId: 'agent-1' },
			producerId: 'seed-producer',
		});
		await seed.ensureConversation({
			kind: 'root',
			conversationId: 'conversation-1',
			harness: 'default',
			session: 'default',
			affinityKey: 'affinity-1',
			createdAt: '2026-01-01T00:00:00.000Z',
		});
		await seed.append([
			{
				v: 1,
				id: 'record_user_1',
				type: 'user_message',
				conversationId: 'conversation-1',
				harness: 'default',
				session: 'default',
				timestamp: '2026-01-01T00:00:01.000Z',
				messageId: 'entry_user_1',
				parentId: null,
				content: [{ type: 'text', text: 'Hello' }],
			},
			{
				v: 1,
				id: 'record_assistant_started_1',
				type: 'assistant_message_started',
				conversationId: 'conversation-1',
				harness: 'default',
				session: 'default',
				timestamp: '2026-01-01T00:00:02.000Z',
				messageId: 'entry_assistant_1',
				parentId: 'entry_user_1',
				modelInfo: { api: 'test', provider: 'test', model: 'test-model' },
			},
		]);

		await ensureAgentConversation(instance);

		const records = await readCanonicalRecords(conversationStreamStore);
		expect(records.map((record) => record.id)).toEqual([
			'record_conversation_created_conversation-1',
			'record_user_1',
			'record_assistant_started_1',
		]);
	});

	it('throws when the coordinator is not attached to the instance', async () => {
		await expect(ensureAgentConversation({})).rejects.toThrow(/coordinator is not attached/);
	});
});
