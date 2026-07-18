import type {
	AttachmentRef,
	CanonicalChildSessionRef,
	ConversationRecord,
} from './conversation-records.ts';
import type {
	AppliedRecordIndex,
	ReducedConversationState,
	ReducedEntry,
	ReducedInstanceState,
} from './conversation-reducer.ts';

/**
 * Versioned codec for persisting `ReducedInstanceState` as a derived-state
 * checkpoint (RUN-5218, slice 2 of `plans/2026-07-17-bounded-conversation-view.md`).
 *
 * The checkpoint is a CACHE of state derivable from the canonical record log —
 * never truth. Consumers must treat any decode failure or version mismatch as
 * a cache miss and rebuild from the log. Consequently the contract here is
 * deliberately strict and dumb:
 *
 * - `SNAPSHOT_VERSION` MUST be bumped by any change to the reducer's state
 *   shape (`ReducedInstanceState` or anything reachable from it). An old
 *   snapshot then reads as a miss and the log rebuilds the new shape.
 * - `decodeReducedState` throws on anything unexpected rather than guessing.
 */
export const SNAPSHOT_VERSION = 1;

interface WireEntry {
	entry: ReducedEntry;
	attachmentRefs?: [string, AttachmentRef][];
}

interface WireConversation {
	conversation: Omit<
		ReducedConversationState,
		'entries' | 'inProgressMessages' | 'toolOutcomes' | 'childConversations'
	>;
	entries: [string, WireEntry][];
	inProgressMessages: [string, unknown][];
	toolOutcomes: [string, unknown][];
	childConversations: [string, CanonicalChildSessionRef][];
}

interface WireState {
	recordsThroughOffset: string;
	conversationScopes: [string, string][];
	recordIndex: [string, AppliedRecordIndex][];
	settledSubmissions: [string, ConversationRecord][];
	conversations: [string, WireConversation][];
}

export function encodeReducedState(state: ReducedInstanceState): string {
	const wire: WireState = {
		recordsThroughOffset: state.recordsThroughOffset,
		conversationScopes: [...state.conversationScopes],
		recordIndex: [...state.recordIndex],
		settledSubmissions: [...state.settledSubmissions],
		conversations: [...state.conversations].map(([id, conversation]) => {
			const { entries, inProgressMessages, toolOutcomes, childConversations, ...rest } =
				conversation;
			return [
				id,
				{
					conversation: rest,
					entries: [...entries].map(([entryId, entry]) => {
						if (entry.type === 'message' && entry.attachmentRefs) {
							const { attachmentRefs, ...entryRest } = entry;
							return [entryId, { entry: entryRest, attachmentRefs: [...attachmentRefs] }];
						}
						return [entryId, { entry }];
					}),
					inProgressMessages: [...inProgressMessages].map(([messageId, message]) => [
						messageId,
						{
							...message,
							blocks: [...message.blocks],
							blockIndexes: [...message.blockIndexes],
						},
					]),
					toolOutcomes: [...toolOutcomes],
					childConversations: [...childConversations],
				},
			];
		}),
	};
	return JSON.stringify(wire);
}

function assertArray(value: unknown, what: string): asserts value is unknown[] {
	if (!Array.isArray(value)) throw new Error(`[flue] Snapshot decode: ${what} is not an array.`);
}

export function decodeReducedState(data: string): ReducedInstanceState {
	const wire = JSON.parse(data) as WireState;
	if (typeof wire.recordsThroughOffset !== 'string') {
		throw new Error('[flue] Snapshot decode: recordsThroughOffset missing.');
	}
	assertArray(wire.conversationScopes, 'conversationScopes');
	assertArray(wire.recordIndex, 'recordIndex');
	assertArray(wire.settledSubmissions, 'settledSubmissions');
	assertArray(wire.conversations, 'conversations');
	return {
		recordsThroughOffset: wire.recordsThroughOffset,
		conversationScopes: new Map(wire.conversationScopes),
		recordIndex: new Map(wire.recordIndex),
		settledSubmissions: new Map(wire.settledSubmissions as [string, never][]),
		conversations: new Map(
			wire.conversations.map(([id, wireConversation]) => {
				const { conversation, entries, inProgressMessages, toolOutcomes, childConversations } =
					wireConversation as WireConversation;
				assertArray(entries, `entries of ${String(id)}`);
				assertArray(inProgressMessages, `inProgressMessages of ${String(id)}`);
				assertArray(toolOutcomes, `toolOutcomes of ${String(id)}`);
				assertArray(childConversations, `childConversations of ${String(id)}`);
				return [
					id as string,
					{
						...(conversation as ReducedConversationState),
						entries: new Map(
							entries.map((pair) => {
								const [entryId, wireEntry] = pair as [string, WireEntry];
								if (wireEntry.attachmentRefs && wireEntry.entry.type === 'message') {
									return [
										entryId,
										{ ...wireEntry.entry, attachmentRefs: new Map(wireEntry.attachmentRefs) },
									];
								}
								return [entryId, wireEntry.entry];
							}),
						),
						inProgressMessages: new Map(
							(inProgressMessages as [string, Record<string, unknown>][]).map(
								([messageId, message]) => [
									messageId,
									{
										...message,
										blocks: new Map(message.blocks as [string, never][]),
										blockIndexes: new Set(message.blockIndexes as number[]),
									} as never,
								],
							),
						),
						toolOutcomes: new Map(toolOutcomes as [string, never][]),
						childConversations: new Map(childConversations),
					} as ReducedConversationState,
				];
			}),
		),
	};
}
