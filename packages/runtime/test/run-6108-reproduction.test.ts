import {
	type AssistantMessageEventStream,
	fauxAssistantMessage,
	registerApiProvider,
	registerFauxProvider,
	unregisterApiProviders,
} from '@earendil-works/pi-ai/compat';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationRecordWriter } from '../src/conversation-writer.ts';
import { defineAgent } from '../src/index.ts';
import {
	createFlueContext,
	InMemoryAttachmentStore,
	InMemoryConversationStreamStore,
} from '../src/internal.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

const providerSources: string[] = [];
const providerRegistrations: Array<{ unregister(): void }> = [];

afterEach(() => {
	for (const source of providerSources.splice(0)) unregisterApiProviders(source);
	for (const provider of providerRegistrations.splice(0)) provider.unregister();
});

describe('RUN-6108 reproduction', () => {
	// This assertion intentionally describes the bug on the PR #52 base commit.
	// See scripts/run-6108-repro/README.md for the expected post-fix assertions.
	it('poisons the next prompt when a model stream throws after assistant output starts', async () => {
		const provider = registerFauxProvider({
			provider: `run-6108-reproduction-${crypto.randomUUID()}`,
			models: [{ id: 'reviewer' }],
		});
		providerRegistrations.push(provider);
		const model = provider.getModel('reviewer');
		if (!model) throw new Error('Expected reviewer model.');

		let streamCalls = 0;
		const sourceId = `run-6108-stream-${crypto.randomUUID()}`;
		providerSources.push(sourceId);
		const stream = () => {
			streamCalls += 1;
			const message = {
				...fauxAssistantMessage(streamCalls === 1 ? 'Partial' : 'Recovered response.'),
				api: model.api,
				provider: model.provider,
				model: model.id,
			};
			if (streamCalls === 1) {
				const started = { ...message, content: [] };
				const textStarted = { ...message, content: [{ type: 'text' as const, text: '' }] };
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: 'start' as const, partial: started };
						yield { type: 'text_start' as const, contentIndex: 0, partial: textStarted };
						yield {
							type: 'text_delta' as const,
							contentIndex: 0,
							delta: 'Partial',
							partial: message,
						};
						throw new Error('simulated mid-stream failure');
					},
					async result() {
						return message;
					},
				} as unknown as AssistantMessageEventStream;
			}
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: 'done' as const, reason: 'stop' as const, message };
				},
				async result() {
					return message;
				},
			} as unknown as AssistantMessageEventStream;
		};
		registerApiProvider({ api: provider.api, stream, streamSimple: stream }, sourceId);

		const store = new InMemoryConversationStreamStore();
		const writer = await ConversationRecordWriter.create({
			store,
			path: 'agents/assistant/run-6108-instance',
			identity: { agentName: 'assistant', instanceId: 'run-6108-instance' },
			producerId: 'producer-1',
		});
		const ctx = createFlueContext({
			id: 'run-6108-instance',
			env: {},
			agentConfig: { resolveModel: () => model },
			createDefaultEnv: async () => createNoopSessionEnv(),
			conversationWriter: writer,
			attachmentStore: new InMemoryAttachmentStore(),
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${model.provider}/${model.id}` })),
		);
		const session = await harness.session();

		await expect(session.prompt('Start a response.')).rejects.toThrow(
			'simulated mid-stream failure',
		);

		const poisoned = await writer.findConversation('default', 'default');
		expect(poisoned?.inProgressMessages.size).toBe(1);
		await expect(session.prompt('Try again.')).rejects.toThrowError(
			expect.objectContaining({
				type: 'conversation_record_invariant',
				meta: expect.objectContaining({
					reason: 'Cannot advance the conversation while an assistant message is in progress.',
				}),
			}),
		);
		expect(streamCalls).toBe(1);
	});
});
