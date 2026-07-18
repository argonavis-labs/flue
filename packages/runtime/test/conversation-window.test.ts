import { describe, expect, it } from 'vitest';
import type { ConversationRecord } from '../src/conversation-records.ts';
import { applyConversationRecord, createReducedInstanceState } from '../src/conversation-reducer.ts';
import { projectConversationUi } from '../src/conversation-projections.ts';

const scope = {
	v: 1 as const,
	conversationId: 'conv-1',
	harness: 'default',
	session: 'default',
	timestamp: '2026-01-01T00:00:00.000Z',
};

// N user turns; turn `k` optionally becomes an assistant tool-use turn whose
// tool result folds into it (group-boundary coverage).
function conversationWith(turns: number, toolTurn?: number): ReturnType<typeof createReducedInstanceState> {
	const state = createReducedInstanceState();
	const records: ConversationRecord[] = [
		{ ...scope, id: 'r-created', type: 'conversation_created', kind: 'root', affinityKey: 'a', createdAt: scope.timestamp },
	];
	let parentId: string | null = null;
	for (let turn = 0; turn < turns; turn++) {
		if (turn === toolTurn) {
			records.push(
				{ ...scope, id: `r-a-${turn}`, type: 'assistant_message_started', messageId: `entry_a_${turn}`, parentId, modelInfo: { api: 't', provider: 't', model: 'm' } },
				{ ...scope, id: `r-a-${turn}-text-start`, type: 'assistant_text_started', messageId: `entry_a_${turn}`, blockId: 'b0', blockIndex: 0 },
				{ ...scope, id: `r-a-${turn}-text-done`, type: 'assistant_text_completed', messageId: `entry_a_${turn}`, blockId: 'b0', deltaCount: 0 },
				{ ...scope, id: `r-a-${turn}-call`, type: 'assistant_tool_call', messageId: `entry_a_${turn}`, blockId: 'b1', blockIndex: 1, toolCallId: `call-${turn}`, name: 'lookup', arguments: {} },
				{ ...scope, id: `r-a-${turn}-done`, type: 'assistant_message_completed', messageId: `entry_a_${turn}`, stopReason: 'toolUse', usage: { input: 1, output: 1 } },
				{ ...scope, id: `r-o-${turn}`, type: 'tool_outcome', assistantMessageId: `entry_a_${turn}`, toolCallId: `call-${turn}`, toolName: 'lookup', isError: false, content: [{ type: 'text', text: 'ok' }] },
				{ ...scope, id: `r-c-${turn}`, type: 'tool_results_committed', assistantMessageId: `entry_a_${turn}`, parentId: `entry_a_${turn}`, outcomeIds: [`r-o-${turn}`] },
			);
			parentId = `entry_tool_result_${Buffer.from(`entry_a_${turn}`).toString('base64url')}_${Buffer.from(`call-${turn}`).toString('base64url')}`;
			continue;
		}
		records.push({
			...scope,
			id: `r-u-${turn}`,
			type: 'user_message',
			messageId: `entry_u_${turn}`,
			parentId,
			content: [{ type: 'text', text: `turn ${turn}` }],
		});
		parentId = `entry_u_${turn}`;
	}
	for (const record of records) applyConversationRecord(state, record as ConversationRecord, '1');
	return state;
}

function conversation(state: ReturnType<typeof createReducedInstanceState>) {
	const value = state.conversations.get('conv-1');
	if (!value) throw new Error('missing conversation');
	return value;
}

describe('windowed history projection (RUN-5220)', () => {
	it('serves the newest entries with a truncatedBefore cursor, and pages to genesis', () => {
		const state = conversationWith(10);
		const head = projectConversationUi(conversation(state), '9', { entryLimit: 4 });
		expect(head.messages.map((m) => m.id)).toEqual([
			'entry_u_6',
			'entry_u_7',
			'entry_u_8',
			'entry_u_9',
		]);
		expect(head.truncatedBefore).toBe('entry_u_6');

		const older = projectConversationUi(conversation(state), '9', {
			entryLimit: 4,
			beforeEntry: head.truncatedBefore,
		});
		expect(older.messages.map((m) => m.id)).toEqual([
			'entry_u_2',
			'entry_u_3',
			'entry_u_4',
			'entry_u_5',
		]);
		expect(older.truncatedBefore).toBe('entry_u_2');

		const oldest = projectConversationUi(conversation(state), '9', {
			entryLimit: 4,
			beforeEntry: older.truncatedBefore,
		});
		expect(oldest.messages.map((m) => m.id)).toEqual(['entry_u_0', 'entry_u_1']);
		expect(oldest.truncatedBefore).toBeUndefined();
	});

	it('never splits a tool-result run from its assistant: the boundary walks back', () => {
		// Turn 5 is assistant+tool-result (2 path entries). A window that would
		// start ON the tool-result entry must extend back to the assistant, and
		// the folded tool output must be resolved inside the window.
		const state = conversationWith(10, 5);
		// Path: u0..u4, a5, toolresult5, u6..u9 = 11 entries. entryLimit 5 would
		// start at toolresult5 — extension pulls in a5.
		const head = projectConversationUi(conversation(state), '9', { entryLimit: 5 });
		expect(head.messages.map((m) => m.id)).toEqual([
			'entry_a_5',
			'entry_u_6',
			'entry_u_7',
			'entry_u_8',
			'entry_u_9',
		]);
		const assistant = head.messages[0];
		const toolPart = assistant?.parts.find((part) => part.type === 'dynamic-tool');
		expect(toolPart).toMatchObject({ state: 'output-available' });
		expect(head.truncatedBefore).toBe('entry_a_5');
	});

	it('projects in-progress messages only on the head window', () => {
		const state = conversationWith(6);
		applyConversationRecord(state, {
			...scope,
			id: 'r-live',
			type: 'assistant_message_started',
			messageId: 'entry_live',
			parentId: 'entry_u_5',
			modelInfo: { api: 't', provider: 't', model: 'm' },
		} as ConversationRecord, '2');

		const head = projectConversationUi(conversation(state), '9', { entryLimit: 3 });
		expect(head.messages.some((m) => m.id === 'entry_live')).toBe(true);

		const older = projectConversationUi(conversation(state), '9', {
			entryLimit: 3,
			beforeEntry: head.truncatedBefore,
		});
		expect(older.messages.some((m) => m.id === 'entry_live')).toBe(false);
	});

	it('an unknown beforeEntry yields an empty terminal page, not an error', () => {
		const state = conversationWith(4);
		const page = projectConversationUi(conversation(state), '9', {
			entryLimit: 3,
			beforeEntry: 'entry_nonexistent',
		});
		expect(page.messages).toEqual([]);
		expect(page.truncatedBefore).toBeUndefined();
	});

	it('an unwindowed projection is unchanged (back-compat)', () => {
		const state = conversationWith(5);
		const full = projectConversationUi(conversation(state), '9');
		expect(full.messages).toHaveLength(5);
		expect(full.truncatedBefore).toBeUndefined();
	});
});
