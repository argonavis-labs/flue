import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import type {
	AssistantMessageStartedRecord,
	AttachmentRef,
	CanonicalChildSessionRef,
	CanonicalToolResultContent,
	CanonicalUserContent,
	CompactionRecord,
	ConversationRecord,
} from './conversation-records.ts';
import { AttachmentNotAvailableError, ConversationRecordInvariantError } from './errors.ts';
import { createUserContextMessage, renderSignalMessage } from './message-rendering.ts';
import {
	createActionScopeName,
	createTaskSessionName,
	isPublicSessionName,
	isUuid,
} from './session-identity.ts';

interface ReducedEntryBase {
	id: string;
	parentId: string | null;
	timestamp: string;
	submissionId?: string;
	/**
	 * Turn this entry was recorded under, when one was active. Carried from the
	 * canonical record envelope so the public projection can expose a stable
	 * per-turn grouping identity. Absent on entries recorded outside a turn
	 * (e.g. a user message queued before the first model round-trip).
	 */
	turnId?: string;
}

export interface ReducedMessageEntry extends ReducedEntryBase {
	type: 'message';
	message: AgentMessage;
	/**
	 * Set when compaction evicted this entry's heavy content (RUN-5210): text
	 * bodies and tool-call arguments are replaced with placeholders while the
	 * entry's structure (id, parent, timestamps, usage, attachment refs) stays.
	 * Evicted entries are never projected into model context — they sit before
	 * the latest compaction's `firstKeptEntryId` — and history projections
	 * render the placeholder. The byte-faithful content remains in the log.
	 */
	contentEvicted?: true;
	attachmentRefs?: Map<string, AttachmentRef>;
	/**
	 * Validated structured tool output for tool-result entries, distinct from the
	 * model-facing `message` content. Present only when the tool declared one.
	 */
	toolOutput?: { value: unknown };
	/**
	 * Tool-handler execution time (ms) for tool-result entries, carried from the
	 * durable tool outcome. Absent on entries whose outcome predates the field.
	 */
	toolDurationMs?: number;
}

export interface ReducedCompactionEntry extends ReducedEntryBase {
	type: 'compaction';
	summary: string;
	firstKeptEntryId: string;
	sourceLeafId: string;
	tokensBefore: number;
	details?: { readFiles: string[]; modifiedFiles: string[] };
	usage?: CompactionRecord['usage'];
}

export type ReducedEntry = ReducedMessageEntry | ReducedCompactionEntry;

interface ReducedAssistantBlockBase {
	blockId: string;
	blockIndex: number;
}

interface ReducedAssistantTextBlock extends ReducedAssistantBlockBase {
	type: 'text';
	deltas: string[];
	completed: boolean;
	textSignature?: string;
}

interface ReducedAssistantReasoningBlock extends ReducedAssistantBlockBase {
	type: 'reasoning';
	deltas: string[];
	completed: boolean;
	encrypted?: string;
	redacted?: boolean;
}

interface ReducedAssistantToolCallBlock extends ReducedAssistantBlockBase {
	type: 'tool_call';
	toolCallId: string;
	name: string;
	arguments: Record<string, unknown>;
	thoughtSignature?: string;
}

type ReducedAssistantBlock =
	| ReducedAssistantTextBlock
	| ReducedAssistantReasoningBlock
	| ReducedAssistantToolCallBlock;

export interface InProgressAssistantMessage {
	messageId: string;
	parentId: string | null;
	timestamp: string;
	submissionId?: string;
	turnId?: string;
	modelInfo: AssistantMessageStartedRecord['modelInfo'];
	blocks: Map<string, ReducedAssistantBlock>;
	blockIndexes: Set<number>;
}

/**
 * A tool outcome awaiting its `tool_results_committed` record. Carries every
 * field the commit application materializes into the tool-result entry, so the
 * raw outcome record body does not need to stay resident (RUN-5210). Deleted
 * when the commit consumes it.
 */
interface ReducedToolOutcome {
	recordId: string;
	assistantMessageId: string;
	toolCallId: string;
	toolName: string;
	isError: boolean;
	content: CanonicalToolResultContent[];
	timestamp: string;
	output?: unknown;
	durationMs?: number;
}

interface ReducedConversationStateBase {
	conversationId: string;
	affinityKey: string;
	createdAt: string;
	harness: string;
	session: string;
	entries: Map<string, ReducedEntry>;
	activeLeafId: string | null;
	inProgressMessages: Map<string, InProgressAssistantMessage>;
	toolOutcomes: Map<string, ReducedToolOutcome>;
	childConversations: Map<string, CanonicalChildSessionRef>;
}

export type ReducedConversationState = ReducedConversationStateBase &
	(
		| {
				kind: 'root';
				parentConversationId?: never;
				taskId?: never;
				actionInvocationId?: never;
				agent?: never;
		  }
		| {
				kind: 'task';
				parentConversationId: string;
				taskId: string;
				actionInvocationId?: never;
				agent?: string;
		  }
		| {
				kind: 'action';
				parentConversationId: string;
				actionInvocationId: string;
				taskId?: never;
				agent?: never;
		  }
	);

/**
 * Where and as-what one applied record entered the log. `offset` is the durable
 * batch offset the record was applied at (an O(1) log fetch handle for any
 * future by-id body read); `hash` is a content fingerprint preserving the
 * redelivery contract without keeping the body resident: same id + same hash ⇒
 * idempotent skip, same id + different hash ⇒ invariant failure (RUN-5210).
 */
