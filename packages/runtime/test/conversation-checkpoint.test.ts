import { describe, expect, it } from 'vitest';
import { loadReducedConversationState } from '../src/conversation-reader.ts';
import type { ConversationRecord } from '../src/conversation-records.ts';
import { applyConversationRecord, createReducedInstanceState } from '../src/conversation-reducer.ts';
import {
	decodeReducedState,
	encodeReducedState,
	SNAPSHOT_VERSION,
} from '../src/conversation-snapshot.ts';
import { ConversationRecordWriter } from '../src/conversation-writer.ts';
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

	it('throws on malformed data instead of guessing', () => {
		expect(() => decodeReducedState('not json')).toThrow();
		expect(() => decodeReducedState('{"recordsThroughOffset":"1"}')).toThrow();
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

	it('delete drops the snapshot with the stream', async () => {
		const store = new InMemoryConversationStreamStore();
		const writer = await writerWith(store);
		for (const record of chainedRecords(20)) await writer.append([record]);
		expect(await store.loadDerivedSnapshot(PATH)).not.toBeNull();
		await store.delete(PATH);
		expect(await store.loadDerivedSnapshot(PATH)).toBeNull();
	});
});
