import {
	applyConversationRecord,
	createReducedInstanceState,
	type ReducedInstanceState,
} from './conversation-reducer.ts';
import { decodeReducedState, SNAPSHOT_VERSION } from './conversation-snapshot.ts';
import type { ConversationStreamStore } from './runtime/conversation-stream-store.ts';

/**
 * Replay page size, in batches. Small on purpose (RUN-5210): each page is
 * fully parsed into memory before it is reduced, so the replay's transient
 * peak is O(page bytes) + O(retained state) — a 1000-batch default page
 * materializes an entire long session's log at once and was itself enough to
 * exceed a Durable Object's heap before a single record reduced.
 */
const REPLAY_READ_LIMIT = 32;

export async function loadReducedConversationState(options: {
	store: ConversationStreamStore;
	path: string;
}): Promise<ReducedInstanceState> {
	// Checkpoint-accelerated load (RUN-5218): start from the store's derived
	// snapshot when one is valid, replaying only the tail. The snapshot is a
	// cache, never truth — any failure on the snapshot path (stale incarnation,
	// version mismatch, decode error, tail-read error) falls back to a full
	// replay from genesis, so a checkpoint can never break loading. A genuinely
	// corrupt log still throws from the clean full-replay path.
	const snapshot = await options.store.loadDerivedSnapshot?.(options.path)?.catch(() => null);
	if (snapshot && snapshot.version === SNAPSHOT_VERSION) {
		try {
			const meta = await options.store.getMeta(options.path);
			if (meta && meta.incarnation === snapshot.incarnation) {
				const state = decodeReducedState(snapshot.data);
				state.recordsThroughOffset = snapshot.offset;
				return await replayInto(state, snapshot.offset, options);
			}
		} catch {
			// fall through to the full replay
		}
	}
	return replayInto(createReducedInstanceState(), '-1', options);
}

// The state is private until returned, so records apply in place instead of
// going through `reduceConversationRecords`'s defensive clone — the
// clone-per-batch was O(entries × batches) map churn across a replay
// (RUN-5210). Failure semantics are unchanged: a bad record throws and the
// whole load fails.
async function replayInto(
	state: ReducedInstanceState,
	fromOffset: string,
	options: { store: ConversationStreamStore; path: string },
): Promise<ReducedInstanceState> {
	let offset = fromOffset;
	while (true) {
		const read = await options.store.read(options.path, { offset, limit: REPLAY_READ_LIMIT });
		for (const batch of read.batches) {
			for (const record of batch.records) applyConversationRecord(state, record, batch.offset);
			state.recordsThroughOffset = batch.offset;
			offset = batch.offset;
		}
		if (read.upToDate) return state;
	}
}

export async function loadReducedConversationPrefix(options: {
	store: ConversationStreamStore;
	path: string;
	offset: string;
}): Promise<ReducedInstanceState> {
	const state = createReducedInstanceState();
	if (options.offset === '-1') return state;
	let offset = '-1';
	while (true) {
		const read = await options.store.read(options.path, { offset, limit: REPLAY_READ_LIMIT });
		for (const batch of read.batches) {
			for (const record of batch.records) applyConversationRecord(state, record, batch.offset);
			state.recordsThroughOffset = batch.offset;
			offset = batch.offset;
			if (offset === options.offset) return state;
		}
		if (read.upToDate) {
			await options.store.read(options.path, { offset: options.offset, limit: 1 });
			throw new Error('[flue] Canonical conversation offset is not a batch boundary.');
		}
	}
}