export interface AppliedRecordIndex {
	offset: string;
	hash: string;
}

export interface ReducedInstanceState {
	recordsThroughOffset: string;
	conversations: Map<string, ReducedConversationState>;
	conversationScopes: Map<string, string>;
	/** Every applied record's offset + content fingerprint — never the body. */
	recordIndex: Map<string, AppliedRecordIndex>;
	/**
	 * Settlement records stay resident whole: they are tiny (one per
	 * submission), and they are the only historical record bodies consumers
	 * read back after application (settlement projection and the coordinators'
	 * pending-settlement canonical comparison).
	 */
	settledSubmissions: Map<string, Extract<ConversationRecord, { type: 'submission_settled' }>>;
}

/**
 * Result of resolving an attachment for model input: either the image bytes to
 * inline, or an `evicted` marker when the image-memory cap dropped it. An
 * evicted attachment is projected as a text placeholder instead of image bytes,
 * so its base64 is never materialized.
 */
export type ProjectedAttachment = { data: string; mimeType: string } | { evicted: true };

export interface ConversationProjectionOptions {
	resolveAttachment?: (attachment: AttachmentRef) => ProjectedAttachment;
}

export interface ReducedContextEntry {
	message: AgentMessage;
	sourceEntry: ReducedEntry;
}

export function createReducedInstanceState(): ReducedInstanceState {
	return {
		recordsThroughOffset: '-1',
		conversations: new Map(),
		conversationScopes: new Map(),
		recordIndex: new Map(),
		settledSubmissions: new Map(),
	};
}

export function reduceConversationRecords(
	state: ReducedInstanceState,
	records: readonly ConversationRecord[],
	offset = state.recordsThroughOffset,
): ReducedInstanceState {
	const next = cloneReducedInstanceState(state);
	for (const record of records) applyConversationRecord(next, record, offset);
	next.recordsThroughOffset = offset;
	return next;
}

function cloneReducedInstanceState(state: ReducedInstanceState): ReducedInstanceState {
	return {
		recordsThroughOffset: state.recordsThroughOffset,
		conversationScopes: new Map(state.conversationScopes),
		recordIndex: new Map(state.recordIndex),
		settledSubmissions: new Map(state.settledSubmissions),
		conversations: new Map(
			[...state.conversations].map(([id, conversation]) => [
				id,
				{
					...conversation,
					entries: new Map(
						[...conversation.entries].map(([entryId, entry]) => [
							entryId,
							entry.type === 'message'
								? {
									...entry,
									attachmentRefs: entry.attachmentRefs
										? new Map(entry.attachmentRefs)
										: undefined,
								}
								: { ...entry },
						]),
					),
					inProgressMessages: new Map(
						[...conversation.inProgressMessages].map(([messageId, message]) => [
							messageId,
							{
								...message,
								blocks: new Map(
									[...message.blocks].map(([blockId, block]) => [
										blockId,
										block.type === 'text' || block.type === 'reasoning'
											? { ...block, deltas: [...block.deltas] }
											: { ...block },
									]),
								),
								blockIndexes: new Set(message.blockIndexes),
							},
						]),
					),
					toolOutcomes: new Map(
						[...conversation.toolOutcomes].map(([toolCallId, outcome]) => [
							toolCallId,
							{ ...outcome, content: outcome.content.map((block) => ({ ...block })) },
						]),
					),
					childConversations: new Map(conversation.childConversations),
				},
			]),
		),
	};
}

/**
 * Content fingerprint for the redelivery contract. Bounded work per record
 * regardless of body size: length plus two independent 32-bit FNV-1a passes
 * over a ≤512-char stride sample of the canonical JSON. This is a
 * defense-in-depth guard behind the store's producer-sequence dedup, not a
 * cryptographic identity; a differing redelivery is overwhelmingly likely to
 * differ in length or sampled positions.
 */
function recordContentHash(record: ConversationRecord): string {
	const serialized = JSON.stringify(record);
	const stride = Math.max(1, Math.floor(serialized.length / 512));
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < serialized.length; i += stride) {
		const code = serialized.charCodeAt(i);
		h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
		h2 = (Math.imul(h2 ^ code, 0x85ebca6b) + i) >>> 0;
	}
	return `${serialized.length.toString(36)}.${h1.toString(36)}.${h2.toString(36)}`;
}

