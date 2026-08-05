import {
	classifySignal,
	type ConversationUiMessage,
	type ConversationUiSnapshot,
	type ConversationUiWindow,
	projectConversationUi,
} from './conversation-projections.ts';
import type {
	ConversationRecord,
	SubmissionSettledRecord,
} from './conversation-records.ts';
import { type ReducedInstanceState, toolResultEntryId } from './conversation-reducer.ts';
import { toolResultOutput, toolResultText } from './message-rendering.ts';
import type { PromptUsage } from './types.ts';

interface AgentConversationSettlement {
	submissionId: string;
	outcome: 'completed' | 'failed' | 'aborted';
	error?: unknown;
}

/**
 * A materialized conversation read at a durable-stream offset. Wire-compatible
 * with @flue/sdk's `FlueConversationSnapshot`.
 */
export interface AgentConversationSnapshot {
	v: 1;
	conversationId: string;
	offset: string;
	messages: ConversationUiMessage[];
	settlements: AgentConversationSettlement[];
	/** Present when older history exists before this window (RUN-5220). */
	truncatedBefore?: string;
}

/**
 * Incremental UI projection protocol carried by the `updates` view.
 * Wire-compatible with @flue/sdk's internal `ConversationStreamChunk`. The
 * canonical record schema is never exposed; these chunks describe only
 * UI-relevant conversation operations.
 */
type ConversationStreamChunkBody =
	| { type: 'conversation-reset'; conversationId: string; snapshot: AgentConversationSnapshot }
	| { type: 'message-appended'; conversationId: string; message: ConversationUiMessage }
	| {
			type: 'message-started';
			conversationId: string;
			messageId: string;
			submissionId?: string;
			/** Turn this assistant message belongs to; the SDK stamps it onto the
			 *  synthesized message so live grouping matches the snapshot projection. */
			turnId?: string;
			/** Server-authored generation-start time as an ISO 8601 string. */
			timestamp?: string;
			model?: { provider: string; id: string };
	  }
	| {
			type: 'message-delta';
			conversationId: string;
			messageId: string;
			kind: 'text' | 'reasoning';
			delta: string;
	  }
	| {
			type: 'tool-input';
			conversationId: string;
			messageId: string;
			toolCallId: string;
			toolName: string;
			input: unknown;
	  }
	| { type: 'tool-output'; conversationId: string; toolCallId: string; output: unknown; durationMs?: number }
	| { type: 'tool-output-error'; conversationId: string; toolCallId: string; errorText: string; durationMs?: number }
	| { type: 'message-completed'; conversationId: string; messageId: string; usage?: PromptUsage }
	| {
			type: 'submission-settled';
			conversationId: string;
			submissionId: string;
			outcome: 'completed' | 'failed' | 'aborted';
			error?: unknown;
	  };

/**
 * Monotonic ordering token stamped on every chunk. `batch` is the durable batch
 * ordinal the chunk was projected from; `index` is the chunk's position within
 * that batch's projection. Consumers compare it (lexicographically by `batch`
 * then `index`) to dedupe chunks redelivered under at-least-once transports
 * (e.g. an SSE reconnect). Opaque otherwise — do not interpret the numbers.
 */
type ConversationChunkPosition = { batch: number; index: number };

export type ConversationStreamChunk =
	| (ConversationStreamChunkBody & { position: ConversationChunkPosition })
	| ConversationSyncChunk;

/** SSE-heartbeat continuity frame (`sync=1` only): per-connection nonce + count
 *  of chunks sent on that connection. The count proves the whole prefix — a max
 *  position misses interior loss. Not projected, so no `position`. */
export type ConversationSyncChunk = {
	type: 'sync';
	connectionId: string;
	sentChunks: number;
	/** Offset this connection started serving from; lets a consumer detect a
	 *  replacement connection that resumed past its proven prefix. */
	sinceOffset: string;
};

// The public conversation API addresses exactly one conversation per agent
// instance: the default harness/session root. An instance can hold other root
// conversations too (every additional public `harness.session(name)` opens one),
// so the default must be selected by its stable identity rather than by record
// order. Fall back to any root only when no default scope exists, preserving the
// prior behavior for instances that never used the default session.
const DEFAULT_HARNESS = 'default';
const DEFAULT_SESSION = 'default';

function selectRootConversation(state: ReducedInstanceState) {
	const roots = [...state.conversations.values()].filter(
		(conversation) => conversation.kind === 'root',
	);
	return (
		roots.find(
			(conversation) =>
				conversation.harness === DEFAULT_HARNESS && conversation.session === DEFAULT_SESSION,
		) ?? roots[0]
	);
}

