import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlueClient } from '../src/client.ts';
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
	let failure: Error | undefined;
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
						if (failure) throw failure;
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
		fail(error: Error) {
			failure = error;
			notify?.();
		},
		get cancelled() {
			return cancelled;
		},
	};
}

function makeSource(historyPlan: Array<Error | 'ok'> = [], updatesPlan: Array<Error | 'ok'> = []) {
	const snapshot = {
		v: 1,
		conversationId: 'c1',
		offset: FOLLOW_OFFSET,
		messages: [],
		settlements: [],
	} as unknown as FlueConversationSnapshot;
	const streams: ReturnType<typeof pushStream<ConversationStreamChunk>>[] = [];
	let historyCalls = 0;
	let updatesCalls = 0;
	const source: AgentConversationObservationSource = {
		async history() {
			const planned = historyPlan[historyCalls] ?? 'ok';
			historyCalls++;
			if (planned !== 'ok') throw planned;
			return snapshot;
		},
		updates() {
			const planned = updatesPlan[updatesCalls] ?? 'ok';
			updatesCalls++;
			const next = pushStream<ConversationStreamChunk>();
			if (planned !== 'ok') next.fail(planned);
			streams.push(next);
			return next.stream;
		},
	};
	return { source, streams, historyCalls: () => historyCalls, updatesCalls: () => updatesCalls };
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

const statusError = (status: number) => Object.assign(new Error(`http ${status}`), { status });

describe('createAgentConversationObservation() unauthorized recovery', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('rehydrates once when history is rejected with a single stale 401', async () => {
		const { source, historyCalls } = makeSource([statusError(401)]);
		const observation = createAgentConversationObservation(source, { live: 'sse' });
		observation.subscribe(() => {});
		await flush();

		expect(observation.getSnapshot().phase).toBe('connecting');
		await vi.advanceTimersByTimeAsync(1_100);
		await flush();

		expect(historyCalls()).toBe(2);
		expect(observation.getSnapshot().phase).toBe('live');
		observation.close();
	});

	it('rehydrates once when the updates stream is rejected with a single stale 401', async () => {
		const { source, streams, historyCalls, updatesCalls } = makeSource([], [statusError(401)]);
		const observation = createAgentConversationObservation(source, { live: 'sse' });
		observation.subscribe(() => {});
		await flush();
		await vi.advanceTimersByTimeAsync(1_100);
		await flush();

		expect(historyCalls()).toBe(2);
		expect(updatesCalls()).toBe(2);
		streams[1]?.push(delta(1));
		await flush();
		expect(observation.getSnapshot().phase).toBe('live');
		observation.close();
	});

	it('goes fatal when the updates stream keeps rejecting 401 after the rehydrate', async () => {
		const { source, historyCalls, updatesCalls } = makeSource(
			[],
			[statusError(401), statusError(401)],
		);
		const observation = createAgentConversationObservation(source, { live: 'sse' });
		observation.subscribe(() => {});
		await flush();
		await vi.advanceTimersByTimeAsync(1_100);
		await flush();

		expect(observation.getSnapshot().phase).toBe('error');
		expect(historyCalls()).toBe(2);
		expect(updatesCalls()).toBe(2);
		await vi.advanceTimersByTimeAsync(120_000);
		await flush();
		expect(historyCalls()).toBe(2);
		expect(updatesCalls()).toBe(2);
		observation.close();
	});

	it('goes fatal when the fresh-credential rehydrate is rejected with 401 again', async () => {
		const { source, historyCalls } = makeSource([statusError(401), statusError(401)]);
		const observation = createAgentConversationObservation(source, { live: 'sse' });
		observation.subscribe(() => {});
		await flush();
		await vi.advanceTimersByTimeAsync(1_100);
		await flush();

		expect(observation.getSnapshot().phase).toBe('error');
		expect(historyCalls()).toBe(2);
		await vi.advanceTimersByTimeAsync(120_000);
		await flush();
		expect(historyCalls()).toBe(2);
		observation.close();
	});

	it('rehydrates once more when the first request after refresh() hits a stale 401', async () => {
		const { source, historyCalls } = makeSource([
			statusError(401),
			statusError(401),
			statusError(401),
			'ok',
		]);
		const observation = createAgentConversationObservation(source, { live: 'sse' });
		observation.subscribe(() => {});
		await flush();
		await vi.advanceTimersByTimeAsync(1_100);
		await flush();
		expect(observation.getSnapshot().phase).toBe('error');

		observation.refresh();
		await flush();
		await vi.advanceTimersByTimeAsync(1_100);
		await flush();

		expect(historyCalls()).toBe(4);
		expect(observation.getSnapshot().phase).toBe('live');
		observation.close();
	});

	it('restarts hydration when refresh() is called after a fatal stop', async () => {
		const { source, historyCalls } = makeSource([statusError(401), statusError(401), 'ok']);
		const observation = createAgentConversationObservation(source, { live: 'sse' });
		observation.subscribe(() => {});
		await flush();
		await vi.advanceTimersByTimeAsync(1_100);
		await flush();
		expect(observation.getSnapshot().phase).toBe('error');

		observation.refresh();
		await flush();

		expect(historyCalls()).toBe(3);
		expect(observation.getSnapshot().phase).toBe('live');
		observation.close();
	});

	it('rehydrates again when a later 401 arrives after the stream has delivered', async () => {
		const { source, streams, historyCalls, updatesCalls } = makeSource([statusError(401)]);
		const observation = createAgentConversationObservation(source, { live: 'sse' });
		observation.subscribe(() => {});
		await flush();
		await vi.advanceTimersByTimeAsync(1_100);
		await flush();
		expect(observation.getSnapshot().phase).toBe('live');

		streams[0]?.push(delta(1));
		await flush();
		streams[0]?.fail(statusError(401));
		await flush();
		await vi.advanceTimersByTimeAsync(1_100);
		await flush();

		expect(historyCalls()).toBe(3);
		expect(updatesCalls()).toBe(2);
		streams[1]?.push(delta(2));
		await flush();
		expect(observation.getSnapshot().phase).toBe('live');
		observation.close();
	});

	it('goes fatal immediately when history is rejected with 403', async () => {
		const { source, historyCalls } = makeSource([statusError(403)]);
		const observation = createAgentConversationObservation(source, { live: 'sse' });
		observation.subscribe(() => {});
		await flush();

		expect(observation.getSnapshot().phase).toBe('error');
		await vi.advanceTimersByTimeAsync(120_000);
		await flush();
		expect(historyCalls()).toBe(1);
		observation.close();
	});
});