export function applyConversationRecord(
	state: ReducedInstanceState,
	record: ConversationRecord,
	offset = state.recordsThroughOffset,
): void {
	const hash = recordContentHash(record);
	const accepted = state.recordIndex.get(record.id);
	if (accepted) {
		if (accepted.hash === hash) return;
		fail(record, `Record id "${record.id}" was reused with different content.`);
	}
	if (record.v !== 1) fail(record, `Record version "${String(record.v)}" is unsupported.`);

	if (record.type === 'conversation_created') {
		validateConversationCreation(state, record);
		if (state.conversations.has(record.conversationId)) {
			fail(record, `Conversation "${record.conversationId}" is already initialized.`);
		}
		const scopeKey = conversationScopeKey(record.harness, record.session);
		const scopeOwner = state.conversationScopes.get(scopeKey);
		if (scopeOwner) {
			fail(record, `Conversation scope is already owned by "${scopeOwner}".`);
		}
		if (record.parentConversationId && !state.conversations.has(record.parentConversationId)) {
			fail(record, `Parent conversation "${record.parentConversationId}" does not exist.`);
		}
		state.conversations.set(record.conversationId, {
			...record,
			entries: new Map(),
			activeLeafId: null,
			inProgressMessages: new Map(),
			toolOutcomes: new Map(),
			childConversations: new Map(),
		});
		state.conversationScopes.set(scopeKey, record.conversationId);
		state.recordIndex.set(record.id, { offset, hash });
		return;
	}

	const conversation = state.conversations.get(record.conversationId);
	if (!conversation) fail(record, `Conversation "${record.conversationId}" is not initialized.`);
	if (conversation.harness !== record.harness || conversation.session !== record.session) {
		fail(record, `Conversation scope conflicts with its creation record.`);
	}
	switch (record.type) {
		case 'user_message':
			appendEntry(conversation, record, {
				type: 'message',
				id: record.messageId,
				parentId: record.parentId,
				timestamp: record.timestamp,
				submissionId: record.submissionId,
				turnId: record.turnId,
				message: userMessage(record.content, record.timestamp),
				attachmentRefs: attachmentRefs(record.content),
			});
			break;
		case 'signal':
			appendEntry(conversation, record, {
				type: 'message',
				id: record.messageId,
				parentId: record.parentId,
				timestamp: record.timestamp,
				submissionId: record.submissionId,
				turnId: record.turnId,
				message: {
					role: 'signal',
					type: record.signalType,
					tagName: record.tagName,
					content: record.content,
					attributes: record.attributes,
					timestamp: new Date(record.timestamp).getTime(),
				},
			});
			break;
		case 'assistant_message_started':
			assertParent(conversation, record, record.parentId);
			if (record.parentId !== conversation.activeLeafId) {
				fail(record, `Assistant parent "${String(record.parentId)}" is not the conversation tail. Appends are linear.`);
			}
			if (conversation.entries.has(record.messageId) || conversation.inProgressMessages.has(record.messageId)) {
				fail(record, `Assistant entry "${record.messageId}" already exists.`);
			}
			conversation.inProgressMessages.set(record.messageId, {
				messageId: record.messageId,
				parentId: record.parentId,
				timestamp: record.timestamp,
				submissionId: record.submissionId,
				turnId: record.turnId,
				modelInfo: record.modelInfo,
				blocks: new Map(),
				blockIndexes: new Set(),
			});
			break;
		case 'assistant_text_started': {
			const message = getInProgress(conversation, record, record.messageId);
			startBlock(message, record, {
				type: 'text',
				blockId: record.blockId,
				blockIndex: record.blockIndex,
				deltas: [],
				completed: false,
			});
			break;
		}
		case 'assistant_reasoning_started': {
			const message = getInProgress(conversation, record, record.messageId);
			startBlock(message, record, {
				type: 'reasoning',
				blockId: record.blockId,
				blockIndex: record.blockIndex,
				deltas: [],
				completed: false,
			});
			break;
		}
		case 'assistant_text_delta':
			appendDelta(conversation, record, 'text');
			break;
		case 'assistant_reasoning_delta':
			appendDelta(conversation, record, 'reasoning');
			break;
		case 'assistant_text_completed': {
			const block = completeBlock(conversation, record, 'text');
			block.textSignature = record.textSignature;
			break;
		}
		case 'assistant_reasoning_completed': {
			const block = completeBlock(conversation, record, 'reasoning');
			block.encrypted = record.encrypted;
			block.redacted = record.redacted;
			break;
		}
		case 'assistant_tool_call': {
			const message = getInProgress(conversation, record, record.messageId);
			startBlock(message, record, {
				type: 'tool_call',
				blockId: record.blockId,
				blockIndex: record.blockIndex,
				toolCallId: record.toolCallId,
				name: record.name,
				arguments: record.arguments,
				thoughtSignature: record.thoughtSignature,
			});
			break;
		}
		case 'assistant_message_completed': {
			const inProgress = getInProgress(conversation, record, record.messageId);
			for (const block of inProgress.blocks.values()) {
				if ((block.type === 'text' || block.type === 'reasoning') && !block.completed) {
					fail(record, `Assistant block "${block.blockId}" is not complete.`);
				}
			}
			const content = [...inProgress.blocks.values()]
				.sort((a, b) => a.blockIndex - b.blockIndex)
				.map(materializeAssistantBlock);
			const message = {
				...inProgress.modelInfo,
				role: 'assistant',
				content,
				stopReason: record.stopReason,
				usage: record.usage,
				errorMessage: record.error,
				timestamp: new Date(inProgress.timestamp).getTime(),
			} as AssistantMessage;
			assertAssistantCompletionAppend(conversation, record, inProgress);
			conversation.inProgressMessages.delete(record.messageId);
			commitEntry(conversation, {
				type: 'message',
				id: record.messageId,
				parentId: inProgress.parentId,
				timestamp: inProgress.timestamp,
				submissionId: inProgress.submissionId,
				turnId: inProgress.turnId,
				message,
			});
			break;
		}
		case 'tool_outcome': {
			const assistant = conversation.entries.get(record.assistantMessageId);
			if (assistant?.type !== 'message' || assistant.message.role !== 'assistant') {
				fail(record, `Tool outcome assistant "${record.assistantMessageId}" does not exist.`);
			}
			const call = assistant.message.content.find(
				(block): block is Extract<AssistantMessage['content'][number], { type: 'toolCall' }> =>
					block.type === 'toolCall' && block.id === record.toolCallId,
			);
			if (!call || call.name !== record.toolName) {
				fail(record, `Tool outcome does not match its assistant tool request.`);
			}
			const outcomeKey = toolOutcomeKey(record.assistantMessageId, record.toolCallId);
			if (conversation.toolOutcomes.has(outcomeKey)) {
				fail(record, `Tool outcome for "${record.toolCallId}" already exists.`);
			}
			conversation.toolOutcomes.set(outcomeKey, {
				recordId: record.id,
				assistantMessageId: record.assistantMessageId,
				toolCallId: record.toolCallId,
				toolName: record.toolName,
				isError: record.isError,
				content: record.content.map((block) => ({ ...block })),
				timestamp: record.timestamp,
				...(record.output !== undefined ? { output: record.output } : {}),
				...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
			});
			break;
		}
		case 'tool_results_committed': {
			const assistant = conversation.entries.get(record.assistantMessageId);
			if (
				assistant?.type !== 'message' ||
				assistant.message.role !== 'assistant' ||
				assistant.message.stopReason !== 'toolUse'
			) {
				fail(record, `Committed tool results require a completed tool-use assistant.`);
			}
			if (record.parentId !== record.assistantMessageId || record.parentId !== conversation.activeLeafId) {
				fail(record, `Committed tool results must extend their active assistant parent.`);
			}
			const calls = assistant.message.content.filter((block) => block.type === 'toolCall');
			if (record.outcomeIds.length !== calls.length || new Set(record.outcomeIds).size !== calls.length) {
				fail(record, `Committed tool results must reference every assistant tool call exactly once.`);
			}
			// The pending outcome is the retained source of truth for the commit:
			// it was scope-validated into THIS conversation when its record
			// applied, so conversation/harness/session equality is implied by
			// residency; the recordId equality below still pins the commit to the
			// exact outcome record it references (RUN-5210).
			const outcomes = record.outcomeIds.map((outcomeId, index) => {
				const call = calls[index];
				const pending = call
					? conversation.toolOutcomes.get(toolOutcomeKey(record.assistantMessageId, call.id))
					: undefined;
				if (
					!call ||
					!pending ||
					pending.recordId !== outcomeId ||
					pending.assistantMessageId !== record.assistantMessageId ||
					pending.toolCallId !== call.id ||
					pending.toolName !== call.name
				) {
					fail(record, `Committed tool outcome references do not match assistant tool-call order.`);
				}
				return pending;
			});
			let parentId = record.parentId;
			for (const outcome of outcomes) {
				const entryId = toolResultEntryId(record.assistantMessageId, outcome.toolCallId);
				assertEntryAppend(conversation, record, entryId, parentId);
				commitEntry(conversation, {
					type: 'message',
					id: entryId,
					parentId,
					timestamp: outcome.timestamp,
					submissionId: record.submissionId,
					message: toolResultMessage(outcome),
					attachmentRefs: attachmentRefs(outcome.content),
					...(outcome.output !== undefined ? { toolOutput: { value: outcome.output } } : {}),
					...(outcome.durationMs !== undefined ? { toolDurationMs: outcome.durationMs } : {}),
				});
				parentId = entryId;
			}
			// The commit consumed its outcomes: the content now lives on the
			// tool-result entries, so the pending copies are deleted (RUN-5210).
			for (const outcome of outcomes) {
				conversation.toolOutcomes.delete(toolOutcomeKey(record.assistantMessageId, outcome.toolCallId));
			}
			break;
		}
		case 'compaction':
			if (!conversation.entries.has(record.firstKeptEntryId)) {
				fail(record, `Compaction first-kept entry "${record.firstKeptEntryId}" does not exist.`);
			}
			if (!conversation.entries.has(record.sourceLeafId)) {
				fail(record, `Compaction source leaf "${record.sourceLeafId}" does not exist.`);
			}
			if (record.sourceLeafId !== record.parentId || record.sourceLeafId !== conversation.activeLeafId) {
				fail(record, `Compaction source leaf must be its active parent.`);
			}
			if (!pathToLeaf(conversation, record.sourceLeafId).some((entry) => entry.id === record.firstKeptEntryId)) {
				fail(record, `Compaction first-kept entry is not on the source path.`);
			}
			appendEntry(conversation, record, {
				type: 'compaction',
				id: record.entryId,
				parentId: record.parentId,
				timestamp: record.timestamp,
				submissionId: record.submissionId,
				summary: record.summary,
				firstKeptEntryId: record.firstKeptEntryId,
				sourceLeafId: record.sourceLeafId,
				tokensBefore: record.tokensBefore,
				details: record.details,
				usage: record.usage,
			});
			evictCompactedContent(conversation, record.sourceLeafId, record.firstKeptEntryId);
			break;
		case 'child_session_retained': {
			validateChildReference(record);
			const child = state.conversations.get(record.child.conversationId);
			if (!child) fail(record, `Retained child conversation does not exist.`);
			const identityMatches = record.child.type === 'task'
				? child.kind === 'task' && child.taskId === record.child.taskId
				: child.kind === 'action' && child.actionInvocationId === record.child.invocationId;
			if (
				child.parentConversationId !== conversation.conversationId ||
				child.harness !== record.child.harness ||
				child.session !== record.child.session ||
				!identityMatches
			) {
				fail(record, `Retained child identity conflicts with its creation record.`);
			}
			for (const parent of state.conversations.values()) {
				if (parent !== conversation && parent.childConversations.has(record.child.conversationId)) {
					fail(record, `Child conversation is already retained by another parent.`);
				}
			}
			const existing = conversation.childConversations.get(record.child.conversationId);
			if (existing && JSON.stringify(existing) !== JSON.stringify(record.child)) {
				fail(record, `Child conversation topology conflicts with an existing retained child.`);
			}
			conversation.childConversations.set(record.child.conversationId, record.child);
			break;
		}
		case 'submission_settled':
			state.settledSubmissions.set(record.id, record);
			break;
	}
	state.recordIndex.set(record.id, { offset, hash });
}

