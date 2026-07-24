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
		offset: '0000000000000000_0000000000000001',
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
	lastPosition: { batch: number; index: number } | null,
): ConversationStreamChunk => ({ type: 'sync', connectionId, lastPosition });

describe('createAgentConversationObservation() sync frames', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('rehydrates when a sync frame reports a position ahead of the last applied', async () => {
		const { source, streams, historyCalls } = makeSource();
		const observation = createAgentConversationObservation(source, { live: 'sse' });
		observation.subscribe(() => {});
		await flush();
		streams[0]?.push(delta(1));
		await flush();

		streams[0]?.push(sync('conn-1', { batch: 3, index: 0 }));
		await flush();

		expect(streams[0]?.cancelled).toBe(true);
		await vi.advanceTimersByTimeAsync(1_100);
		await flush();
		expect(historyCalls()).toBe(2);
		observation.close();
	});

	it('rehydrates when a sync frame reports sent chunks while none were applied', async () => {
		const { source, streams, historyCalls } = makeSource();
		const observation = createAgentConversationObservation(source, { live: 'sse' });
		observation.subscribe(() => {});
		await flush();

		streams[0]?.push(sync('conn-1', { batch: 1, index: 0 }));
		await flush();

		expect(streams[0]?.cancelled).toBe(true);
		await vi.advanceTimersByTimeAsync(1_100);
		await flush();
		expect(historyCalls()).toBe(2);
		observation.close();
	});

	it('treats a sync frame at or below the last applied position as a no-op', async () => {
		const { source, streams, historyCalls } = makeSource();
		const observation = createAgentConversationObservation(source, { live: 'sse' });
		observation.subscribe(() => {});
		await flush();
		streams[0]?.push(delta(2));
		await flush();

		streams[0]?.push(sync('conn-1', { batch: 2, index: 0 }));
		streams[0]?.push(sync('conn-1', null));
		await flush();

		expect(streams[0]?.cancelled).toBe(false);
		expect(historyCalls()).toBe(1);
		observation.close();
	});

	it('rehydrates when the sync connection nonce changes mid-stream', async () => {
		const { source, streams, historyCalls } = makeSource();
		const observation = createAgentConversationObservation(source, { live: 'sse' });
		observation.subscribe(() => {});
		await flush();
		streams[0]?.push(sync('conn-1', null));
		await flush();
		expect(streams[0]?.cancelled).toBe(false);

		streams[0]?.push(sync('conn-2', null));
		await flush();

		expect(streams[0]?.cancelled).toBe(true);
		await vi.advanceTimersByTimeAsync(1_100);
		await flush();
		expect(historyCalls()).toBe(2);
		observation.close();
	});

	it('arms the sync watchdog only after the first sync frame', async () => {
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

	it('rehydrates when sync frames stop for three intervals', async () => {
		const { source, streams, historyCalls } = makeSource();
		const observation = createAgentConversationObservation(source, { live: 'sse' });
		observation.subscribe(() => {});
		await flush();
		streams[0]?.push(sync('conn-1', null));
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
		streams[0]?.push(sync('conn-1', null));
		await flush();

		for (let i = 0; i < 4; i++) {
			await vi.advanceTimersByTimeAsync(SSE_SYNC_INTERVAL_MS * 2);
			streams[0]?.push(sync('conn-1', null));
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
		streams[0]?.push(sync('conn-1', null));
		await flush();

		observation.close();
		await vi.advanceTimersByTimeAsync(SSE_SYNC_INTERVAL_MS * 10);
		await flush();

		expect(historyCalls()).toBe(1);
	});
});