export function projectAgentConversationSnapshot(
	state: ReducedInstanceState,
	window: ConversationUiWindow = {},
): AgentConversationSnapshot | undefined {
	const conversation = selectRootConversation(state);
	if (!conversation) return undefined;
	const ui: ConversationUiSnapshot = projectConversationUi(
		conversation,
		state.recordsThroughOffset,
		window,
	);
	return {
		v: 1,
		conversationId: conversation.conversationId,
		offset: ui.streamOffset,
		messages: ui.messages,
		settlements: projectSettlements(state, conversation.conversationId),
		...(ui.truncatedBefore !== undefined ? { truncatedBefore: ui.truncatedBefore } : {}),
	};
}

export function projectAgentConversationBatch(options: {
	state: ReducedInstanceState;
	previousState?: ReducedInstanceState;
	records: readonly ConversationRecord[];
	/** Durable batch ordinal these records were read at; stamped onto each chunk. */
	batchOrdinal: number;
}): ConversationStreamChunk[] {
	const conversation =
		selectRootConversation(options.state) ??
		(options.previousState ? selectRootConversation(options.previousState) : undefined);
	if (!conversation) return [];
	const conversationId = conversation.conversationId;
	const relevant = options.records.filter((record) => record.conversationId === conversationId);
	if (relevant.length === 0) return [];

	// A reset subsumes the whole batch: a fresh snapshot already reflects every
	// record in it, so emitting per-record chunks too would double-apply.
	if (relevant.some(requiresSnapshotReset)) {
		const snapshot = projectAgentConversationSnapshot(options.state);
		return snapshot
			? withPositions([{ type: 'conversation-reset', conversationId, snapshot }], options.batchOrdinal)
			: [];
	}

	return withPositions(
		relevant.flatMap((record) => encodeRecord(record, conversationId, options.state, relevant)),
		options.batchOrdinal,
	);
}

/**
 * Stamp each chunk with its position within the batch. Index is the chunk's
 * order in the batch's projection (a single record may fan out to several
 * chunks), so `{ batch, index }` is globally unique and monotonic across the
 * conversation. This is the identity consumers dedupe on under redelivery.
 */
function withPositions(
	bodies: ConversationStreamChunkBody[],
	batch: number,
): ConversationStreamChunk[] {
	return bodies.map((body, index) => ({ ...body, position: { batch, index } }));
}

function requiresSnapshotReset(record: ConversationRecord): boolean {
	return record.type === 'conversation_created' || record.type === 'compaction';
}

function encodeRecord(
	record: ConversationRecord,
	conversationId: string,
	state: ReducedInstanceState,
	batchRecords: readonly ConversationRecord[],
): ConversationStreamChunkBody[] {
	switch (record.type) {
		case 'user_message':
			return [
				{
					type: 'message-appended',
					conversationId,
					message: {
						id: record.messageId,
						role: 'user',
						purpose: 'user',
						display: 'visible',
						...(record.submissionId ? { submissionId: record.submissionId } : {}),
						...(record.turnId ? { turnId: record.turnId } : {}),
						metadata: { timestamp: record.timestamp },
						parts: record.content.map((content) =>
							content.type === 'text'
								? { type: 'text', text: content.text, state: 'done' }
								: {
										type: 'file',
										mediaType: content.attachment.mimeType,
										id: content.attachment.id,
										size: content.attachment.size,
										...(content.attachment.filename
											? { filename: content.attachment.filename }
											: {}),
									},
						),
					},
				},
			];
		case 'signal': {
			const { purpose, display } = classifySignal(record.signalType);
			const signal = {
				...(record.tagName ? { tagName: record.tagName } : {}),
				...(record.attributes ? { attributes: record.attributes } : {}),
			};
			return [
				{
					type: 'message-appended',
					conversationId,
					message: {
						id: record.messageId,
						role: 'system',
						purpose,
						display,
						...(record.submissionId ? { submissionId: record.submissionId } : {}),
						...(record.turnId ? { turnId: record.turnId } : {}),
						...(Object.keys(signal).length > 0 ? { signal } : {}),
						metadata: { timestamp: record.timestamp },
						parts: [{ type: 'text', text: record.content, state: 'done' }],
					},
				},
			];
		}
		case 'assistant_message_started':
			return [
				{
					type: 'message-started',
					conversationId,
					messageId: record.messageId,
					timestamp: record.timestamp,
					...(record.submissionId ? { submissionId: record.submissionId } : {}),
					...(record.turnId ? { turnId: record.turnId } : {}),
					...(typeof record.modelInfo.provider === 'string' && typeof record.modelInfo.model === 'string'
						? { model: { provider: record.modelInfo.provider, id: record.modelInfo.model } }
						: {}),
				},
			];
		case 'assistant_text_delta':
			return [{ type: 'message-delta', conversationId, messageId: record.messageId, kind: 'text', delta: record.delta }];
		case 'assistant_reasoning_delta':
			return [{ type: 'message-delta', conversationId, messageId: record.messageId, kind: 'reasoning', delta: record.delta }];
		// Block lifecycle (`assistant_text_started`/`assistant_*_completed`) carries no
		// UI-visible payload: the first delta opens a streaming part, a `kind` change or
		// `message-completed` closes it. So those records project to no chunk.
		case 'assistant_tool_call':
			return [{ type: 'tool-input', conversationId, messageId: record.messageId, toolCallId: record.toolCallId, toolName: record.name, input: record.arguments }];
		case 'assistant_message_completed':
			return [
				{
					type: 'message-completed',
					conversationId,
					messageId: record.messageId,
					...(record.usage ? { usage: record.usage as PromptUsage } : {}),
				},
			];
		case 'tool_results_committed':
			return record.outcomeIds.flatMap((outcomeId, index) =>
				encodeToolOutcome(outcomeId, index, conversationId, record, state, batchRecords),
			);
		case 'submission_settled':
			if (!record.submissionId) {
				console.error(
					'[flue:conversation-projection] suppressed a submission_settled record with no submissionId; settlement consumers will not observe this outcome',
					{ conversationId, recordId: record.id },
				);
				return [];
			}
			return [
				{
					type: 'submission-settled',
					conversationId,
					submissionId: record.submissionId,
					outcome: record.outcome,
					...(record.error === undefined ? {} : { error: record.error }),
				},
			];
		default:
			return [];
	}
}