function validateConversationCreation(
	state: ReducedInstanceState,
	record: Extract<ConversationRecord, { type: 'conversation_created' }>,
): void {
	const value = record as ConversationRecord & Record<string, unknown>;
	if (value.kind === 'root') {
		if (
			value.parentConversationId !== undefined ||
			value.taskId !== undefined ||
			value.actionInvocationId !== undefined ||
			value.agent !== undefined
		) {
			fail(record, `Root conversation creation contains child identity fields.`);
		}
		return;
	}
	if (value.kind === 'task') {
		if (
			typeof value.parentConversationId !== 'string' ||
			typeof value.taskId !== 'string' ||
			value.actionInvocationId !== undefined ||
			!isUuid(value.taskId) ||
			(value.agent !== undefined && typeof value.agent !== 'string')
		) {
			fail(record, `Task conversation creation has invalid discriminated identity.`);
		}
		const parent = state.conversations.get(value.parentConversationId);
		if (!parent) return;
		if (record.harness !== parent.harness || record.session !== createTaskSessionName(parent.session, value.taskId)) {
			fail(record, `Task conversation scope does not match its derived parent identity.`);
		}
		return;
	}
	if (
		value.kind !== 'action' ||
		typeof value.parentConversationId !== 'string' ||
		typeof value.actionInvocationId !== 'string' ||
		value.taskId !== undefined ||
		value.agent !== undefined ||
		!isUuid(value.actionInvocationId)
	) {
		fail(record, `Action conversation creation has invalid discriminated identity.`);
	}
	const parent = state.conversations.get(value.parentConversationId);
	if (!parent) return;
	if (
		record.harness !== `${parent.harness}:${createActionScopeName(value.actionInvocationId)}` ||
		!isPublicSessionName(record.session)
	) {
		fail(record, `Action conversation scope does not match its derived parent identity.`);
	}
}

