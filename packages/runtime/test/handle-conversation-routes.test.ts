import { describe, expect, it, vi } from 'vitest';
import type { ConversationRecord } from '../src/conversation-records.ts';
import { sqlite } from '../src/node/agent-execution-store.ts';
import type { ConversationStreamStore } from '../src/runtime/conversation-stream-store.ts';
import { createAttachmentRef } from '../src/runtime/attachment-store.ts';
import {
	handleAgentAttachmentRead,
	handleAgentConversationRead,
} from '../src/runtime/handle-conversation-routes.ts';
import { parseOffset } from '../src/runtime/event-stream-store.ts';

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

describe('handleAgentConversationRead()', () => {
	it('returns one materialized snapshot through the physical tail', async () => {
		const { adapter, stores, path, append } = await setup();
		await append([
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
				messageId: 'entry_user',
				parentId: null,
				content: [{ type: 'text', text: 'hello' }],
			},
		]);
		const physicalTail = await append([
			{
				...scope,
				id: 'created-2',
				type: 'conversation_created',
				kind: 'root',
				conversationId: 'conversation-2',
				session: 'other',
				affinityKey: 'affinity-2',
				createdAt: scope.timestamp,
			},
		]);

		const response = await handleAgentConversationRead({
			store: stores.conversationStreamStore,
			path,
			request: new Request('https://flue.test/agents/assistant/instance-1?view=history'),
		});
		const snapshot = await response.json();

		expect(snapshot).toMatchObject({
			v: 1,
			conversationId: 'conversation-1',
			offset: physicalTail,
			messages: [{ id: 'entry_user' }],
		});
		await adapter.close?.();
	});

	it('projects a whole physical batch and checkpoints only its batch offset', async () => {
		const { adapter, stores, path, append } = await setup();
		const start = await append([
			{
				...scope,
				id: 'created-1',
				type: 'conversation_created',
				kind: 'root',
				affinityKey: 'affinity-1',
				createdAt: scope.timestamp,
			},
		]);
		const tail = await append([
			{
				...scope,
				id: 'user-1',
				type: 'user_message',
				messageId: 'entry_user',
				parentId: null,
				content: [{ type: 'text', text: 'hello' }],
			},
		]);

		const response = await handleAgentConversationRead({
			store: stores.conversationStreamStore,
			path,
			request: new Request(
				`https://flue.test/agents/assistant/instance-1?view=updates&offset=${encodeURIComponent(start)}`,
			),
		});
		const updates = (await response.json()) as Array<{ position: unknown }>;

		expect(updates).toHaveLength(1);
		// Each chunk is stamped with its position: the batch ordinal it was
		// projected from (so consumers can dedupe redelivered batches) and its
		// index within that batch's projection.
		expect(updates[0]?.position).toEqual({ batch: parseOffset(tail), index: 0 });
		expect(response.headers.get('Stream-Next-Offset')).toBe(tail);
		await adapter.close?.();
	});

	it('returns an append made while a long-poll subscription is installed', async () => {
		const { adapter, stores, path, append } = await setup();
		const start = await append([
			{
				...scope,
				id: 'created-1',
				type: 'conversation_created',
				kind: 'root',
				affinityKey: 'affinity-1',
				createdAt: scope.timestamp,
			},
		]);
		const base = stores.conversationStreamStore;
		let appended = false;
		const store: ConversationStreamStore = {
			createStream: base.createStream.bind(base),
			acquireProducer: base.acquireProducer.bind(base),
			append: base.append.bind(base),
			read: base.read.bind(base),
			getMeta: base.getMeta.bind(base),
			delete: base.delete.bind(base),
			subscribe(streamPath, listener) {
				const unsubscribe = base.subscribe(streamPath, listener);
				if (!appended) {
					appended = true;
					void append([
						{
							...scope,
							id: 'user-1',
							type: 'user_message',
							messageId: 'entry_user',
							parentId: null,
							content: [{ type: 'text', text: 'hello' }],
						},
					]);
				}
				return unsubscribe;
			},
		};

		const response = await handleAgentConversationRead({
			store,
			path,
			request: new Request(
				`https://flue.test/agents/assistant/instance-1?view=updates&offset=${encodeURIComponent(start)}&live=long-poll`,
			),
		});
		const updates = await response.json();

		expect(updates).toMatchObject([
			{
				type: 'message-appended',
				message: { id: 'entry_user', metadata: { timestamp: '2026-06-26T00:00:00.000Z' } },
			},
		]);
		await adapter.close?.();
	});

	it('rejects arbitrary tail hydration', async () => {
		const { adapter, stores, path } = await setup();
		const response = await handleAgentConversationRead({
			store: stores.conversationStreamStore,
			path,
			request: new Request(
				'https://flue.test/agents/assistant/instance-1?view=history&tail=100',
			),
		});
		expect(response.status).toBe(400);
		await adapter.close?.();
	});
});