describe('client.agents.observe() credential re-resolution', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('carries a newly resolved authorization header when retrying a stale 401', async () => {
		const snapshot = {
			v: 1,
			conversationId: 'c1',
			offset: FOLLOW_OFFSET,
			messages: [],
			settlements: [],
		};
		let minted = 0;
		const historyAuth: Array<string | null> = [];
		let historyRequests = 0;
		const fetchImpl: typeof fetch = (input, init) => {
			const url = String(input);
			if (url.includes('view=history')) {
				historyRequests++;
				historyAuth.push(new Headers(init?.headers).get('authorization'));
				if (historyRequests === 1) {
					return Promise.resolve(new Response('unauthorized', { status: 401 }));
				}
				return Promise.resolve(
					new Response(JSON.stringify(snapshot), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					}),
				);
			}
			return new Promise<Response>(() => {});
		};
		const client = createFlueClient({
			baseUrl: 'https://flue.test/agent',
			fetch: fetchImpl,
			headers: async () => ({ authorization: `Bearer token-${++minted}` }),
		});

		const observation = client.agents.observe('assistant', 'i1', { live: 'sse' });
		observation.subscribe(() => {});
		await flush();
		await vi.advanceTimersByTimeAsync(1_100);
		await flush();

		expect(historyAuth).toEqual(['Bearer token-1', 'Bearer token-2']);
		expect(observation.getSnapshot().phase).toBe('live');
		observation.close();
	});
});

describe('createAgentConversationObservation() retry-chain resilience', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('keeps retrying when a subscribed listener throws on a retry publish', async () => {
		const { source, historyCalls } = makeSource([new Error('history transport failed')]);
		const observation = createAgentConversationObservation(source, { live: 'sse' });
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		let threw = false;
		observation.subscribe(() => {
			if (threw) return;
			const current = observation.getSnapshot();
			if (current.phase === 'connecting' && current.error) {
				threw = true;
				throw new Error('listener exploded');
			}
		});
		await flush();
		expect(threw).toBe(true);

		await vi.advanceTimersByTimeAsync(1_100);
		await flush();

		expect(historyCalls()).toBe(2);
		expect(observation.getSnapshot().phase).toBe('live');
		expect(consoleError).toHaveBeenCalled();
		consoleError.mockRestore();
		observation.close();
	});

	it('abandons a hung history read at the deadline and retries', async () => {
		let calls = 0;
		const source: AgentConversationObservationSource = {
			history: ({ signal }) => {
				calls++;
				if (calls === 1) {
					return new Promise((_, reject) => {
						signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
					});
				}
				return Promise.resolve({
					v: 1,
					conversationId: 'c1',
					offset: FOLLOW_OFFSET,
					messages: [],
					settlements: [],
				} as unknown as FlueConversationSnapshot);
			},
			updates: () => pushStream<ConversationStreamChunk>().stream,
		};
		const observation = createAgentConversationObservation(source, { live: 'sse' });
		observation.subscribe(() => {});
		await flush();
		expect(observation.getSnapshot().phase).toBe('loading');
		expect(calls).toBe(1);

		await vi.advanceTimersByTimeAsync(45_000);
		await flush();
		expect(observation.getSnapshot().phase).toBe('connecting');

		await vi.advanceTimersByTimeAsync(1_100);
		await flush();
		expect(calls).toBe(2);
		expect(observation.getSnapshot().phase).toBe('live');
		observation.close();
	});
});
