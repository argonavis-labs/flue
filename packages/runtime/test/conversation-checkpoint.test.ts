import { describe, expect, it, vi } from 'vitest';
import { loadReducedConversationState } from '../src/conversation-reader.ts';
import type { ConversationRecord } from '../src/conversation-records.ts';
import { applyConversationRecord, createReducedInstanceState } from '../src/conversation-reducer.ts';
import {
	decodeReducedState,
	encodeReducedState,
	SNAPSHOT_VERSION,
} from '../src/conversation-snapshot.ts';
import { ConversationRecordWriter } from '../src/conversation-writer.ts';
import { ConversationRecordInvariantError } from '../src/errors.ts';
import { InMemoryConversationStreamStore } from '../src/runtime/conversation-stream-store.ts';

const PATH = 'agents/assistant/instance-1';
const IDENTITY = { agentName: 'assistant', instanceId: 'instance-1' };

function userRecord(id: string): ConversationRecord {
	return {
		v: 1,
		id,
		type: 'user_message',
		conversationId: 'conversation-1',
		harness: 'default',
		session: 'default',
		timestamp: '2026-01-01T00:00:00.000Z',
		messageId: `entry_${id}`,
		parentId: null,
		content: [{ type: 'text', text: `payload for ${id}` }],
	};
}

function creationRecord(): ConversationRecord {
	return {
		v: 1,
		id: 'record-created',
		type: 'conversation_created',
		conversationId: 'conversation-1',
		harness: 'default',
		session: 'default',
		timestamp: '2026-01-01T00:00:00.000Z',
		affinityKey: 'aff-1',
		createdAt: '2026-01-01T00:00:00.000Z',
		kind: 'root',
	};
}

// A linear chain: each user message extends the previous one.
function chainedRecords(count: number): ConversationRecord[] {
	const records: ConversationRecord[] = [creationRecord()];
	let parentId: string | null = null;
	for (let index = 0; index < count; index++) {
		const record = userRecord(`record-${index}`) as Extract<
			ConversationRecord,
			{ type: 'user_message' }
		>;
		record.parentId = parentId;
		parentId = record.messageId;
		records.push(record);
	}
	return records;
}

async function writerWith(store: InMemoryConversationStreamStore) {
	const writer = await ConversationRecordWriter.create({
		store,
		path: PATH,
		identity: IDENTITY,
		producerId: 'producer-1',
	});
	// The writer maintains (and therefore checkpoints) its reduced state only
	// once loaded — which every production session does at turn start.
	await writer.loadReducedState();
	return writer;
}

