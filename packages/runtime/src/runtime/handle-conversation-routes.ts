import {
	type ConversationSyncChunk,
	projectAgentConversationBatch,
	projectAgentConversationSnapshot,
} from '../conversation-public.ts';
import {
	loadReducedConversationPrefix,
	loadReducedConversationState,
} from '../conversation-reader.ts';
import { applyConversationRecord } from '../conversation-reducer.ts';
import {
	AttachmentNotFoundError,
	InvalidRequestError,
	StreamNotFoundError,
	toHttpResponse,
} from '../errors.ts';
import type { AttachmentStore } from './attachment-store.ts';
import type {
	ConversationStreamReadResult,
	ConversationStreamStore,
} from './conversation-stream-store.ts';
import { parseOffset } from './event-stream-store.ts';

const SECURITY_HEADERS = {
	'X-Content-Type-Options': 'nosniff',
	'Cross-Origin-Resource-Policy': 'cross-origin',
};
const LONG_POLL_TIMEOUT_MS = 30_000;
const DURABLE_POLL_INTERVAL_MS = 250;
const SSE_HEARTBEAT_MS = 15_000;

export async function handleAgentConversationRead(options: {
	store: ConversationStreamStore;
	path: string;
	request: Request;
}): Promise<Response> {
	const url = new URL(options.request.url);
	const view = url.searchParams.get('view') ?? 'history';
	if (view === 'history') return historyResponse(options);
	if (view === 'updates') return updatesResponse(options);
	return errorResponse(
		new InvalidRequestError({ reason: 'Invalid agent conversation view. Use history or updates.' }),
	);
}

/**
 * Serves the bytes of one attachment referenced by the default conversation.
 *
 * Resolves the agent instance's default conversation id and scopes the lookup to
 * it, so attachments belonging to task/action child conversations are never
 * served through the public route. The byte content is immutable (digest-keyed),
 * hence the long-lived private cache. Reached only after the route's opt-in
 * `attachments` middleware has run.
 */
export async function handleAgentAttachmentRead(options: {
	conversationStore: ConversationStreamStore;
	attachmentStore: AttachmentStore;
	path: string;
	attachmentId: string;
}): Promise<Response> {
	const meta = await options.conversationStore.getMeta(options.path);
	if (!meta) return errorResponse(new StreamNotFoundError({ path: options.path }));
	// Resolving the default conversation id requires the reduced state. This is
	// the same work as a history read; acceptable for now, but a future
	// attachmentId→conversationId index would avoid the full reduce per byte read.
	const state = await loadReducedConversationState({
		store: options.conversationStore,
		path: options.path,
	});
	const snapshot = projectAgentConversationSnapshot(state);
	if (!snapshot) return errorResponse(new StreamNotFoundError({ path: options.path }));
	const stored = await options.attachmentStore.get({
		streamPath: options.path,
		conversationId: snapshot.conversationId,
		attachmentId: options.attachmentId,
	});
	if (!stored) return errorResponse(new AttachmentNotFoundError({ attachmentId: options.attachmentId }));
	return new Response(stored.bytes, {
		headers: {
			'content-type': stored.attachment.mimeType,
			'content-length': String(stored.attachment.size),
			'content-disposition': 'inline',
			'cache-control': 'private, max-age=31536000, immutable',
			// The mime type is uploader-controlled, so a malicious "image" could be
			// served as text/html. `sandbox` neutralizes script/HTML execution on
			// direct navigation (treating it as an opaque origin) without affecting
			// <img>/<a> sub-resource loads.
			'content-security-policy': 'sandbox',
			...SECURITY_HEADERS,
		},
	});
}

export async function handleAgentConversationHead(
	store: ConversationStreamStore,
	path: string,
): Promise<Response> {
	const meta = await store.getMeta(path);
	if (!meta) return headError(new StreamNotFoundError({ path }));
	return new Response(null, {
		headers: {
			'content-type': 'application/json',
			'cache-control': 'no-store',
			'Stream-Next-Offset': meta.nextOffset,
			'Stream-Up-To-Date': 'true',
			...SECURITY_HEADERS,
		},
	});
}

/**
 * Default and ceiling for one history window, in active-path entries
 * (RUN-5220). Bounds the projection and response of an arbitrarily long
 * session; older pages ride the `beforeEntry` cursor the response's
 * `truncatedBefore` hands out.
 */
const DEFAULT_HISTORY_ENTRY_LIMIT = 1000;
const MAX_HISTORY_ENTRY_LIMIT = 10_000;

