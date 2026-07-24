import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	registerFauxProvider,
} from '@earendil-works/pi-ai/compat';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentExecutionStore, SubmissionAttemptRef } from '../src/agent-execution-store.ts';
import type { ConversationRecord } from '../src/conversation-records.ts';
import { ConversationRecordWriter } from '../src/conversation-writer.ts';
import { defineAgent } from '../src/index.ts';
import { createFlueContext, InMemoryAttachmentStore, InMemoryConversationStreamStore } from '../src/internal.ts';
import { sqlite } from '../src/node/agent-execution-store.ts';
import {
	type AgentSubmissionInput,
	type AgentSubmissionSettlement,
	processSubmission,
	reconcileInterruptedSubmission,
	submissionSyntheticRequest,
} from '../src/runtime/agent-submissions.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

const providers: FauxProviderRegistration[] = [];

afterEach(() => {
	for (const provider of providers.splice(0)) provider.unregister();
});

function createProvider(): FauxProviderRegistration {
	const provider = registerFauxProvider({
		provider: `agent-submissions-test-${crypto.randomUUID()}`,
		models: [{ id: 'reviewer' }],
	});
	providers.push(provider);
	return provider;
}

async function openExecutionStore(): Promise<AgentExecutionStore> {
	const adapter = sqlite();
	await adapter.migrate?.();
	const { executionStore } = await adapter.connect();
	return executionStore;
}

const INPUT: AgentSubmissionInput = {
	kind: 'direct',
	submissionId: 'direct-1',
	agent: 'assistant',
	id: 'agent-1',
	message: { kind: 'user', body: 'Continue' },
	acceptedAt: '2026-06-03T00:00:00.000Z',
};

// submissionEntryId('direct', 'direct-1')
const INPUT_ENTRY_ID = 'entry_direct_ZGlyZWN0LTE';

async function seedContinuableConversation(
	writer: ConversationRecordWriter,
	provider: FauxProviderRegistration,
): Promise<void> {
	const timestamp = new Date().toISOString();
	const envelope = {
		v: 1 as const,
		conversationId: 'conversation-1',
		harness: 'default',
		session: 'default',
		timestamp,
		submissionId: 'direct-1',
		attemptId: 'attempt-1',
	};
	await writer.append([
		{
			v: 1,
			id: 'record-created',
			type: 'conversation_created',
			kind: 'root',
			conversationId: 'conversation-1',
			harness: 'default',
			session: 'default',
			timestamp,
			affinityKey: 'affinity-1',
			createdAt: timestamp,
		},
		{
			...envelope,
			id: 'record_direct_input_direct-1',
			type: 'user_message',
			messageId: INPUT_ENTRY_ID,
			parentId: null,
			content: [{ type: 'text', text: 'Continue' }],
		},
		{
			...envelope,
			id: 'record-assistant-started',
			type: 'assistant_message_started',
			turnId: 'turn-1',
			messageId: 'entry_partial',
			parentId: INPUT_ENTRY_ID,
			modelInfo: { api: 'faux', provider: provider.getModel().provider, model: 'reviewer' },
		},
		{
			...envelope,
			id: 'record-text-started',
			type: 'assistant_text_started',
			messageId: 'entry_partial',
			blockId: 'block_partial',
			blockIndex: 0,
		},
		{
			...envelope,
			id: 'record-text-delta',
			type: 'assistant_text_delta',
			messageId: 'entry_partial',
			blockId: 'block_partial',
			sequence: 0,
			delta: 'Partial',
		},
	], { submission: { submissionId: 'direct-1', attemptId: 'attempt-1' } });
}

async function seedRunningSubmission(store: AgentExecutionStore): Promise<void> {
	await store.submissions.admitDirect(INPUT);
	await store.submissions.markSubmissionCanonicalReady('direct-1');
	await store.submissions.claimSubmission({
		submissionId: 'direct-1',
		attemptId: 'attempt-1',
		ownerId: 'test-owner',
		leaseExpiresAt: 0,
	});
	await store.submissions.markSubmissionInputApplied(
		{ submissionId: 'direct-1', attemptId: 'attempt-1' },
		{ maxRetry: 5, timeoutAt: Date.now() + 60_000 },
	);
}