describe('handleAgentAttachmentRead()', () => {
	it('serves attachment bytes scoped to the default conversation', async () => {
		const { adapter, stores, path, append } = await setup();
		await append([
			{
				...scope,
				id: 'created-1',
				type: 'conversation_created',
				kind: 'root',
				affinityKey: 'affinity-1',
				createdAt: scope.timestamp,
			},
		]);
		const bytes = new TextEncoder().encode('hello-bytes');
		const attachment = await createAttachmentRef({ id: 'att-1', mimeType: 'text/plain', bytes });
		await stores.attachmentStore.put({
			streamPath: path,
			conversationId: scope.conversationId,
			attachment,
			bytes,
		});

		const response = await handleAgentAttachmentRead({
			conversationStore: stores.conversationStreamStore,
			attachmentStore: stores.attachmentStore,
			path,
			attachmentId: 'att-1',
		});

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('text/plain');
		expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));
		expect(await response.text()).toBe('hello-bytes');
		await adapter.close?.();
	});

	it('returns 404 for an unknown attachment id', async () => {
		const { adapter, stores, path, append } = await setup();
		await append([
			{
				...scope,
				id: 'created-1',
				type: 'conversation_created',
				kind: 'root',
				affinityKey: 'affinity-1',
				createdAt: scope.timestamp,
			},
		]);

		const response = await handleAgentAttachmentRead({
			conversationStore: stores.conversationStreamStore,
			attachmentStore: stores.attachmentStore,
			path,
			attachmentId: 'missing',
		});

		expect(response.status).toBe(404);
		await adapter.close?.();
	});
});

describe('sseResponse() sync frames', () => {
	async function openSse(options: { sync: boolean; fromHead?: boolean }) {
		const context = await setup();
		const head = await context.append([
			{
				...scope,
				id: 'created-1',
				type: 'conversation_created',
				kind: 'root',
				affinityKey: 'affinity-1',
				createdAt: scope.timestamp,
			},
		]);
		let tail: string | undefined;
		if (!options.fromHead) {
			tail = await context.append([
				{
					...scope,
					id: 'user-1',
					type: 'user_message',
					messageId: 'entry_user',
					parentId: null,
					content: [{ type: 'text', text: 'hello' }],
				},
			]);
		}
		const offset = options.fromHead ? head : '-1';
		const query = `offset=${encodeURIComponent(offset)}&live=sse${options.sync ? '&sync=1' : ''}`;
		const abort = new AbortController();
		const response = await handleAgentConversationRead({
			store: context.stores.conversationStreamStore,
			path: context.path,
			request: new Request(
				`https://flue.test/agents/assistant/instance-1?view=updates&${query}`,
				{ signal: abort.signal },
			),
		});
		const reader = (response.body as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		const readUntil = async (predicate: (text: string) => boolean) => {
			for (let i = 0; i < 50 && !predicate(buffer); i++) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
			}
			expect(predicate(buffer)).toBe(true);
			return buffer;
		};
		return { ...context, tail, abort, readUntil };
	}

	it('emits a sync frame carrying the connection nonce and sent-chunk count on the heartbeat tick', async () => {
		vi.useFakeTimers();
		try {
			const sse = await openSse({ sync: true });
			await sse.readUntil((text) => text.includes('event: control'));

			await vi.advanceTimersByTimeAsync(15_000);
			const text = await sse.readUntil((value) => value.includes('"type":"sync"'));

			const frame = text.match(/event: data\ndata:(\[\{"type":"sync".*?\])\n\n/);
			expect(frame).not.toBeNull();
			const [chunk] = JSON.parse(frame![1] as string) as [
				{ type: string; connectionId: string; sentChunks: number },
			];
			expect(chunk.connectionId).toEqual(expect.any(String));
			expect(chunk.connectionId.length).toBeGreaterThan(0);
			// Catch-up projected the created batch's reset chunk plus the user message.
			expect(chunk.sentChunks).toBe(2);
			sse.abort.abort();
			await sse.adapter.close?.();
		} finally {
			vi.useRealTimers();
		}
	});

	it('reports a zero sent count when no chunk was sent on the connection', async () => {
		vi.useFakeTimers();
		try {
			const sse = await openSse({ sync: true, fromHead: true });
			await sse.readUntil((text) => text.includes('event: control'));

			await vi.advanceTimersByTimeAsync(15_000);
			const text = await sse.readUntil((value) => value.includes('"type":"sync"'));

			const frame = text.match(/event: data\ndata:(\[\{"type":"sync".*?\])\n\n/);
			expect(frame).not.toBeNull();
			const [chunk] = JSON.parse(frame![1] as string) as [{ sentChunks: number }];
			expect(chunk.sentChunks).toBe(0);
			sse.abort.abort();
			await sse.adapter.close?.();
		} finally {
			vi.useRealTimers();
		}
	});

	it('keeps the bare heartbeat comment when sync is not requested', async () => {
		vi.useFakeTimers();
		try {
			const sse = await openSse({ sync: false });
			await sse.readUntil((text) => text.includes('event: control'));

			await vi.advanceTimersByTimeAsync(15_000);
			const text = await sse.readUntil((value) => value.includes(': heartbeat'));

			expect(text).not.toContain('"type":"sync"');
			sse.abort.abort();
			await sse.adapter.close?.();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('settled-chunk suppression', () => {
	it('logs loudly when a submission_settled record without submissionId is suppressed', async () => {
		const { adapter, stores, path, append } = await setup();
		const start = await append([
			{
				...scope,
				id: 'created-1',
				type: 'conversation_created',
				kind: 'root',
				affinityKey: 'affinity-1',
				createdAt: scope.timestamp,
			},
		]);
		await append([{ ...scope, id: 'settled-1', type: 'submission_settled', outcome: 'completed' }]);
		const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		try {
			const response = await handleAgentConversationRead({
				store: stores.conversationStreamStore,
				path,
				request: new Request(
					`https://flue.test/agents/assistant/instance-1?view=updates&offset=${encodeURIComponent(start)}`,
				),
			});
			const updates = (await response.json()) as unknown[];

			expect(updates).toEqual([]);
			expect(failure).toHaveBeenCalledWith(
				expect.stringContaining('submission_settled'),
				expect.objectContaining({ recordId: 'settled-1' }),
			);
		} finally {
			failure.mockRestore();
			await adapter.close?.();
		}
	});
});