function validateChildReference(
	record: Extract<ConversationRecord, { type: 'child_session_retained' }>,
): void {
	const child = record.child as CanonicalChildSessionRef & Record<string, unknown>;
	if (child.type === 'task') {
		if (
			typeof child.taskId !== 'string' ||
			child.invocationId !== undefined ||
			!isUuid(child.taskId) ||
			(child.parentToolCallId !== undefined && typeof child.parentToolCallId !== 'string') ||
			(child.parentAssistantEntryId !== undefined && typeof child.parentAssistantEntryId !== 'string')
		) {
			fail(record, `Task child reference has invalid discriminated identity.`);
		}
		return;
	}
	if (
		child.type !== 'action' ||
		typeof child.invocationId !== 'string' ||
		child.taskId !== undefined ||
		child.parentToolCallId !== undefined ||
		child.parentAssistantEntryId !== undefined ||
		!isUuid(child.invocationId)
	) {
		fail(record, `Action child reference has invalid discriminated identity.`);
	}
}

export function getActiveConversationPath(conversation: ReducedConversationState): ReducedEntry[] {
	const path: ReducedEntry[] = [];
	const visited = new Set<string>();
	let current = conversation.activeLeafId
		? conversation.entries.get(conversation.activeLeafId)
		: undefined;
	while (current) {
		if (visited.has(current.id)) {
			throw new ConversationRecordInvariantError({
				recordId: current.id,
				recordType: current.type,
				reason: `Conversation graph contains a cycle at "${current.id}".`,
			});
		}
		visited.add(current.id);
		path.push(current);
		current = current.parentId ? conversation.entries.get(current.parentId) : undefined;
	}
	return path.reverse();
}

export function buildConversationContextEntries(
	conversation: ReducedConversationState,
	options: ConversationProjectionOptions = {},
): ReducedContextEntry[] {
	const path = getActiveConversationPath(conversation);
	const latestCompactionIndex = path.findLastIndex((entry) => entry.type === 'compaction');
	if (latestCompactionIndex === -1) return pathToContextEntries(path, options);
	const compaction = path[latestCompactionIndex] as ReducedCompactionEntry;
	const firstKeptIndex = path.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
	const keptStart = firstKeptIndex >= 0 ? firstKeptIndex : latestCompactionIndex + 1;
	return [
		{
			message: createUserContextMessage(
				renderSignalMessage({
					role: 'signal',
					type: 'context_summary',
					tagName: 'compaction',
					content: compaction.summary,
					timestamp: new Date(compaction.timestamp).getTime(),
				}),
				compaction.timestamp,
			),
			sourceEntry: compaction,
		},
		...pathToContextEntries(path.slice(keptStart, latestCompactionIndex), options),
		...pathToContextEntries(path.slice(latestCompactionIndex + 1), options),
	];
}