async function historyResponse(options: {
	store: ConversationStreamStore;
	path: string;
	request: Request;
}): Promise<Response> {
	const url = new URL(options.request.url);
	if (url.searchParams.has('offset') || url.searchParams.has('tail') || url.searchParams.has('live')) {
		return errorResponse(
			new InvalidRequestError({ reason: 'History reads do not accept offset, tail, or live parameters.' }),
		);
	}
	const rawLimit = url.searchParams.get('entryLimit');
	let entryLimit = DEFAULT_HISTORY_ENTRY_LIMIT;
	if (rawLimit !== null) {
		const parsed = Number(rawLimit);
		if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_HISTORY_ENTRY_LIMIT) {
			return errorResponse(
				new InvalidRequestError({
					reason: `entryLimit must be an integer between 1 and ${MAX_HISTORY_ENTRY_LIMIT}.`,
				}),
			);
		}
		entryLimit = parsed;
	}
	const beforeEntry = url.searchParams.get('beforeEntry') ?? undefined;
	const meta = await options.store.getMeta(options.path);
	if (!meta) return errorResponse(new StreamNotFoundError({ path: options.path }));
	const state = await loadReducedConversationState({
		store: options.store,
		path: options.path,
	});
	const snapshot = projectAgentConversationSnapshot(state, {
		entryLimit,
		...(beforeEntry !== undefined ? { beforeEntry } : {}),
	});
	if (!snapshot) return errorResponse(new StreamNotFoundError({ path: options.path }));
	return Response.json(snapshot, {
		headers: {
			'cache-control': 'no-store',
			'Stream-Next-Offset': snapshot.offset,
			'Stream-Up-To-Date': 'true',
			...SECURITY_HEADERS,
		},
	});
}

async function updatesResponse(options: {
	store: ConversationStreamStore;
	path: string;
	request: Request;
}): Promise<Response> {
	const url = new URL(options.request.url);
	if (url.searchParams.has('tail')) {
		return errorResponse(new InvalidRequestError({ reason: 'Update streams do not accept tail.' }));
	}
	const offset = singleOffset(url);
	if (offset instanceof Response) return offset;
	const live = liveMode(url);
	if (live instanceof Response) return live;
	const meta = await options.store.getMeta(options.path);
	if (!meta) return errorResponse(new StreamNotFoundError({ path: options.path }));
	if (live === 'sse') {
		const sync = url.searchParams.get('sync') === '1';
		return sseResponse(options.store, options.path, offset, options.request.signal, sync);
	}
	let state = await loadReducedConversationPrefix({
		store: options.store,
		path: options.path,
		offset,
	});
	let read = await options.store.read(options.path, { offset });
	if (live === 'long-poll' && read.batches.length === 0) {
		const waited = await waitForData(options.store, options.path, offset, options.request.signal);
		if (waited === 'aborted') return new Response(null, { status: 499, headers: SECURITY_HEADERS });
		read = waited;
	}
	const projected = projectRead(state, read);
	state = projected.state;
	return dsJsonResponse(projected.items, read, projected.offset);
}

function projectRead(
	initialState: Awaited<ReturnType<typeof loadReducedConversationPrefix>>,
	read: ConversationStreamReadResult,
) {
	let state = initialState;
	const items: unknown[] = [];
	let offset = initialState.recordsThroughOffset;
	for (const batch of read.batches) {
		// The prefix state is private to this request, so records apply in
		// place — the previous defensive clone per batch was O(entries) map
		// churn on every projected page (RUN-5220). The projection's
		// previousState is only a root-selection fallback; the post-batch state
		// serves both roles (a batch that lacks a root after application lacked
		// one before it too).
		for (const record of batch.records) applyConversationRecord(state, record, batch.offset);
		state.recordsThroughOffset = batch.offset;
		items.push(
			...projectAgentConversationBatch({
				state,
				previousState: state,
				records: batch.records,
				batchOrdinal: parseOffset(batch.offset),
			}),
		);
		offset = batch.offset;
	}
	return { state, items, offset };
}

function dsJsonResponse(
	items: unknown[],
	read: ConversationStreamReadResult,
	offset: string,
): Response {
	return Response.json(items, {
		headers: {
			'cache-control': 'no-store',
			'Stream-Next-Offset': offset,
			...(read.upToDate ? { 'Stream-Up-To-Date': 'true' } : {}),
			...SECURITY_HEADERS,
		},
	});
}

