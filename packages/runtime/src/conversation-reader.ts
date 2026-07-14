import {
	createReducedInstanceState,
	type ReducedInstanceState,
	reduceConversationRecordsInPlace,
	reductionDiagnostics,
} from './conversation-reducer.ts';
import type { ConversationStreamStore } from './runtime/conversation-stream-store.ts';

export async function loadReducedConversationState(options: {
	store: ConversationStreamStore;
	path: string;
}): Promise<ReducedInstanceState> {
	// The state is built here and never escapes until it is returned, so the
	// caller owns it outright and each batch can reduce into it in place.
	const state = createReducedInstanceState();
	let offset = '-1';
	while (true) {
		const read = await options.store.read(options.path, { offset, limit: 1000 });
		for (const batch of read.batches) {
			reduceConversationRecordsInPlace(state, batch.records, batch.offset);
			offset = batch.offset;
		}
		if (read.upToDate) return state;
	}
}

/**
 * State a page of `?view=updates` left behind, waiting for the next page to take.
 *
 * The chat Durable Object's supervision alarm pages forward every few seconds.
 * Without this, every page rebuilt the reduced state from the start of the log —
 * a multi-megabyte restore and a full replay, per page — which OOMed a large
 * session's 128MB isolate on each alarm. Those sessions then died before
 * supervision could settle or park the run, so the alarm never cleared.
 */
const PREFIX_STATE_CACHE = Symbol.for('flue.reducedPrefixStateCache');

interface PrefixCacheEntry {
	offset: string;
	/**
	 * Stream incarnation this state was built from. A stream that is deleted and
	 * recreated restarts its offsets, so without this key a fresh stream could be
	 * served the previous one's state at a colliding offset.
	 */
	incarnation: string;
	state: ReducedInstanceState;
}

type PrefixCacheHost = ConversationStreamStore & {
	[PREFIX_STATE_CACHE]?: Map<string, PrefixCacheEntry>;
};

function prefixStateCache(store: ConversationStreamStore): Map<string, PrefixCacheEntry> {
	const host = store as PrefixCacheHost;
	const cache = host[PREFIX_STATE_CACHE] ?? new Map<string, PrefixCacheEntry>();
	host[PREFIX_STATE_CACHE] = cache;
	return cache;
}

/**
 * Remove and return the cached state at exactly `offset`.
 *
 * This *takes* rather than shares: the caller becomes its sole owner and may
 * reduce into it in place. Leaving a copy behind would hand two readers the same
 * mutable state.
 */
export function takePrefixState(
	store: ConversationStreamStore,
	path: string,
	offset: string,
	incarnation: string,
): ReducedInstanceState | null {
	const cache = prefixStateCache(store);
	const entry = cache.get(path);
	if (!entry || entry.offset !== offset || entry.incarnation !== incarnation) return null;
	cache.delete(path);
	reductionDiagnostics.prefixCacheHits += 1;
	return entry.state;
}

/** Publish an exclusively-owned state for the next page to take. */
export function putPrefixState(
	store: ConversationStreamStore,
	path: string,
	offset: string,
	incarnation: string,
	state: ReducedInstanceState,
): void {
	prefixStateCache(store).set(path, { offset, incarnation, state });
}

export function clearReducedStateCache(store: ConversationStreamStore): void {
	(store as PrefixCacheHost)[PREFIX_STATE_CACHE]?.clear();
}

/**
 * Build the reduced state for the prefix of the log up to `offset`.
 *
 * The returned state is owned outright by the caller — either taken from the
 * cache (and removed from it) or built fresh — so the caller may reduce into it
 * in place.
 */
export async function loadReducedConversationPrefix(options: {
	store: ConversationStreamStore;
	path: string;
	offset: string;
	incarnation?: string;
}): Promise<ReducedInstanceState> {
	if (options.offset === '-1') return createReducedInstanceState();

	if (options.incarnation !== undefined) {
		const cached = takePrefixState(options.store, options.path, options.offset, options.incarnation);
		if (cached) return cached;
	}

	const state = createReducedInstanceState();
	let offset = '-1';
	while (true) {
		const read = await options.store.read(options.path, { offset, limit: 1000 });
		for (const batch of read.batches) {
			reduceConversationRecordsInPlace(state, batch.records, batch.offset);
			offset = batch.offset;
			if (offset === options.offset) return state;
		}
		if (read.upToDate) {
			await options.store.read(options.path, { offset: options.offset, limit: 1 });
			throw new Error('[flue] Canonical conversation offset is not a batch boundary.');
		}
	}
}