export function buildConversationContext(
	conversation: ReducedConversationState,
	options: ConversationProjectionOptions = {},
): AgentMessage[] {
	return buildConversationContextEntries(conversation, options).map((entry) => entry.message);
}

function pathToContextEntries(
	path: ReducedEntry[],
	options: ConversationProjectionOptions,
): ReducedContextEntry[] {
	const messages: ReducedContextEntry[] = [];
	let index = 0;
	while (index < path.length) {
		const entry = path[index];
		if (!entry || entry.type !== 'message') {
			index += 1;
			continue;
		}
		const message = resolveMessageAttachments(entry, options);
		if (message.role === 'signal') {
			messages.push({
				message: createUserContextMessage(renderSignalMessage(message), entry.timestamp),
				sourceEntry: entry,
			});
			index += 1;
			continue;
		}
		if (message.role === 'assistant') {
			if (message.stopReason === 'error' || message.stopReason === 'aborted') {
				const next = path[index + 1];
				const afterNext = path[index + 2];
				const resumable =
					message.stopReason === 'aborted' &&
					next?.type === 'message' &&
					next.message.role === 'signal' &&
					next.message.type === 'stream_interrupted' &&
					afterNext?.type === 'message' &&
					afterNext.message.role === 'signal' &&
					afterNext.message.type === 'stream_continued';
				if (!resumable) {
					index += 1;
					continue;
				}
			}
			const toolCalls = message.content.filter((block) => block.type === 'toolCall');
			if (toolCalls.length > 0) {
				const results: ToolResultMessage[] = [];
				let resultIndex = index + 1;
				while (resultIndex < path.length) {
					const result = path[resultIndex];
					if (result?.type !== 'message' || result.message.role !== 'toolResult') break;
					results.push(resolveMessageAttachments(result, options) as ToolResultMessage);
					resultIndex += 1;
				}
				if (isCompleteToolBatch(toolCalls, results)) {
					messages.push({ message, sourceEntry: entry });
					for (let resultOffset = 0; resultOffset < results.length; resultOffset++) {
						const resultEntry = path[index + 1 + resultOffset];
						const result = results[resultOffset];
						if (resultEntry && result) messages.push({ message: result, sourceEntry: resultEntry });
					}
				}
				index = resultIndex;
				continue;
			}
			messages.push({ message, sourceEntry: entry });
			index += 1;
			continue;
		}
		if (message.role !== 'toolResult') messages.push({ message, sourceEntry: entry });
		index += 1;
	}
	return messages;
}

function appendEntry(
	conversation: ReducedConversationState,
	record: ConversationRecord,
	entry: ReducedEntry,
): void {
	assertEntryAppend(conversation, record, entry.id, entry.parentId);
	commitEntry(conversation, entry);
}

function assertEntryAppend(
	conversation: ReducedConversationState,
	record: ConversationRecord,
	entryId: string,
	parentId: string | null,
): void {
	if (!entryId.startsWith('entry_')) fail(record, `Graph entry ids must use the "entry_" prefix.`);
	if (conversation.entries.has(entryId) || conversation.inProgressMessages.has(entryId)) {
		fail(record, `Graph entry "${entryId}" already exists.`);
	}
	assertParent(conversation, record, parentId);
	if (parentId !== conversation.activeLeafId) {
		fail(
			record,
			`Entry parent "${String(parentId)}" is not the conversation tail "${String(conversation.activeLeafId)}". Appends are linear.`,
		);
	}
	if (conversation.inProgressMessages.size > 0) {
		fail(record, `Cannot advance the conversation while an assistant message is in progress.`);
	}
}

function commitEntry(
	conversation: ReducedConversationState,
	entry: ReducedEntry,
): void {
	conversation.entries.set(entry.id, entry);
	conversation.activeLeafId = entry.id;
}

function assertAssistantCompletionAppend(
	conversation: ReducedConversationState,
	record: ConversationRecord,
	message: InProgressAssistantMessage,
): void {
	if (!message.messageId.startsWith('entry_')) {
		fail(record, `Graph entry ids must use the "entry_" prefix.`);
	}
	if (conversation.entries.has(message.messageId)) {
		fail(record, `Graph entry "${message.messageId}" already exists.`);
	}
	assertParent(conversation, record, message.parentId);
	if (message.parentId !== conversation.activeLeafId) {
		fail(record, `Assistant parent is no longer the conversation tail.`);
	}
}

function assertParent(
	conversation: ReducedConversationState,
	record: ConversationRecord,
	parentId: string | null,
): void {
	if (parentId !== null && !conversation.entries.has(parentId)) {
		fail(record, `Parent entry "${parentId}" does not exist in this conversation.`);
	}
}

function pathToLeaf(
	conversation: ReducedConversationState,
	leafId: string,
): ReducedEntry[] {
	const path: ReducedEntry[] = [];
	let current = conversation.entries.get(leafId);
	while (current) {
		path.push(current);
		current = current.parentId ? conversation.entries.get(current.parentId) : undefined;
	}
	return path.reverse();
}

export const EVICTED_CONTENT_PLACEHOLDER = '[content evicted after compaction]';