function sseResponse(
	store: ConversationStreamStore,
	path: string,
	offset: string,
	signal: AbortSignal,
	sync: boolean,
): Response {
	const encoder = new TextEncoder();
	let active = true;
	let unsubscribe = () => {};
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			let state = await loadReducedConversationPrefix({ store, path, offset });
			let currentOffset = offset;
			let wake: (() => void) | undefined;
			const connectionId = crypto.randomUUID();
			let sentChunks = 0;
			const enqueueSyncFrame = () => {
				const frame: ConversationSyncChunk = {
					type: 'sync',
					connectionId,
					sentChunks,
					sinceOffset: offset,
				};
				controller.enqueue(encoder.encode(`event: data\ndata:${JSON.stringify([frame])}\n\n`));
				controller.enqueue(
					encoder.encode(
						`event: control\ndata:${JSON.stringify({ streamNextOffset: currentOffset })}\n\n`,
					),
				);
			};
			unsubscribe = store.subscribe(path, () => wake?.());
			// Connection identity must precede any offset-advancing frame, or a
			// pre-first-sync reconnect could swallow a loss undetectably.
			if (sync) enqueueSyncFrame();
			heartbeat = setInterval(() => {
				if (!active) return;
				if (!sync) {
					controller.enqueue(encoder.encode(': heartbeat\n\n'));
					return;
				}
				enqueueSyncFrame();
			}, SSE_HEARTBEAT_MS);
			const onAbort = () => {
				active = false;
				wake?.();
			};
			signal.addEventListener('abort', onAbort, { once: true });
			try {
				while (active) {
					const read = await store.read(path, { offset: currentOffset });
					const projected = projectRead(state, read);
					state = projected.state;
					if (projected.items.length > 0) {
						controller.enqueue(
							encoder.encode(`event: data\ndata:${JSON.stringify(projected.items)}\n\n`),
						);
						sentChunks += projected.items.length;
					}
					currentOffset = read.nextOffset;
					const control = {
						streamNextOffset: currentOffset,
						...(read.upToDate ? { upToDate: true } : {}),
					};
					controller.enqueue(encoder.encode(`event: control\ndata:${JSON.stringify(control)}\n\n`));
					if (!read.upToDate) continue;
					await new Promise<void>((resolve) => {
						wake = resolve;
						setTimeout(resolve, LONG_POLL_TIMEOUT_MS);
					});
					wake = undefined;
				}
			} finally {
				active = false;
				unsubscribe();
				if (heartbeat) clearInterval(heartbeat);
				signal.removeEventListener('abort', onAbort);
				controller.close();
			}
		},
		cancel() {
			active = false;
			unsubscribe();
			if (heartbeat) clearInterval(heartbeat);
		},
	});
	return new Response(body, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			...SECURITY_HEADERS,
		},
	});
}

function singleOffset(url: URL): string | Response {
	const offsets = url.searchParams.getAll('offset');
	if (offsets.length !== 1) {
		return errorResponse(new InvalidRequestError({ reason: 'Exactly one offset is required.' }));
	}
	const offset = offsets[0] as string;
	if (offset !== '-1' && !/^\d+_\d+$/.test(offset)) {
		return errorResponse(new InvalidRequestError({ reason: 'Invalid offset format.' }));
	}
	return offset;
}

function liveMode(url: URL): 'long-poll' | 'sse' | null | Response {
	const live = url.searchParams.get('live');
	if (live === null) return null;
	if (live === 'long-poll' || live === 'sse') return live;
	return errorResponse(
		new InvalidRequestError({ reason: 'Invalid live mode. Use long-poll or sse.' }),
	);
}

async function waitForData(
	store: ConversationStreamStore,
	path: string,
	offset: string,
	signal: AbortSignal,
): Promise<ConversationStreamReadResult | 'aborted'> {
	if (signal.aborted) return 'aborted';
	const deadline = Date.now() + LONG_POLL_TIMEOUT_MS;
	let pending = false;
	let wake: (() => void) | undefined;
	const unsubscribe = store.subscribe(path, () => {
		pending = true;
		wake?.();
	});
	const onAbort = () => wake?.();
	signal.addEventListener('abort', onAbort, { once: true });
	try {
		while (true) {
			pending = false;
			const read = await store.read(path, { offset });
			if (signal.aborted) return 'aborted';
			if (read.batches.length > 0 || Date.now() >= deadline) return read;
			if (pending) continue;
			await new Promise<void>((resolve) => {
				let timer: ReturnType<typeof setTimeout>;
				const finish = () => {
					clearTimeout(timer);
					resolve();
				};
				wake = finish;
				timer = setTimeout(finish, Math.min(DURABLE_POLL_INTERVAL_MS, deadline - Date.now()));
				if (pending || signal.aborted) finish();
			});
			wake = undefined;
		}
	} finally {
		unsubscribe();
		signal.removeEventListener('abort', onAbort);
	}
}

function errorResponse(
	error: InvalidRequestError | StreamNotFoundError | AttachmentNotFoundError,
): Response {
	return toHttpResponse(error);
}

function headError(error: StreamNotFoundError): Response {
	const response = toHttpResponse(error);
	return new Response(null, { status: response.status, headers: response.headers });
}