/**
 * Projects the tool-output chunks for one committed outcome. The outcome
 * record body is no longer resident in the reduced state (RUN-5210), so it is
 * resolved from the batch being projected — outcomes and their commit are
 * written together — and, for a cross-batch commit, from the materialized
 * tool-result entry. An entry whose content was evicted by compaction projects
 * its placeholder text, matching what every other post-compaction projection
 * of that history renders.
 */
function encodeToolOutcome(
	outcomeId: string,
	outcomeIndex: number,
	conversationId: string,
	commit: Extract<ConversationRecord, { type: 'tool_results_committed' }>,
	state: ReducedInstanceState,
	batchRecords: readonly ConversationRecord[],
): ConversationStreamChunkBody[] {
	const outcome = batchRecords.find(
		(record): record is Extract<ConversationRecord, { type: 'tool_outcome' }> =>
			record.id === outcomeId && record.type === 'tool_outcome',
	);
	if (outcome) {
		if (
			outcome.conversationId !== commit.conversationId ||
			outcome.harness !== commit.harness ||
			outcome.session !== commit.session
		) {
			return [];
		}
		return outcome.isError
			? [{ type: 'tool-output-error', conversationId, toolCallId: outcome.toolCallId, errorText: toolResultText(outcome.content), ...(outcome.durationMs !== undefined ? { durationMs: outcome.durationMs } : {}) }]
			: [
					{
						type: 'tool-output',
						conversationId,
						toolCallId: outcome.toolCallId,
						output: outcome.output !== undefined ? outcome.output : toolResultOutput(outcome.content),
						...(outcome.durationMs !== undefined ? { durationMs: outcome.durationMs } : {}),
					},
				];
	}
	// Cross-batch commit: recover the projection from the materialized entry.
	// `outcomeIds` are in assistant tool-call order (validated at reduction), so
	// the call at the same index names the tool-result entry.
	const conversation = state.conversations.get(commit.conversationId);
	const assistant = conversation?.entries.get(commit.assistantMessageId);
	if (assistant?.type !== 'message') return [];
	const assistantContent = (assistant.message as { content?: unknown }).content;
	const calls = (Array.isArray(assistantContent) ? assistantContent : []).filter(
		(block): block is { type: 'toolCall'; id: string } =>
			typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'toolCall',
	);
	const call = calls[outcomeIndex];
	if (!call) return [];
	const entry = conversation?.entries.get(toolResultEntryId(commit.assistantMessageId, call.id));
	if (entry?.type !== 'message') return [];
	const result = entry.message as {
		isError?: boolean;
		content?: unknown;
	};
	const text = Array.isArray(result.content)
		? result.content
				.map((block) => (typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
				.filter((piece) => piece !== '')
				.join('\n')
		: '';
	return result.isError
		? [{ type: 'tool-output-error', conversationId, toolCallId: call.id, errorText: text, ...(entry.toolDurationMs !== undefined ? { durationMs: entry.toolDurationMs } : {}) }]
		: [
				{
					type: 'tool-output',
					conversationId,
					toolCallId: call.id,
					output: entry.toolOutput !== undefined ? entry.toolOutput.value : text,
					...(entry.toolDurationMs !== undefined ? { durationMs: entry.toolDurationMs } : {}),
				},
			];
}

function projectSettlements(
	state: ReducedInstanceState,
	conversationId: string,
): AgentConversationSettlement[] {
	return [...state.settledSubmissions.values()]
		.filter(
			(record): record is SubmissionSettledRecord =>
				record.conversationId === conversationId && typeof record.submissionId === 'string',
		)
		.map((record) => ({
			submissionId: record.submissionId as string,
			outcome: record.outcome,
			...(record.error === undefined ? {} : { error: record.error }),
		}));
}