/**
 * Evict heavy content from the entries a compaction just summarized: every
 * message entry on the compacted path strictly before `firstKeptEntryId`
 * (RUN-5210). The model context is built from the compaction summary plus
 * entries from `firstKeptEntryId` onward, so evicted content is never
 * projected into a prompt; new tool outcomes can only reference the active
 * leaf's assistant, which is always after the latest compaction. Structure —
 * ids, parents, timestamps, usage, attachment refs — is retained so leaf
 * resolution and linear-append validation are untouched. The byte-faithful
 * content remains in the durable log.
 */
function evictCompactedContent(
	conversation: ReducedConversationState,
	sourceLeafId: string,
	firstKeptEntryId: string,
): void {
	const path = pathToLeaf(conversation, sourceLeafId);
	const firstKeptIndex = path.findIndex((entry) => entry.id === firstKeptEntryId);
	if (firstKeptIndex === -1) return;
	for (const entry of path.slice(0, firstKeptIndex)) {
		if (entry.type !== 'message' || entry.contentEvicted) continue;
		entry.contentEvicted = true;
		delete entry.toolOutput;
		entry.message = evictMessageContent(entry.message);
	}
}

function evictMessageContent(message: AgentMessage): AgentMessage {
	const value = message as AgentMessage & { content?: unknown };
	// Signal messages carry their content as a plain string.
	if (typeof value.content === 'string') {
		return { ...message, content: EVICTED_CONTENT_PLACEHOLDER } as AgentMessage;
	}
	if (!Array.isArray(value.content)) return message;
	const content = value.content.map((block: unknown) => {
		if (block === null || typeof block !== 'object') return block;
		const candidate = block as Record<string, unknown>;
		if (typeof candidate.text === 'string') return { ...candidate, text: EVICTED_CONTENT_PLACEHOLDER };
		if (typeof candidate.thinking === 'string') {
			return { ...candidate, thinking: EVICTED_CONTENT_PLACEHOLDER };
		}
		if (candidate.type === 'toolCall') return { ...candidate, arguments: {} };
		// Image/attachment blocks carry attachment ids, not bytes — retained.
		return block;
	});
	return { ...message, content } as AgentMessage;
}

function getInProgress(
	conversation: ReducedConversationState,
	record: ConversationRecord,
	messageId: string,
): InProgressAssistantMessage {
	const message = conversation.inProgressMessages.get(messageId);
	if (!message) fail(record, `Assistant message "${messageId}" is not in progress.`);
	return message;
}

function startBlock(
	message: InProgressAssistantMessage,
	record: ConversationRecord,
	block: ReducedAssistantBlock,
): void {
	if (!Number.isInteger(block.blockIndex) || block.blockIndex < 0) {
		fail(record, `Block index must be a non-negative integer.`);
	}
	if (message.blocks.has(block.blockId)) fail(record, `Block "${block.blockId}" already exists.`);
	if (message.blockIndexes.has(block.blockIndex)) {
		fail(record, `Block index "${block.blockIndex}" already exists in this message.`);
	}
	message.blocks.set(block.blockId, block);
	message.blockIndexes.add(block.blockIndex);
}

function appendDelta(
	conversation: ReducedConversationState,
	record: Extract<
		ConversationRecord,
		{ type: 'assistant_text_delta' | 'assistant_reasoning_delta' }
	>,
	type: 'text' | 'reasoning',
): void {
	const message = getInProgress(conversation, record, record.messageId);
	const block = message.blocks.get(record.blockId);
	if (!block || block.type !== type) fail(record, `Block "${record.blockId}" is not ${type}.`);
	if (block.completed) fail(record, `Block "${record.blockId}" is already complete.`);
	if (record.sequence !== block.deltas.length) {
		fail(record, `Expected delta sequence ${block.deltas.length}, received ${record.sequence}.`);
	}
	block.deltas.push(record.delta);
}

function completeBlock(
	conversation: ReducedConversationState,
	record: Extract<
		ConversationRecord,
		{ type: 'assistant_text_completed' | 'assistant_reasoning_completed' }
	>,
	type: 'text',
): ReducedAssistantTextBlock;
function completeBlock(
	conversation: ReducedConversationState,
	record: Extract<
		ConversationRecord,
		{ type: 'assistant_text_completed' | 'assistant_reasoning_completed' }
	>,
	type: 'reasoning',
): ReducedAssistantReasoningBlock;
function completeBlock(
	conversation: ReducedConversationState,
	record: Extract<
		ConversationRecord,
		{ type: 'assistant_text_completed' | 'assistant_reasoning_completed' }
	>,
	type: 'text' | 'reasoning',
): ReducedAssistantTextBlock | ReducedAssistantReasoningBlock {
	const message = getInProgress(conversation, record, record.messageId);
	const block = message.blocks.get(record.blockId);
	if (!block || block.type !== type) fail(record, `Block "${record.blockId}" is not ${type}.`);
	if (block.completed) fail(record, `Block "${record.blockId}" is already complete.`);
	if (record.deltaCount !== block.deltas.length) {
		fail(record, `Completion expected ${record.deltaCount} deltas but replay has ${block.deltas.length}.`);
	}
	block.completed = true;
	return block;
}

function materializeAssistantBlock(
	block: ReducedAssistantBlock,
): AssistantMessage['content'][number] {
	if (block.type === 'text') {
		return {
			type: 'text',
			text: block.deltas.join(''),
			textSignature: block.textSignature,
		};
	}
	if (block.type === 'reasoning') {
		return {
			type: 'thinking',
			thinking: block.deltas.join(''),
			thinkingSignature: block.encrypted,
			redacted: block.redacted,
		};
	}
	return {
		type: 'toolCall',
		id: block.toolCallId,
		name: block.name,
		arguments: block.arguments,
		thoughtSignature: block.thoughtSignature,
	};
}

