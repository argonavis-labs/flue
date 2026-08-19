import { describe, expect, it } from 'vitest';
import {
	projectAgentConversationBatch,
	projectAgentConversationSnapshot,
} from '../src/conversation-public.ts';
import type { ConversationRecord } from '../src/conversation-records.ts';
import {
	applyConversationRecord,
	createReducedInstanceState,
	reduceConversationRecords,
} from '../src/conversation-reducer.ts';

const scope = {
	v: 1 as const,
	conversationId: 'conv_01',
	harness: 'default',
	session: 'default',
};

const usage = {
	input: 10,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 12,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A tool-use assistant with two parallel calls and no outcomes yet. */
function toolUseConversation(): ConversationRecord[] {
	return [
		{
			...scope,
			id: 'record_created',
			type: 'conversation_created',
			kind: 'root',
			timestamp: '2026-06-25T00:00:00.000Z',
			affinityKey: 'aff_01',
			createdAt: '2026-06-25T00:00:00.000Z',
		},
		{
			...scope,
			id: 'record_user',
			type: 'user_message',
			timestamp: '2026-06-25T00:00:01.000Z',
			messageId: 'entry_user',
			parentId: null,
			content: [{ type: 'text', text: 'Hello' }],
		},
		{
			...scope,
			id: 'record_assistant_start',
			type: 'assistant_message_started',
			timestamp: '2026-06-25T00:00:02.000Z',
			messageId: 'entry_assistant',
			parentId: 'entry_user',
			turnId: 'turn_01',
			modelInfo: { api: 'test', provider: 'test', model: 'test-model' },
		},
		{
			...scope,
			id: 'record_call_fast',
			type: 'assistant_tool_call',
			timestamp: '2026-06-25T00:00:02.100Z',
			messageId: 'entry_assistant',
			blockId: 'block_fast',
			blockIndex: 0,
			toolCallId: 'call_fast',
			name: 'lookup',
			arguments: {},
		},
		{
			...scope,
			id: 'record_call_slow',
			type: 'assistant_tool_call',
			timestamp: '2026-06-25T00:00:02.200Z',
			messageId: 'entry_assistant',
			blockId: 'block_slow',
			blockIndex: 1,
			toolCallId: 'call_slow',
			name: 'subtask',
			arguments: {},
		},
		{
			...scope,
			id: 'record_assistant_complete',
			type: 'assistant_message_completed',
			timestamp: '2026-06-25T00:00:02.300Z',
			messageId: 'entry_assistant',
			stopReason: 'toolUse',
			usage,
		},
	];
}

function fastOutcome(): ConversationRecord {
	return {
		...scope,
		id: 'record_outcome_fast',
		type: 'tool_outcome',
		timestamp: '2026-06-25T00:00:03.000Z',
		assistantMessageId: 'entry_assistant',
		toolCallId: 'call_fast',
		toolName: 'lookup',
		isError: false,
		content: [{ type: 'text', text: 'fast result' }],
		durationMs: 42,
	};
}

describe('projectAgentConversationBatch()', () => {
	it('emits a tool-output chunk for a bare outcome record, before the batch commits', () => {
		const state = reduceConversationRecords(createReducedInstanceState(), toolUseConversation(), '6');
		const outcome = fastOutcome();
		applyConversationRecord(state, outcome);

		const chunks = projectAgentConversationBatch({ state, records: [outcome], batchOrdinal: 7 });

		expect(chunks).toEqual([
			{
				type: 'tool-output',
				conversationId: 'conv_01',
				toolCallId: 'call_fast',
				output: 'fast result',
				durationMs: 42,
				position: { batch: 7, index: 0 },
			},
		]);
	});

	it('emits a tool-output-error chunk for a bare failed outcome record', () => {
		const state = reduceConversationRecords(createReducedInstanceState(), toolUseConversation(), '6');
		const outcome: ConversationRecord = {
			...scope,
			id: 'record_outcome_slow',
			type: 'tool_outcome',
			timestamp: '2026-06-25T00:00:03.000Z',
			assistantMessageId: 'entry_assistant',
			toolCallId: 'call_slow',
			toolName: 'subtask',
			isError: true,
			content: [{ type: 'text', text: 'subtask failed' }],
		};
		applyConversationRecord(state, outcome);

		const chunks = projectAgentConversationBatch({ state, records: [outcome], batchOrdinal: 7 });

		expect(chunks).toEqual([
			{
				type: 'tool-output-error',
				conversationId: 'conv_01',
				toolCallId: 'call_slow',
				errorText: 'subtask failed',
				position: { batch: 7, index: 0 },
			},
		]);
	});

	it('still re-emits every outcome at the commit, so a consumer that attached mid-batch settles too', () => {
		const state = reduceConversationRecords(createReducedInstanceState(), toolUseConversation(), '6');
		applyConversationRecord(state, fastOutcome());
		const slowOutcome: ConversationRecord = {
			...scope,
			id: 'record_outcome_slow',
			type: 'tool_outcome',
			timestamp: '2026-06-25T00:00:09.000Z',
			assistantMessageId: 'entry_assistant',
			toolCallId: 'call_slow',
			toolName: 'subtask',
			isError: false,
			content: [{ type: 'text', text: 'slow result' }],
		};
		const commit: ConversationRecord = {
			...scope,
			id: 'record_commit',
			type: 'tool_results_committed',
			timestamp: '2026-06-25T00:00:09.100Z',
			assistantMessageId: 'entry_assistant',
			parentId: 'entry_assistant',
			outcomeIds: ['record_outcome_fast', 'record_outcome_slow'],
		};
		applyConversationRecord(state, slowOutcome);
		applyConversationRecord(state, commit);

		const chunks = projectAgentConversationBatch({
			state,
			records: [slowOutcome, commit],
			batchOrdinal: 8,
		});

		// The slow outcome projects once from its own record and once from the
		// commit; consumers replace the part by toolCallId, so the duplicate is
		// a no-op. The fast outcome sits in an earlier batch, so the commit
		// recovers it from the materialized entry.
		expect(
			chunks.map((chunk) => ({ type: chunk.type, toolCallId: (chunk as { toolCallId?: string }).toolCallId })),
		).toEqual([
			{ type: 'tool-output', toolCallId: 'call_slow' },
			{ type: 'tool-output', toolCallId: 'call_fast' },
			{ type: 'tool-output', toolCallId: 'call_slow' },
		]);
	});
});

describe('projectAgentConversationSnapshot()', () => {
	it('settles a part from a pending outcome, so a mid-batch snapshot shows the finished call', () => {
		const state = reduceConversationRecords(createReducedInstanceState(), toolUseConversation(), '6');
		applyConversationRecord(state, fastOutcome());

		const snapshot = projectAgentConversationSnapshot(state);
		const parts = (snapshot?.messages ?? []).flatMap((message) => message.parts);
		const fast = parts.find((part) => part.type === 'dynamic-tool' && part.toolCallId === 'call_fast');
		const slow = parts.find((part) => part.type === 'dynamic-tool' && part.toolCallId === 'call_slow');

		expect(fast).toEqual({
			type: 'dynamic-tool',
			toolName: 'lookup',
			toolCallId: 'call_fast',
			state: 'output-available',
			input: {},
			output: 'fast result',
			durationMs: 42,
		});
		expect(slow).toMatchObject({ state: 'input-available' });
	});
});