// Every Map/Set-bearing codec path in one stream; a symmetric codec bug
// round-trips byte-identically, so the decisive check is continued-reduction equivalence.
function complexRecords(): ConversationRecord[] {
	const scope = {
		v: 1 as const,
		conversationId: 'conversation-1',
		harness: 'default',
		session: 'default',
		timestamp: '2026-01-01T00:00:00.000Z',
	};
	const attachment = { id: 'att-1', mimeType: 'image/png', size: 1234, filename: 'shot.png' };
	return [
		creationRecord(),
		{
			...scope,
			id: 'r-user',
			type: 'user_message',
			messageId: 'entry_user',
			parentId: null,
			content: [
				{ type: 'text', text: 'look at this' },
				{ type: 'attachment', attachment },
			],
		},
		{ ...scope, id: 'r-a1-start', type: 'assistant_message_started', messageId: 'entry_a1', parentId: 'entry_user', turnId: 'turn-1', modelInfo: { api: 'test', provider: 'test', model: 'm' } },
		{ ...scope, id: 'r-a1-text-start', type: 'assistant_text_started', messageId: 'entry_a1', blockId: 'b-text', blockIndex: 0 },
		{ ...scope, id: 'r-a1-delta', type: 'assistant_text_delta', messageId: 'entry_a1', blockId: 'b-text', sequence: 0, delta: 'thinking done' },
		{ ...scope, id: 'r-a1-text-done', type: 'assistant_text_completed', messageId: 'entry_a1', blockId: 'b-text', deltaCount: 1 },
		{ ...scope, id: 'r-a1-tool', type: 'assistant_tool_call', messageId: 'entry_a1', blockId: 'b-tool', blockIndex: 1, toolCallId: 'call-1', name: 'lookup', arguments: { q: 1 } },
		{ ...scope, id: 'r-a1-done', type: 'assistant_message_completed', messageId: 'entry_a1', stopReason: 'toolUse', usage: { input: 1, output: 1 } },
		{
			...scope,
			id: 'r-outcome',
			type: 'tool_outcome',
			assistantMessageId: 'entry_a1',
			toolCallId: 'call-1',
			toolName: 'lookup',
			isError: false,
			content: [
				{ type: 'text', text: 'result' },
				{ type: 'attachment', attachment },
			],
			output: { answer: 42 },
			durationMs: 7,
		},
		{ ...scope, id: 'r-commit', type: 'tool_results_committed', assistantMessageId: 'entry_a1', parentId: 'entry_a1', outcomeIds: ['r-outcome'] },
		{ ...scope, id: 'r-settled', type: 'submission_settled', submissionId: 'submission-1', outcome: 'completed' },
		{
			...scope,
			id: 'r-compaction',
			type: 'compaction',
			entryId: 'entry_compaction',
			parentId: 'entry_tool_result_ZW50cnlfYTE_Y2FsbC0x',
			sourceLeafId: 'entry_tool_result_ZW50cnlfYTE_Y2FsbC0x',
			firstKeptEntryId: 'entry_a1',
			summary: 'earlier context',
			tokensBefore: 10,
			usage: { input: 1, output: 1 },
		},
		// A second assistant left MID-STREAM: in-progress blocks Map, delta
		// arrays, and blockIndexes Set survive the checkpoint boundary.
		{ ...scope, id: 'r-a2-start', type: 'assistant_message_started', messageId: 'entry_a2', parentId: 'entry_compaction', turnId: 'turn-2', modelInfo: { api: 'test', provider: 'test', model: 'm' } },
		{ ...scope, id: 'r-a2-think-start', type: 'assistant_reasoning_started', messageId: 'entry_a2', blockId: 'b-think', blockIndex: 0 },
		{ ...scope, id: 'r-a2-think-delta', type: 'assistant_reasoning_delta', messageId: 'entry_a2', blockId: 'b-think', sequence: 0, delta: 'hmm ' },
		{ ...scope, id: 'r-a2-text-start', type: 'assistant_text_started', messageId: 'entry_a2', blockId: 'b-text2', blockIndex: 1 },
		{ ...scope, id: 'r-a2-text-delta', type: 'assistant_text_delta', messageId: 'entry_a2', blockId: 'b-text2', sequence: 0, delta: 'partial answer' },
	] as ConversationRecord[];
}

describe('reduced-state snapshot codec', () => {
	it('round-trips: decode(encode(state)) re-encodes identically and reduces identically', () => {
		const records = chainedRecords(5);
		const state = createReducedInstanceState();
		for (const record of records) applyConversationRecord(state, record, '4');

		const encoded = encodeReducedState(state);
		const decoded = decodeReducedState(encoded);
		expect(encodeReducedState(decoded)).toBe(encoded);

		// Continued reduction over the decoded state matches the original.
		const tail = userRecord('record-tail') as Extract<
			ConversationRecord,
			{ type: 'user_message' }
		>;
		tail.parentId = 'entry_record-4';
		applyConversationRecord(state, tail, '5');
		applyConversationRecord(decoded, tail, '5');
		expect(encodeReducedState(decoded)).toBe(encodeReducedState(state));
	});

	it('round-trips the complex paths and stays reduction-equivalent (in-progress blocks, outcomes, attachments, compaction)', () => {
		const state = createReducedInstanceState();
		for (const record of complexRecords()) applyConversationRecord(state, record, '3');

		// The zoo is actually present.
		const conversation = state.conversations.get('conversation-1')!;
		expect(conversation.inProgressMessages.size).toBe(1);
		expect(conversation.inProgressMessages.get('entry_a2')?.blocks.size).toBe(2);
		expect(state.settledSubmissions.size).toBe(1);
		expect(conversation.entries.get('entry_user')).toMatchObject({ contentEvicted: true });

		const encoded = encodeReducedState(state);
		const decoded = decodeReducedState(encoded);
		expect(encodeReducedState(decoded)).toBe(encoded);

		// Continue the in-progress stream to completion on BOTH states — the
		// decisive divergence check for a symmetric codec bug.
		for (const record of completeSecondAssistant()) {
			applyConversationRecord(state, record, '4');
			applyConversationRecord(decoded, record, '4');
		}
		expect(encodeReducedState(decoded)).toBe(encodeReducedState(state));
	});

	it('cold load through a mid-turn checkpoint equals a full replay of the complex stream', async () => {
		const store = new InMemoryConversationStreamStore();
		const writer = await writerWith(store);
		// One record per batch lands a checkpoint mid-stream; the settle record is
		// skipped because the store rejects submission-scoped appends outside an admitted submission.
		for (const record of complexRecords()) {
			if (record.type === 'submission_settled') continue;
			await writer.append([record]);
		}
		const snapshot = await store.loadDerivedSnapshot(PATH);
		expect(snapshot).not.toBeNull();

		const viaSnapshot = await loadReducedConversationState({ store, path: PATH });
		await store.saveDerivedSnapshot(PATH, { ...snapshot!, incarnation: 'invalidated' });
		const viaFullReplay = await loadReducedConversationState({ store, path: PATH });
		expect(encodeReducedState(viaSnapshot)).toBe(encodeReducedState(viaFullReplay));
	});

	it('throws on malformed data instead of guessing', () => {
		expect(() => decodeReducedState('not json')).toThrow();
		expect(() => decodeReducedState('{"recordsThroughOffset":"1"}')).toThrow();
	});
});