function attachmentRefs(
	content: Array<CanonicalUserContent | CanonicalToolResultContent>,
): Map<string, AttachmentRef> | undefined {
	const refs = content.flatMap((block) => (block.type === 'attachment' ? [block.attachment] : []));
	return refs.length > 0 ? new Map(refs.map((ref) => [ref.id, ref])) : undefined;
}

function userMessage(content: CanonicalUserContent[], timestamp: string): AgentMessage {
	return {
		role: 'user',
		content: content.map((block) =>
			block.type === 'text'
				? block
				: {
						type: 'image' as const,
						data: block.attachment.id,
						mimeType: block.attachment.mimeType,
					},
		),
		timestamp: new Date(timestamp).getTime(),
	} as UserMessage as AgentMessage;
}

function toolResultMessage(
	record: Pick<
		Extract<ConversationRecord, { type: 'tool_outcome' }>,
		'toolCallId' | 'toolName' | 'isError' | 'content' | 'timestamp'
	>,
): AgentMessage {
	return {
		role: 'toolResult',
		toolCallId: record.toolCallId,
		toolName: record.toolName,
		isError: record.isError,
		content: record.content.map((block) =>
			block.type === 'text'
				? block
				: {
						type: 'image' as const,
						data: block.attachment.id,
						mimeType: block.attachment.mimeType,
					},
		),
		timestamp: new Date(record.timestamp).getTime(),
	} as ToolResultMessage as AgentMessage;
}

function resolveMessageAttachments(
	entry: ReducedMessageEntry,
	options: ConversationProjectionOptions,
): AgentMessage {
	const message = entry.message;
	if ((message.role !== 'user' && message.role !== 'toolResult') || !Array.isArray(message.content)) {
		return message;
	}
	const attachments = [...(entry.attachmentRefs?.values() ?? [])];
	// Resolve each attachment once: the `<attachments>` manifest and the inline
	// image blocks must agree on which images are evicted, so both read from the
	// same resolution rather than the manifest claiming an image is present while
	// its inline block says `evicted`.
	const resolved = new Map<string, ProjectedAttachment>();
	if (options.resolveAttachment) {
		for (const attachment of attachments) {
			resolved.set(attachment.id, options.resolveAttachment(attachment));
		}
	}
	let manifestProjected = false;
	const content = message.content.map((block) => {
		if (block.type === 'text' && !manifestProjected && attachments.length > 0) {
			manifestProjected = true;
			return { ...block, text: attachmentManifest(block.text, attachments, resolved) };
		}
		if (block.type !== 'image') return block;
		const ref = entry.attachmentRefs?.get(block.data);
		if (!ref) return block;
		const projected = resolved.get(ref.id);
		if (!projected) throw new AttachmentNotAvailableError({ attachmentId: ref.id });
		if ('evicted' in projected) {
			return {
				type: 'text' as const,
				text: `<image id="${ref.id}" mimeType="${ref.mimeType}" evicted />`,
			};
		}
		return { type: 'image' as const, ...projected };
	});
	if (!manifestProjected && attachments.length > 0) {
		content.unshift({ type: 'text', text: attachmentManifest('', attachments, resolved) });
	}
	return { ...message, content } as AgentMessage;
}

function attachmentManifest(
	text: string,
	attachments: readonly AttachmentRef[],
	resolved: ReadonlyMap<string, ProjectedAttachment>,
): string {
	if (attachments.length === 0) return text;
	const manifest = attachments
		.map((attachment) => {
			const projected = resolved.get(attachment.id);
			const evicted = projected !== undefined && 'evicted' in projected ? ' evicted' : '';
			return `<image id="${attachment.id}" mimeType="${attachment.mimeType}"${evicted} />`;
		})
		.join('\n');
	const projection = `\n\n<attachments>\n${manifest}\n</attachments>`;
	return text.endsWith(projection) ? text : `${text}${projection}`;
}

function isCompleteToolBatch(
	toolCalls: Extract<AssistantMessage['content'][number], { type: 'toolCall' }>[],
	results: ToolResultMessage[],
): boolean {
	if (toolCalls.length !== results.length) return false;
	const seen = new Set<string>();
	for (let index = 0; index < toolCalls.length; index++) {
		const call = toolCalls[index];
		const result = results[index];
		if (!call || !result || seen.has(call.id)) return false;
		seen.add(call.id);
		if (result.toolCallId !== call.id || result.toolName !== call.name) return false;
	}
	return true;
}

export function toolOutcomeKey(assistantMessageId: string, toolCallId: string): string {
	return JSON.stringify([assistantMessageId, toolCallId]);
}

export function toolResultEntryId(assistantMessageId: string, toolCallId: string): string {
	return `entry_tool_result_${encodeCanonicalId(assistantMessageId)}_${encodeCanonicalId(toolCallId)}`;
}

function encodeCanonicalId(id: string): string {
	const bytes = new TextEncoder().encode(id);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function conversationScopeKey(harness: string, session: string): string {
	return JSON.stringify([harness, session]);
}

function fail(record: ConversationRecord, reason: string): never {
	throw new ConversationRecordInvariantError({
		recordId: record.id,
		recordType: record.type,
		reason,
	});
}
