import { describe, expect, it } from 'vitest';
import type { ConversationRecord } from '../src/conversation-records.ts';
import { applyConversationRecord, createReducedInstanceState } from '../src/conversation-reducer.ts';
import { projectConversationModelContext, projectConversationUi } from '../src/conversation-projections.ts';

const scope = {
	v: 1 as const,
	conversationId: 'conv-1',
	harness: 'default',
	session: 'default',
	timestamp: '2026-07-22T00:00:00.000Z',
};

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function buildState(records: ConversationRecord[]) {
	const state = createReducedInstanceState();
	for (let i = 0; i < records.length; i++) {
		applyConversationRecord(state, records[i] as ConversationRecord, String(i + 1));
	}
	return state;
}

function conversation(state: ReturnType<typeof createReducedInstanceState>) {
	const value = state.conversations.get('conv-1');
	if (!value) throw new Error('missing conversation');
	return value;
}

function toolResultEntryId(assistantMessageId: string, toolCallId: string) {
	return `entry_tool_result_${Buffer.from(assistantMessageId).toString('base64url')}_${Buffer.from(toolCallId).toString('base64url')}`;
}

describe('compaction UI projection (RUN-5527)', () => {
	it('projects a compaction entry as a typed visible advisory boundary at its canonical position', () => {
		const state = buildState([
			{ ...scope, id: 'r-created', type: 'conversation_created', kind: 'root', affinityKey: 'a', createdAt: scope.timestamp },
			{ ...scope, id: 'r-user-1', type: 'user_message', messageId: 'entry_user_1', parentId: null, content: [{ type: 'text', text: 'hello' }] },
			{ ...scope, id: 'r-assistant-start', type: 'assistant_message_started', messageId: 'entry_assistant', parentId: 'entry_user_1', modelInfo: { api: 'test', provider: 'test', model: 'test-model' } },
			{ ...scope, id: 'r-text-start', type: 'assistant_text_started', messageId: 'entry_assistant', blockId: 'b0', blockIndex: 0 },
			{ ...scope, id: 'r-text-done', type: 'assistant_text_completed', messageId: 'entry_assistant', blockId: 'b0', deltaCount: 0 },
			{ ...scope, id: 'r-assistant-done', type: 'assistant_message_completed', messageId: 'entry_assistant', stopReason: 'stop', usage },
			{
				...scope,
				id: 'r-compaction',
				type: 'compaction',
				entryId: 'entry_compaction',
				parentId: 'entry_assistant',
				sourceLeafId: 'entry_assistant',
				firstKeptEntryId: 'entry_assistant',
				summary: 'compaction summary body',
				tokensBefore: 12,
				usage,
			},
			{ ...scope, id: 'r-user-2', type: 'user_message', messageId: 'entry_user_2', parentId: 'entry_compaction', content: [{ type: 'text', text: 'follow up' }] },
		]);

		const snapshot = projectConversationUi(conversation(state), '99');

		expect(snapshot.messages.map((m) => m.id)).toEqual([
			'entry_user_1',
			'entry_assistant',
			'entry_compaction',
			'entry_user_2',
		]);

		const compaction = snapshot.messages.find((m) => m.id === 'entry_compaction');
		expect(compaction).toEqual({
			id: 'entry_compaction',
			role: 'system',
			purpose: 'advisory',
			display: 'visible',
			signal: { tagName: 'compaction' },
			parts: [],
			metadata: { timestamp: scope.timestamp },
		});
	});

	it('orders multiple compaction entries at their canonical positions in durable history', () => {
		const state = buildState([
			{ ...scope, id: 'r-created', type: 'conversation_created', kind: 'root', affinityKey: 'a', createdAt: scope.timestamp },
			{ ...scope, id: 'r-user-1', type: 'user_message', messageId: 'entry_user_1', parentId: null, content: [{ type: 'text', text: 'a' }] },
			{ ...scope, id: 'r-a1-start', type: 'assistant_message_started', messageId: 'entry_assistant_1', parentId: 'entry_user_1', modelInfo: { api: 'test', provider: 'test', model: 'm' } },
			{ ...scope, id: 'r-a1-text-start', type: 'assistant_text_started', messageId: 'entry_assistant_1', blockId: 'b0', blockIndex: 0 },
			{ ...scope, id: 'r-a1-text-done', type: 'assistant_text_completed', messageId: 'entry_assistant_1', blockId: 'b0', deltaCount: 0 },
			{ ...scope, id: 'r-a1-done', type: 'assistant_message_completed', messageId: 'entry_assistant_1', stopReason: 'stop', usage },
			{
				...scope,
				id: 'r-compaction-1',
				type: 'compaction',
				entryId: 'entry_compaction_1',
				parentId: 'entry_assistant_1',
				sourceLeafId: 'entry_assistant_1',
				firstKeptEntryId: 'entry_assistant_1',
				summary: 'first summary',
				tokensBefore: 12,
			},
			{ ...scope, id: 'r-user-2', type: 'user_message', messageId: 'entry_user_2', parentId: 'entry_compaction_1', content: [{ type: 'text', text: 'b' }] },
			{ ...scope, id: 'r-a2-start', type: 'assistant_message_started', messageId: 'entry_assistant_2', parentId: 'entry_user_2', modelInfo: { api: 'test', provider: 'test', model: 'm' } },
			{ ...scope, id: 'r-a2-text-start', type: 'assistant_text_started', messageId: 'entry_assistant_2', blockId: 'b0', blockIndex: 0 },
			{ ...scope, id: 'r-a2-text-done', type: 'assistant_text_completed', messageId: 'entry_assistant_2', blockId: 'b0', deltaCount: 0 },
			{ ...scope, id: 'r-a2-done', type: 'assistant_message_completed', messageId: 'entry_assistant_2', stopReason: 'stop', usage },
			{
				...scope,
				id: 'r-compaction-2',
				type: 'compaction',
				entryId: 'entry_compaction_2',
				parentId: 'entry_assistant_2',
				sourceLeafId: 'entry_assistant_2',
				firstKeptEntryId: 'entry_assistant_2',
				summary: 'second summary',
				tokensBefore: 24,
			},
			{ ...scope, id: 'r-user-3', type: 'user_message', messageId: 'entry_user_3', parentId: 'entry_compaction_2', content: [{ type: 'text', text: 'c' }] },
		]);

		const snapshot = projectConversationUi(conversation(state), '99');

		expect(snapshot.messages.map((m) => m.id)).toEqual([
			'entry_user_1',
			'entry_assistant_1',
			'entry_compaction_1',
			'entry_user_2',
			'entry_assistant_2',
			'entry_compaction_2',
			'entry_user_3',
		]);
	});

	it('does not expose the compaction summary body to UI consumers', () => {
		const secretSummary = 'UNIQUE_SECRET_COMPACTION_SUMMARY_42';
		const state = buildState([
			{ ...scope, id: 'r-created', type: 'conversation_created', kind: 'root', affinityKey: 'a', createdAt: scope.timestamp },
			{ ...scope, id: 'r-user-1', type: 'user_message', messageId: 'entry_user_1', parentId: null, content: [{ type: 'text', text: 'hello' }] },
			{ ...scope, id: 'r-assistant-start', type: 'assistant_message_started', messageId: 'entry_assistant', parentId: 'entry_user_1', modelInfo: { api: 'test', provider: 'test', model: 'test-model' } },
			{ ...scope, id: 'r-text-start', type: 'assistant_text_started', messageId: 'entry_assistant', blockId: 'b0', blockIndex: 0 },
			{ ...scope, id: 'r-text-done', type: 'assistant_text_completed', messageId: 'entry_assistant', blockId: 'b0', deltaCount: 0 },
			{ ...scope, id: 'r-assistant-done', type: 'assistant_message_completed', messageId: 'entry_assistant', stopReason: 'stop', usage },
			{
				...scope,
				id: 'r-compaction',
				type: 'compaction',
				entryId: 'entry_compaction',
				parentId: 'entry_assistant',
				sourceLeafId: 'entry_assistant',
				firstKeptEntryId: 'entry_assistant',
				summary: secretSummary,
				tokensBefore: 12,
				usage,
			},
			{ ...scope, id: 'r-user-2', type: 'user_message', messageId: 'entry_user_2', parentId: 'entry_compaction', content: [{ type: 'text', text: 'follow up' }] },
		]);

		const conv = conversation(state);
		const snapshot = projectConversationUi(conv, '99');

		const compaction = snapshot.messages.find((m) => m.id === 'entry_compaction');
		expect(compaction).toBeDefined();
		expect(compaction?.parts).toEqual([]);
		expect(compaction?.signal).toEqual({ tagName: 'compaction' });

		const snapshotJson = JSON.stringify(snapshot.messages);
		expect(snapshotJson).not.toContain(secretSummary);

		// Model context must still receive the full summary so prompt behavior is unchanged.
		const contextJson = JSON.stringify(projectConversationModelContext(conv));
		expect(contextJson).toContain(secretSummary);
	});

	it('preserves window pagination semantics around compaction entries', () => {
		const state = buildState([
			{ ...scope, id: 'r-created', type: 'conversation_created', kind: 'root', affinityKey: 'a', createdAt: scope.timestamp },
			{ ...scope, id: 'r-user-1', type: 'user_message', messageId: 'entry_user_1', parentId: null, content: [{ type: 'text', text: 'a' }] },
			{ ...scope, id: 'r-assistant-start', type: 'assistant_message_started', messageId: 'entry_assistant', parentId: 'entry_user_1', modelInfo: { api: 'test', provider: 'test', model: 'test-model' } },
			{ ...scope, id: 'r-text-start', type: 'assistant_text_started', messageId: 'entry_assistant', blockId: 'b0', blockIndex: 0 },
			{ ...scope, id: 'r-text-done', type: 'assistant_text_completed', messageId: 'entry_assistant', blockId: 'b0', deltaCount: 0 },
			{ ...scope, id: 'r-assistant-done', type: 'assistant_message_completed', messageId: 'entry_assistant', stopReason: 'stop', usage },
			{
				...scope,
				id: 'r-compaction',
				type: 'compaction',
				entryId: 'entry_compaction',
				parentId: 'entry_assistant',
				sourceLeafId: 'entry_assistant',
				firstKeptEntryId: 'entry_assistant',
				summary: 'summary',
				tokensBefore: 12,
			},
			{ ...scope, id: 'r-user-2', type: 'user_message', messageId: 'entry_user_2', parentId: 'entry_compaction', content: [{ type: 'text', text: 'b' }] },
		]);

		const conv = conversation(state);

		const head = projectConversationUi(conv, '99', { entryLimit: 2 });
		expect(head.messages.map((m) => m.id)).toEqual(['entry_compaction', 'entry_user_2']);
		expect(head.truncatedBefore).toBe('entry_compaction');

		const older = projectConversationUi(conv, '99', { entryLimit: 2, beforeEntry: head.truncatedBefore });
		expect(older.messages.map((m) => m.id)).toEqual(['entry_user_1', 'entry_assistant']);
		expect(older.truncatedBefore).toBeUndefined();
	});

	it('preserves tool-result folding across a compaction boundary', () => {
		const toolCallId = 'call_lookup';
		const toolResultId = toolResultEntryId('entry_assistant', toolCallId);
		const state = buildState([
			{ ...scope, id: 'r-created', type: 'conversation_created', kind: 'root', affinityKey: 'a', createdAt: scope.timestamp },
			{ ...scope, id: 'r-user-1', type: 'user_message', messageId: 'entry_user_1', parentId: null, content: [{ type: 'text', text: 'lookup' }] },
			{ ...scope, id: 'r-assistant-start', type: 'assistant_message_started', messageId: 'entry_assistant', parentId: 'entry_user_1', modelInfo: { api: 'test', provider: 'test', model: 'test-model' } },
			{ ...scope, id: 'r-text-start', type: 'assistant_text_started', messageId: 'entry_assistant', blockId: 'b0', blockIndex: 0 },
			{ ...scope, id: 'r-text-done', type: 'assistant_text_completed', messageId: 'entry_assistant', blockId: 'b0', deltaCount: 0 },
			{ ...scope, id: 'r-tool-call', type: 'assistant_tool_call', messageId: 'entry_assistant', blockId: 'b1', blockIndex: 1, toolCallId, name: 'lookup', arguments: {} },
			{ ...scope, id: 'r-assistant-done', type: 'assistant_message_completed', messageId: 'entry_assistant', stopReason: 'toolUse', usage },
			{ ...scope, id: 'r-tool-outcome', type: 'tool_outcome', assistantMessageId: 'entry_assistant', toolCallId, toolName: 'lookup', isError: false, content: [{ type: 'text', text: 'found it' }] },
			{ ...scope, id: 'r-tool-commit', type: 'tool_results_committed', assistantMessageId: 'entry_assistant', parentId: 'entry_assistant', outcomeIds: ['r-tool-outcome'] },
			{
				...scope,
				id: 'r-compaction',
				type: 'compaction',
				entryId: 'entry_compaction',
				parentId: toolResultId,
				sourceLeafId: toolResultId,
				firstKeptEntryId: toolResultId,
				summary: 'summary',
				tokensBefore: 12,
			},
			{ ...scope, id: 'r-user-2', type: 'user_message', messageId: 'entry_user_2', parentId: 'entry_compaction', content: [{ type: 'text', text: 'next' }] },
		]);

		const snapshot = projectConversationUi(conversation(state), '99');

		expect(snapshot.messages.map((m) => m.id)).toEqual([
			'entry_user_1',
			'entry_assistant',
			'entry_compaction',
			'entry_user_2',
		]);

		const assistant = snapshot.messages.find((m) => m.id === 'entry_assistant');
		const toolPart = assistant?.parts.find((part) => part.type === 'dynamic-tool');
		expect(toolPart).toMatchObject({ state: 'output-available', output: 'found it' });
	});
});
