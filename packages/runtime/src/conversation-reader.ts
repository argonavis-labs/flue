import {
	cloneReducedInstanceState,
	createReducedInstanceState,
	type ReducedInstanceState,
	reduceConversationRecordsInPlace,
	reductionDiagnostics,
} from './conversation-reducer.ts';
import type { ConversationStreamStore } from './runtime/conversation-stream-store.ts';

/**
 * Reduced state for the whole log, shared per store+path.
 *
 * Every full-state load rebuilt the state from record zero, deep-cloning the
 * accumulated state once per batch. The record writer takes this load on every
 * cold start, so a long conversation paid a full quadratic replay to append one
 * message.
 */
const REDUCED_STATE_CACHE = Symbol.for('flue.reducedStateCache');

interface FullCacheEntry {
	incarnation: string;
	state: ReducedInstanceState;
}

type FullCacheHost = ConversationStreamStore & {
	[REDUCED_STATE_CACHE]?: Map<string, FullCacheEntry>;
};

function fullStateCache(store: ConversationStreamStore): Map<string, FullCacheEntry> {
	const host = store as FullCacheHost;
	const cache = host[REDUCED_STATE_CACHE] ?? new Map<string, FullCacheEntry>();
	host[REDUCED_STATE_CACHE] = cache;
	return cache;
}

/**
 * Build the reduced state for the whole log, reusing the cached state and
 * replaying only what has been appended since.
 *
 * The returned state is SHARED — callers must treat it as immutable and fork it
 * (via {@link cloneReducedInstanceState}) before mutating. A warm load that finds
 * no new records hands back the very same object; one that finds new records
 * forks once, so a state handed to an earlier caller is never mutated underneath
 * it.
 */
export async function loadReducedConversationState(options: {
	store: ConversationStreamStore;
	path: string;
}): Promise<ReducedInstanceState> {
	const meta = await options.store.getMeta(options.path);
	const incarnation = meta?.incarnation;
	const cache = fullStateCache(options.store);
	// A stream deleted and recreated restarts its offsets, so a cache entry from
	// the previous incarnation must not be advanced — rebuild from scratch.
	const cached = incarnation === undefined ? undefined : cache.get(options.path);
	const warm = cached?.incarnation === incarnation ? cached?.state : undefined;

	let state = warm ?? createReducedInstanceState();
	// The cached state is shared with whoever loaded it before us; a fresh one is
	// ours alone. Fork lazily, so a load with nothing new to apply costs nothing.
	let owned = warm === undefined;
	let offset = state.recordsThroughOffset;

	while (true) {
		const read = await options.store.read(options.path, { offset, limit: 1000 });
		for (const batch of read.batches) {
			if (!owned) {
				state = cloneReducedInstanceState(state);
				owned = true;
			}
			reduceConversationRecordsInPlace(state, batch.records, batch.offset);
			offset = batch.offset;
		}
		if (read.upToDate) break;
	}

	if (incarnation !== undefined && (owned || warm === undefined)) {
		cache.set(options.path, { incarnation, state });
	}
	return state;
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
	(store as FullCacheHost)[REDUCED_STATE_CACHE]?.clear();
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