function completeSecondAssistant(): ConversationRecord[] {
	return [
		{ v: 1, conversationId: 'conversation-1', harness: 'default', session: 'default', timestamp: '2026-01-01T00:00:01.000Z', id: 'r-a2-think-done', type: 'assistant_reasoning_completed', messageId: 'entry_a2', blockId: 'b-think', deltaCount: 1 },
		{ v: 1, conversationId: 'conversation-1', harness: 'default', session: 'default', timestamp: '2026-01-01T00:00:01.000Z', id: 'r-a2-text-done', type: 'assistant_text_completed', messageId: 'entry_a2', blockId: 'b-text2', deltaCount: 1 },
		{ v: 1, conversationId: 'conversation-1', harness: 'default', session: 'default', timestamp: '2026-01-01T00:00:01.000Z', id: 'r-a2-done', type: 'assistant_message_completed', messageId: 'entry_a2', stopReason: 'stop', usage: { input: 1, output: 1 } },
	] as ConversationRecord[];
}

describe('bounded record index (RUN-5441)', () => {
	it("drops a settled assistant's streaming record ids from the record index", () => {
		const state = createReducedInstanceState();
		for (const record of complexRecords()) applyConversationRecord(state, record, '3');

		// The first assistant settled: its streaming lifecycle ids are pruned...
		for (const id of ['r-a1-start', 'r-a1-text-start', 'r-a1-delta', 'r-a1-text-done', 'r-a1-tool']) {
			expect(state.recordIndex.has(id), id).toBe(false);
		}
		// ...while its completion, entry-bearing, and settlement records stay.
		for (const id of ['record-created', 'r-user', 'r-a1-done', 'r-outcome', 'r-commit', 'r-settled', 'r-compaction']) {
			expect(state.recordIndex.has(id), id).toBe(true);
		}
		// The second assistant is still mid-stream: its ids stay until settlement.
		for (const id of ['r-a2-start', 'r-a2-think-start', 'r-a2-think-delta', 'r-a2-text-start', 'r-a2-text-delta']) {
			expect(state.recordIndex.has(id), id).toBe(true);
		}
	});

	it('still skips a redelivered streaming record while its message is in progress', () => {
		const state = createReducedInstanceState();
		for (const record of complexRecords()) applyConversationRecord(state, record, '3');
		const before = encodeReducedState(state);

		const redelivered = complexRecords().find((record) => record.id === 'r-a2-text-delta')!;
		applyConversationRecord(state, redelivered, '3');
		expect(encodeReducedState(state)).toBe(before);
	});

	it('fails loudly on a streaming record redelivered after its message settled', () => {
		const state = createReducedInstanceState();
		for (const record of complexRecords()) applyConversationRecord(state, record, '3');

		const redelivered = complexRecords().find((record) => record.id === 'r-a1-delta')!;
		expect(() => applyConversationRecord(state, redelivered, '3')).toThrow(
			ConversationRecordInvariantError,
		);
	});

	it('fails loudly on a started record redelivered after its message settled', () => {
		const state = createReducedInstanceState();
		for (const record of complexRecords()) applyConversationRecord(state, record, '3');

		const redelivered = complexRecords().find((record) => record.id === 'r-a1-start')!;
		expect(() => applyConversationRecord(state, redelivered, '3')).toThrow(
			ConversationRecordInvariantError,
		);
	});

	it('a message checkpointed mid-stream prunes identically once a cold load completes it', async () => {
		const store = new InMemoryConversationStreamStore();
		const writer = await writerWith(store);
		for (const record of complexRecords()) {
			if (record.type === 'submission_settled') continue;
			await writer.append([record]);
		}
		const snapshot = await store.loadDerivedSnapshot(PATH);
		expect(snapshot).not.toBeNull();

		const viaSnapshot = await loadReducedConversationState({ store, path: PATH });
		await store.saveDerivedSnapshot(PATH, { ...snapshot!, incarnation: 'invalidated' });
		const viaFullReplay = await loadReducedConversationState({ store, path: PATH });
		for (const record of completeSecondAssistant()) {
			applyConversationRecord(viaSnapshot, record, '20');
			applyConversationRecord(viaFullReplay, record, '20');
		}
		expect(encodeReducedState(viaSnapshot)).toBe(encodeReducedState(viaFullReplay));
		for (const id of ['r-a2-start', 'r-a2-think-delta', 'r-a2-text-delta']) {
			expect(viaSnapshot.recordIndex.has(id), id).toBe(false);
		}
		expect(viaSnapshot.recordIndex.has('r-a2-done')).toBe(true);
	});
});

