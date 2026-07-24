import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlueConversationSnapshot } from '../src/public/conversation.ts';
import {
	SSE_SYNC_INTERVAL_MS,
	type ConversationStreamChunk,
} from '../src/public/conversation-stream.ts';
import {
	type AgentConversationObservationSource,
	createAgentConversationObservation,
} from '../src/public/observe.ts';
import type { FlueEventStream } from '../src/public/stream.ts';

const FOLLOW_OFFSET = '0000000000000000_0000000000000001';

function pushStream<T>() {
	const queue: T[] = [];
	let notify: (() => void) | undefined;
	let ended = false;
	let cancelled = false;
	const stream: FlueEventStream<T> = {
		cancel() {
			cancelled = true;
			ended = true;
			notify?.();
		},
		offset: '0',
		[Symbol.asyncIterator]() {
			return {
				async next(): Promise<IteratorResult<T>> {
					while (true) {
						if (queue.length > 0) return { value: queue.shift() as T, done: false };
						if (ended) return { value: undefined as T, done: true };
						await new Promise<void>((resolve) => {
							notify = resolve;
						});
					}
				},
			};
		},
	};
	return {
		stream,
		push(item: T) {
			queue.push(item);
			notify?.();
		},
		end() {
			ended = true;
			notify?.();
		},
		get cancelled() {
			return cancelled;
		},
	};
}

function makeSource() {
	const snapshot = {
		v: 1,
		conversationId: 'c1',
		offset: FOLLOW_OFFSET,
		messages: [],
		settlements: [],
	} as unknown as FlueConversationSnapshot;
	const streams: ReturnType<typeof pushStream<ConversationStreamChunk>>[] = [];
	let historyCalls = 0;
	const source: AgentConversationObservationSource = {
		async history() {
			historyCalls++;
			return snapshot;
		},
		updates() {
			const next = pushStream<ConversationStreamChunk>();
			streams.push(next);
			return next.stream;
		},
	};
	return { source, streams, historyCalls: () => historyCalls };
}

async function flush() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

const delta = (batch: number, index = 0): ConversationStreamChunk => ({
	type: 'message-delta',
	conversationId: 'c1',
	messageId: 'a1',
	kind: 'text',
	delta: 'x',
	position: { batch, index },
});

const sync = (
	connectionId: string,
	sentChunks: number,
	sinceOffset = FOLLOW_OFFSET,
): ConversationStreamChunk => ({ type: 'sync', connectionId, sentChunks, sinceOffset });