function makeContextFactory(
	provider: FauxProviderRegistration,
	writer: ConversationRecordWriter,
) {
	return (dispatchId: string | undefined) =>
		createFlueContext({
			id: 'agent-1',
			dispatchId,
			env: {},
			req: submissionSyntheticRequest(INPUT),
			agentConfig: { resolveModel: () => provider.getModel('reviewer') },
			createDefaultEnv: async () => createNoopSessionEnv(),
			conversationWriter: writer,
			attachmentStore: new InMemoryAttachmentStore(),
		});
}

const AGENT = defineAgent(() => ({ model: 'unused/reviewer' }));

describe('reconcileInterruptedSubmission()', () => {
	it('guards the replacement attempt when recovery appends its records', async () => {
		const provider = createProvider();
		const store = await openExecutionStore();
		const writer = await ConversationRecordWriter.create({
			store: new InMemoryConversationStreamStore(),
			path: 'agents/assistant/agent-1',
			identity: { agentName: 'assistant', instanceId: 'agent-1' },
			producerId: 'producer-1',
		});
		await seedContinuableConversation(writer, provider);
		await seedRunningSubmission(store);
		const submission = await store.submissions.getSubmission('direct-1');
		if (!submission) throw new Error('Expected a running submission.');
		const recoveredEntryId = 'entry_recovery_entry_partial_stream_continued';
		const acquired: Array<{ attempt: SubmissionAttemptRef; recovered: boolean }> = [];
		const released: SubmissionAttemptRef[] = [];

		const replacement = await reconcileInterruptedSubmission(
			store.submissions,
			submission,
			AGENT,
			makeContextFactory(provider, writer),
			{ ownerId: 'test-owner', leaseExpiresAt: 0 },
			writer,
			{
				acquire: async (attempt) => {
					acquired.push({
						attempt,
						recovered: await writer.hasConversationEntry('conversation-1', recoveredEntryId),
					});
					await store.submissions.insertAttemptMarker(attempt);
				},
				release: async (attempt) => {
					released.push(attempt);
					await store.submissions.deleteAttemptMarker(attempt);
				},
			},
		);

		expect(replacement?.attemptId).toBeDefined();
		expect(replacement?.attemptId).not.toBe('attempt-1');
		expect(acquired).toEqual([
			{ attempt: { submissionId: 'direct-1', attemptId: replacement?.attemptId }, recovered: false },
		]);
		expect(released).toEqual([]);
		expect(await writer.hasConversationEntry('conversation-1', recoveredEntryId)).toBe(true);
		expect(await store.submissions.listAttemptMarkers()).toEqual([
			expect.objectContaining({ submissionId: 'direct-1', attemptId: replacement?.attemptId }),
		]);
	});

	it('releases the attempt guard when recovery throws', async () => {
		const provider = createProvider();
		const store = await openExecutionStore();
		const writer = await ConversationRecordWriter.create({
			store: new InMemoryConversationStreamStore(),
			path: 'agents/assistant/agent-1',
			identity: { agentName: 'assistant', instanceId: 'agent-1' },
			producerId: 'producer-1',
		});
		await seedContinuableConversation(writer, provider);
		await seedRunningSubmission(store);
		const submission = await store.submissions.getSubmission('direct-1');
		if (!submission) throw new Error('Expected a running submission.');
		const failingWriter = new Proxy(writer, {
			get(target, property) {
				if (property === 'append') {
					return (records: readonly ConversationRecord[], appendOptions?: unknown) => {
						if (records.some((record) => record.id.startsWith('record_recovery_'))) {
							return Promise.reject(new Error('injected recovery append failure'));
						}
						return target.append(records, appendOptions as never);
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		const released: SubmissionAttemptRef[] = [];

		await expect(
			reconcileInterruptedSubmission(
				store.submissions,
				submission,
				AGENT,
				makeContextFactory(provider, failingWriter),
				{ ownerId: 'test-owner', leaseExpiresAt: 0 },
				failingWriter,
				{
					acquire: (attempt) => store.submissions.insertAttemptMarker(attempt),
					release: async (attempt) => {
						released.push(attempt);
						await store.submissions.deleteAttemptMarker(attempt);
					},
				},
			),
		).rejects.toThrow('injected recovery append failure');

		const replaced = await store.submissions.getSubmission('direct-1');
		expect(released).toEqual([
			{ submissionId: 'direct-1', attemptId: replaced?.attemptId },
		]);
		expect(await store.submissions.listAttemptMarkers()).toEqual([]);
	});

	it('releases the attempt guard when the input-marker repair throws', async () => {
		const provider = createProvider();
		const store = await openExecutionStore();
		const writer = await ConversationRecordWriter.create({
			store: new InMemoryConversationStreamStore(),
			path: 'agents/assistant/agent-1',
			identity: { agentName: 'assistant', instanceId: 'agent-1' },
			producerId: 'producer-1',
		});
		await seedContinuableConversation(writer, provider);
		await store.submissions.admitDirect(INPUT);
		await store.submissions.markSubmissionCanonicalReady('direct-1');
		await store.submissions.claimSubmission({
			submissionId: 'direct-1',
			attemptId: 'attempt-1',
			ownerId: 'test-owner',
			leaseExpiresAt: 0,
		});
		const submission = await store.submissions.getSubmission('direct-1');
		if (!submission) throw new Error('Expected a running submission.');
		const failingSubmissions = new Proxy(store.submissions, {
			get(target, property) {
				if (property === 'markSubmissionInputApplied') {
					return () => Promise.reject(new Error('injected input-marker failure'));
				}
				const value = Reflect.get(target, property, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		const released: SubmissionAttemptRef[] = [];

		await expect(
			reconcileInterruptedSubmission(
				failingSubmissions,
				submission,
				AGENT,
				makeContextFactory(provider, writer),
				{ ownerId: 'test-owner', leaseExpiresAt: 0 },
				writer,
				{
					acquire: (attempt) => store.submissions.insertAttemptMarker(attempt),
					release: async (attempt) => {
						released.push(attempt);
						await store.submissions.deleteAttemptMarker(attempt);
					},
				},
			),
		).rejects.toThrow('injected input-marker failure');

		const replaced = await store.submissions.getSubmission('direct-1');
		expect(replaced?.attemptId).not.toBe('attempt-1');
		expect(released).toEqual([
			{ submissionId: 'direct-1', attemptId: replaced?.attemptId },
		]);
		expect(await store.submissions.listAttemptMarkers()).toEqual([]);
	});

	it('releases the attempt guard when creating the recovery context throws', async () => {
		const provider = createProvider();
		const store = await openExecutionStore();
		const writer = await ConversationRecordWriter.create({
			store: new InMemoryConversationStreamStore(),
			path: 'agents/assistant/agent-1',
			identity: { agentName: 'assistant', instanceId: 'agent-1' },
			producerId: 'producer-1',
		});
		await seedContinuableConversation(writer, provider);
		await seedRunningSubmission(store);
		const submission = await store.submissions.getSubmission('direct-1');
		if (!submission) throw new Error('Expected a running submission.');
		const contextFactory = makeContextFactory(provider, writer);
		let contextCalls = 0;
		const released: SubmissionAttemptRef[] = [];

		await expect(
			reconcileInterruptedSubmission(
				store.submissions,
				submission,
				AGENT,
				(dispatchId) => {
					contextCalls += 1;
					// The first context serves the inspection pass; the second is the recovery context.
					if (contextCalls > 1) throw new Error('injected context failure');
					return contextFactory(dispatchId);
				},
				{ ownerId: 'test-owner', leaseExpiresAt: 0 },
				writer,
				{
					acquire: (attempt) => store.submissions.insertAttemptMarker(attempt),
					release: async (attempt) => {
						released.push(attempt);
						await store.submissions.deleteAttemptMarker(attempt);
					},
				},
			),
		).rejects.toThrow('injected context failure');

		const replaced = await store.submissions.getSubmission('direct-1');
		expect(released).toEqual([
			{ submissionId: 'direct-1', attemptId: replaced?.attemptId },
		]);
		expect(await store.submissions.listAttemptMarkers()).toEqual([]);
	});

	it('reports the aborted settlement to the onSettled callback', async () => {
		const provider = createProvider();
		const store = await openExecutionStore();
		const writer = await ConversationRecordWriter.create({
			store: new InMemoryConversationStreamStore(),
			path: 'agents/assistant/agent-1',
			identity: { agentName: 'assistant', instanceId: 'agent-1' },
			producerId: 'producer-1',
		});
		await seedContinuableConversation(writer, provider);
		await seedRunningSubmission(store);
		const running = await store.submissions.getSubmission('direct-1');
		if (!running) throw new Error('Expected a running submission.');
		await store.submissions.requestSessionAbort(running.sessionKey);
		const submission = await store.submissions.getSubmission('direct-1');
		if (!submission) throw new Error('Expected the abort-stamped submission.');
		const settlements: AgentSubmissionSettlement[] = [];

		await reconcileInterruptedSubmission(
			store.submissions,
			submission,
			AGENT,
			makeContextFactory(provider, writer),
			{ ownerId: 'test-owner', leaseExpiresAt: 0 },
			writer,
			undefined,
			(settlement) => settlements.push(settlement),
		);

		expect(await store.submissions.getSubmission('direct-1')).toMatchObject({
			status: 'settled',
		});
		expect(settlements).toEqual([
			{
				submissionId: 'direct-1',
				outcome: 'aborted',
				attemptCount: 1,
				error: expect.any(String),
			},
		]);
	});
});

describe('processSubmission()', () => {
	it('finalizes the direct settlement before publishing the settled event', async () => {
		const provider = createProvider();
		provider.setResponses([fauxAssistantMessage('Done.')]);
		const store = await openExecutionStore();
		const writer = await ConversationRecordWriter.create({
			store: new InMemoryConversationStreamStore(),
			path: 'agents/assistant/agent-1',
			identity: { agentName: 'assistant', instanceId: 'agent-1' },
			producerId: 'producer-1',
		});
		await seedContinuableConversation(writer, provider);
		await seedRunningSubmission(store);
		const submission = await store.submissions.getSubmission('direct-1');
		if (!submission) throw new Error('Expected a running submission.');
		const order: string[] = [];
		const settlements: Array<AgentSubmissionSettlement | undefined> = [];
		const instrumentedSubmissions = new Proxy(store.submissions, {
			get(target, property) {
				if (property === 'finalizeSubmissionSettlement') {
					return async (...args: Parameters<typeof target.finalizeSubmissionSettlement>) => {
						order.push('finalize');
						return target.finalizeSubmissionSettlement(...args);
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		const contextFactory = makeContextFactory(provider, writer);

		await processSubmission({
			submissions: instrumentedSubmissions,
			submission,
			resolveAgent: () => AGENT,
			createContext: (dispatchId) => {
				const ctx = contextFactory(dispatchId);
				const originalPublish = ctx.publishEvent.bind(ctx);
				ctx.publishEvent = (event) => {
					if ((event as { type?: string }).type === 'submission_settled') order.push('publish');
					return originalPublish(event);
				};
				return ctx;
			},
			conversationWriter: writer,
			onSettled: (settlement) => settlements.push(settlement),
		});

		expect(await store.submissions.getSubmission('direct-1')).toMatchObject({
			status: 'settled',
		});
		expect(order).toEqual(['finalize', 'publish']);
		expect(settlements).toEqual([
			{ submissionId: 'direct-1', outcome: 'completed', attemptCount: 1 },
		]);
	});
});
