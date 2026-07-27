import { describe, expect, it } from 'vitest';
import { ConversationRecordWriter } from '../src/conversation-writer.ts';
import { ensureRootSubmissionConversation } from '../src/runtime/agent-submissions.ts';
import { InMemoryConversationStreamStore } from '../src/runtime/conversation-stream-store.ts';
import { agentStreamPath } from '../src/runtime/event-stream-store.ts';

// A submission commits its input on the materialize pass, which must create the
// default-harness root conversation exactly once — the same conversation the
// process pass then reuses — without initializing a turn. `ensureRootSubmissionConversation`
// is that seam (also reused by out-of-turn signal appends), so its create-once
// contract is what keeps the durable write exactly-once across re-materialize.
async function makeWriter(): Promise<ConversationRecordWriter> {
	return ConversationRecordWriter.create({
		store: new InMemoryConversationStreamStore(),
		path: agentStreamPath('assistant', 'agent-1'),
		identity: { agentName: 'assistant', instanceId: 'agent-1' },
		producerId: 'test-producer',
	});
}

describe('ensureRootSubmissionConversation()', () => {
	it('creates the default-harness root conversation when none exists yet', async () => {
		const writer = await makeWriter();
		expect(await writer.findConversation('default', 'default')).toBeUndefined();

		const conversation = await ensureRootSubmissionConversation(writer);

		expect(conversation).toMatchObject({ harness: 'default', session: 'default' });
		expect(await writer.findConversation('default', 'default')).toMatchObject({
			conversationId: conversation.conversationId,
		});
	});

	it('returns the existing root conversation without creating a second when called again', async () => {
		const writer = await makeWriter();
		const first = await ensureRootSubmissionConversation(writer);
		const second = await ensureRootSubmissionConversation(writer);

		expect(second.conversationId).toBe(first.conversationId);
		const roots = [...(await writer.loadReducedState()).conversations.values()].filter(
			(conversation) => conversation.harness === 'default' && conversation.session === 'default',
		);
		expect(roots).toHaveLength(1);
	});
});