describe('createAgentConversationObservation() sync frames', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('rehydrates when an interior chunk is lost even though a later chunk was applied', async () => {
		const { source, streams, historyCalls } = makeSource();
		const observation = createAgentConversationObservation(source, { live: 'sse' });
		observation.subscribe(() => {});
		await flush();
		streams[0]?.push(delta(1));
		// The chunk at batch 2 is lost in transit; batch 3 still arrives and applies.
		streams[0]?.push(delta(3));
		await flush();

		streams[0]?.push(sync('conn-1', 3));
		await flush();

		expect(streams[0]?.cancelled).toBe(true);
		await vi.advanceTimersByTimeAsync(1_100);
		await flush();
		expect(historyCalls()).toBe(2);
		observation.close();
	});

	it('rehydrates when the tail chunk is lost', async () => {
		const { source, streams, historyCalls } = makeSource();
		const observation = createAgentConversationObservation(source, { live: 'sse' });
		observation.subscribe(() => {});
		await flush();
		streams[0]?.push(delta(1));
		await flush();

		streams[0]?.push(sync('conn-1', 2));
		await flush();

		expect(streams[0]?.cancelled).toBe(true);
		await vi.advanceTimersByTimeAsync(1_100);
		await flush();
		expect(historyCalls()).toBe(2);
		observation.close();
	});

	it('rehydrates when chunks were sent but none arrived', async () => {
		const { source, streams, historyCalls } = makeSource();
		const observation = createAgentConversationObservation(source, { live: 'sse' });
		observation.subscribe(() => {});
		await flush();

		streams[0]?.push(sync('conn-1', 1));
		await flush();

		expect(streams[0]?.cancelled).toBe(true);
		await vi.advanceTimersByTimeAsync(1_100);
		await flush();
		expect(historyCalls()).toBe(2);
		observation.close();
	});

	it('rehydrates when the first sync reports a connection that started past the follow offset', async () => {
		const { source, streams, historyCalls } = makeSource();
		const observation = createAgentConversationObservation(source, { live: 'sse' });
		observation.subscribe(() => {});
		await flush();

		// A hidden reconnect before any sync: the replacement connection starts
		// from the advanced offset and truthfully reports zero sent chunks.
		streams[0]?.push(sync('conn-2', 0, '0000000000000000_0000000000000005'));
		await flush();

		expect(streams[0]?.cancelled).toBe(true);
		await vi.advanceTimersByTimeAsync(1_100);
		await flush();
		expect(historyCalls()).toBe(2);
		observation.close();
	});

	it('treats a matching sent count from the follow offset as a no-op and never counts sync frames', async () => {
		const { source, streams, historyCalls } = makeSource();
		const observation = createAgentConversationObservation(source, { live: 'sse' });
		observation.subscribe(() => {});
		await flush();
		streams[0]?.push(delta(1));
		streams[0]?.push(delta(2));
		await flush();

		streams[0]?.push(sync('conn-1', 2));
		streams[0]?.push(sync('conn-1', 2, 'ignored-after-first-sync'));
		await flush();

		expect(streams[0]?.cancelled).toBe(false);
		expect(historyCalls()).toBe(1);
		observation.close();
	});

	it('counts received chunks per stream, not across rehydrates', async () => {
		const { source, streams, historyCalls } = makeSource();
		const observation = createAgentConversationObservation(source, { live: 'sse' });
		observation.subscribe(() => {});
		await flush();
		streams[0]?.push(sync('conn-1', 1));
		await flush();
		await vi.advanceTimersByTimeAsync(1_100);
		await flush();
		expect(historyCalls()).toBe(2);

		streams[1]?.push(delta(5));
		await flush();
		streams[1]?.push(sync('conn-2', 1));
		await flush();

		expect(streams[1]?.cancelled).toBe(false);
		expect(historyCalls()).toBe(2);
		observation.close();
	});

	it('rehydrates when the sync connection nonce changes mid-stream', async () => {
		const { source, streams, historyCalls } = makeSource();
		const observation = createAgentConversationObservation(source, { live: 'sse' });
		observation.subscribe(() => {});
		await flush();
		streams[0]?.push(sync('conn-1', 0));
		await flush();
		expect(streams[0]?.cancelled).toBe(false);

		streams[0]?.push(sync('conn-2', 0));
		await flush();

		expect(streams[0]?.cancelled).toBe(true);
		await vi.advanceTimersByTimeAsync(1_100);
		await flush();
		expect(historyCalls()).toBe(2);
		observation.close();
	});

	it('arms the sync watchdog only after the first sync frame ever observed', async () => {
		const { source, streams, historyCalls } = makeSource();
		const observation = createAgentConversationObservation(source, { live: 'sse' });
		observation.subscribe(() => {});
		await flush();

		await vi.advanceTimersByTimeAsync(SSE_SYNC_INTERVAL_MS * 10);
		await flush();

		expect(streams[0]?.cancelled).toBe(false);
		expect(historyCalls()).toBe(1);
		observation.close();
	});

	it('arms a first-sync deadline at stream open once sync support was observed', async () => {
		const { source, streams, historyCalls } = makeSource();
		const observation = createAgentConversationObservation(source, { live: 'sse' });
		observation.subscribe(() => {});
		await flush();
		streams[0]?.push(sync('conn-1', 1));
		await flush();
		await vi.advanceTimersByTimeAsync(1_100);
		await flush();
		expect(historyCalls()).toBe(2);

		// The second stream never yields a sync frame: a from-birth stall that a
		// masking proxy would keep alive forever. Sync support is negotiated, so
		// the deadline is already armed.
		await vi.advanceTimersByTimeAsync(SSE_SYNC_INTERVAL_MS * 3 + 1_000);
		await flush();
		expect(streams[1]?.cancelled).toBe(true);
		await vi.advanceTimersByTimeAsync(2_200);
		await flush();
		expect(historyCalls()).toBe(3);
		observation.close();
	});

	it('rehydrates when sync frames stop for three intervals', async () => {
		const { source, streams, historyCalls } = makeSource();
		const observation = createAgentConversationObservation(source, { live: 'sse' });
		observation.subscribe(() => {});
		await flush();
		streams[0]?.push(sync('conn-1', 0));
		await flush();

		await vi.advanceTimersByTimeAsync(SSE_SYNC_INTERVAL_MS * 3 + 1_000);
		await flush();

		expect(streams[0]?.cancelled).toBe(true);
		await vi.advanceTimersByTimeAsync(1_100);
		await flush();
		expect(historyCalls()).toBe(2);
		observation.close();
	});

	it('resets the sync watchdog on every sync frame', async () => {
		const { source, streams, historyCalls } = makeSource();
		const observation = createAgentConversationObservation(source, { live: 'sse' });
		observation.subscribe(() => {});
		await flush();
		streams[0]?.push(sync('conn-1', 0));
		await flush();

		for (let i = 0; i < 4; i++) {
			await vi.advanceTimersByTimeAsync(SSE_SYNC_INTERVAL_MS * 2);
			streams[0]?.push(sync('conn-1', 0));
			await flush();
		}

		expect(streams[0]?.cancelled).toBe(false);
		expect(historyCalls()).toBe(1);
		observation.close();
	});

	it('stops the sync watchdog when the observation closes', async () => {
		const { source, streams, historyCalls } = makeSource();
		const observation = createAgentConversationObservation(source, { live: 'sse' });
		observation.subscribe(() => {});
		await flush();
		streams[0]?.push(sync('conn-1', 0));
		await flush();

		observation.close();
		await vi.advanceTimersByTimeAsync(SSE_SYNC_INTERVAL_MS * 10);
		await flush();

		expect(historyCalls()).toBe(1);
	});
});