describe('writer checkpointing (RUN-5218)', () => {
	it('stamps recordIndex with the real durable batch offset', async () => {
		const store = new InMemoryConversationStreamStore();
		const writer = await writerWith(store);
		const [creation, first, second] = chainedRecords(2);
		const { offset: offsetA } = await writer.append([creation!, first!]);
		const { offset: offsetB } = await writer.append([second!]);

		const state = await writer.loadReducedState();
		expect(state.recordIndex.get('record-created')?.offset).toBe(offsetA);
		expect(state.recordIndex.get('record-0')?.offset).toBe(offsetA);
		expect(state.recordIndex.get('record-1')?.offset).toBe(offsetB);
	});

	it('persists a checkpoint after enough batches, and cold load replays only the tail', async () => {
		const store = new InMemoryConversationStreamStore();
		const writer = await writerWith(store);
		const records = chainedRecords(20);
		await writer.append([records[0]!]);
		for (const record of records.slice(1)) await writer.append([record]);

		const snapshot = await store.loadDerivedSnapshot(PATH);
		expect(snapshot).not.toBeNull();
		expect(snapshot?.version).toBe(SNAPSHOT_VERSION);

		// Cold load through the snapshot equals a full replay...
		const viaSnapshot = await loadReducedConversationState({ store, path: PATH });
		await store.saveDerivedSnapshot(PATH, { ...snapshot!, version: SNAPSHOT_VERSION + 1 });
		const viaFullReplay = await loadReducedConversationState({ store, path: PATH });
		expect(encodeReducedState(viaSnapshot)).toBe(encodeReducedState(viaFullReplay));

		// ...and only reads batches after the snapshot offset.
		await store.saveDerivedSnapshot(PATH, snapshot!);
		const reads: string[] = [];
		const originalRead = store.read.bind(store);
		store.read = (path, options) => {
			reads.push(options?.offset ?? '-1');
			return originalRead(path, options);
		};
		await loadReducedConversationState({ store, path: PATH });
		expect(reads.length).toBeGreaterThan(0);
		expect(reads.every((offset) => offset !== '-1')).toBe(true);
		expect(reads[0]).toBe(snapshot!.offset);
	});

	it('falls back to a full replay on corrupt data, version mismatch, or stale incarnation', async () => {
		const store = new InMemoryConversationStreamStore();
		const writer = await writerWith(store);
		for (const record of chainedRecords(20)) await writer.append([record]);
		const snapshot = await store.loadDerivedSnapshot(PATH);
		expect(snapshot).not.toBeNull();
		const clean = encodeReducedState(await loadReducedConversationState({ store, path: PATH }));

		for (const tampered of [
			{ ...snapshot!, data: '{"broken":' },
			{ ...snapshot!, version: SNAPSHOT_VERSION + 1 },
			{ ...snapshot!, incarnation: 'someone-else' },
		]) {
			await store.saveDerivedSnapshot(PATH, tampered);
			const loaded = await loadReducedConversationState({ store, path: PATH });
			expect(encodeReducedState(loaded)).toBe(clean);
		}
	});

	it('prefix loads at or past the checkpoint replay only the tail (RUN-5220)', async () => {
		const store = new InMemoryConversationStreamStore();
		const writer = await writerWith(store);
		for (const record of chainedRecords(20)) await writer.append([record]);
		const snapshot = await store.loadDerivedSnapshot(PATH);
		expect(snapshot).not.toBeNull();
		const meta = await store.getMeta(PATH);
		const head = meta!.nextOffset;

		const reads: string[] = [];
		const originalRead = store.read.bind(store);
		store.read = (path, options) => {
			reads.push(options?.offset ?? '-1');
			return originalRead(path, options);
		};
		const { loadReducedConversationPrefix } = await import('../src/conversation-reader.ts');
		const accelerated = await loadReducedConversationPrefix({ store, path: PATH, offset: head });
		expect(reads.every((offset) => offset !== '-1')).toBe(true);
		expect(accelerated.recordsThroughOffset).toBe(head);

		// An offset BEFORE the checkpoint cannot use it: clean full replay.
		reads.length = 0;
		const early = await loadReducedConversationPrefix({ store, path: PATH, offset: '0000000000000000_0000000000000002' });
		expect(reads[0]).toBe('-1');
		expect(early.recordsThroughOffset).toBe('0000000000000000_0000000000000002');
	});

	it('a failing snapshot write never fails the append', async () => {
		const store = new InMemoryConversationStreamStore();
		store.saveDerivedSnapshot = async () => {
			throw new Error('snapshot storage down');
		};
		const writer = await writerWith(store);
		for (const record of chainedRecords(20)) {
			await expect(writer.append([record])).resolves.toBeDefined();
		}
	});

	it('skips the checkpoint write when the encoded state exceeds the snapshot byte budget (RUN-5441)', async () => {
		const store = new InMemoryConversationStreamStore();
		const saves: unknown[] = [];
		const originalSave = store.saveDerivedSnapshot.bind(store);
		store.saveDerivedSnapshot = async (path, snapshot) => {
			saves.push(snapshot);
			return originalSave(path, snapshot);
		};
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const writer = await writerWith(store);
			const records = chainedRecords(19);
			(records[1] as Extract<ConversationRecord, { type: 'user_message' }>).content = [
				{ type: 'text', text: 'x'.repeat(2_100_000) },
			];
			for (const record of records) {
				await expect(writer.append([record])).resolves.toBeDefined();
			}
			expect(saves).toHaveLength(0);
			expect(errors.mock.calls.some(
				(call) => call[0] === '[flue:conversation-checkpoint-skipped]',
			)).toBe(true);
		} finally {
			errors.mockRestore();
		}
	});

	it('resumes checkpointing after a skip once compaction shrinks the state', async () => {
		const store = new InMemoryConversationStreamStore();
		const saves: unknown[] = [];
		const originalSave = store.saveDerivedSnapshot.bind(store);
		store.saveDerivedSnapshot = async (path, snapshot) => {
			saves.push(snapshot);
			return originalSave(path, snapshot);
		};
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const writer = await writerWith(store);
			const records = chainedRecords(18);
			(records[1] as Extract<ConversationRecord, { type: 'user_message' }>).content = [
				{ type: 'text', text: 'x'.repeat(2_100_000) },
			];
			for (const record of records) await writer.append([record]);
			expect(saves).toHaveLength(0);

			await writer.append([
				{
					v: 1,
					id: 'record-compaction',
					type: 'compaction',
					conversationId: 'conversation-1',
					harness: 'default',
					session: 'default',
					timestamp: '2026-01-01T00:00:02.000Z',
					entryId: 'entry_compaction',
					parentId: 'entry_record-17',
					sourceLeafId: 'entry_record-17',
					firstKeptEntryId: 'entry_record-17',
					summary: 'squashed',
					tokensBefore: 10,
				} as ConversationRecord,
			]);
			let parentId = 'entry_compaction';
			for (let index = 0; index < 12; index++) {
				const record = userRecord(`record-b2-${index}`) as Extract<
					ConversationRecord,
					{ type: 'user_message' }
				>;
				record.parentId = parentId;
				parentId = record.messageId;
				await writer.append([record]);
			}
			expect(saves).toHaveLength(1);
		} finally {
			errors.mockRestore();
		}
	});

	it('delete drops the snapshot with the stream', async () => {
		const store = new InMemoryConversationStreamStore();
		const writer = await writerWith(store);
		for (const record of chainedRecords(20)) await writer.append([record]);
		expect(await store.loadDerivedSnapshot(PATH)).not.toBeNull();
		await store.delete(PATH);
		expect(await store.loadDerivedSnapshot(PATH)).toBeNull();
	});
});
