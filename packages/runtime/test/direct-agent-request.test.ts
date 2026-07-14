import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from '@earendil-works/pi-ai/compat';
import { afterEach, describe, expect, it } from 'vitest';
import { InvalidRequestError } from '../src/errors.ts';
import { defineAgent, defineTool } from '../src/index.ts';
import { createFlueContext } from '../src/internal.ts';
import { createDirectAgentSubmissionInput } from '../src/runtime/agent-submissions.ts';
import { parseDirectAgentRequest } from '../src/runtime/schemas.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

function captureThrow(fn: () => unknown): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	throw new Error('Expected the call to throw.');
}

describe('parseDirectAgentRequest()', () => {
	it('separates a client-supplied submissionId from a user message', () => {
		const result = parseDirectAgentRequest({
			kind: 'user',
			body: 'Hello.',
			submissionId: 'client-submission-1',
		});

		expect(result.submissionId).toBe('client-submission-1');
		expect(result.message).toEqual({ kind: 'user', body: 'Hello.' });
	});

	it('separates a client-supplied submissionId from a signal message', () => {
		const result = parseDirectAgentRequest({
			kind: 'signal',
			type: 'calendar_event',
			body: 'The meeting moved.',
			submissionId: 'client-submission-2',
		});

		expect(result.submissionId).toBe('client-submission-2');
		expect(result.message).toEqual({
			kind: 'signal',
			type: 'calendar_event',
			body: 'The meeting moved.',
		});
	});

	it('omits submissionId entirely when the body does not carry one', () => {
		const result = parseDirectAgentRequest({ kind: 'user', body: 'Hello.' });

		expect(result.message).toEqual({ kind: 'user', body: 'Hello.' });
		expect('submissionId' in result).toBe(false);
	});

	// An invalid submissionId must reject the request, not fall back to the
	// plain message parse: silently dropping the id makes the server mint a
	// fresh one per retry, admitting the duplicate turn the stable id prevents.
	it('rejects an empty-string submissionId with the shared 400 error', () => {
		const thrown = captureThrow(() =>
			parseDirectAgentRequest({ kind: 'user', body: 'Hello.', submissionId: '' }),
		);

		expect(thrown).toBeInstanceOf(InvalidRequestError);
		expect(thrown).toMatchObject({ status: 400, type: 'invalid_request' });
	});

	it('rejects a non-string submissionId with the shared 400 error', () => {
		const thrown = captureThrow(() =>
			parseDirectAgentRequest({ kind: 'user', body: 'Hello.', submissionId: 7 }),
		);

		expect(thrown).toBeInstanceOf(InvalidRequestError);
		expect(thrown).toMatchObject({ status: 400, type: 'invalid_request' });
	});

	it('still rejects a malformed message body through the shared message parse', () => {
		const thrown = captureThrow(() => parseDirectAgentRequest({ kind: 'user' }));

		expect(thrown).toBeInstanceOf(InvalidRequestError);
		expect(thrown).toMatchObject({ status: 400 });
	});
});

describe('createDirectAgentSubmissionInput()', () => {
	const message = { kind: 'user', body: 'Hello.' } as const;

	it('uses the client-supplied submissionId verbatim', () => {
		const input = createDirectAgentSubmissionInput({
			agent: 'assistant',
			id: 'instance-1',
			message,
			submissionId: 'client-submission-3',
		});

		expect(input.kind).toBe('direct');
		expect(input.submissionId).toBe('client-submission-3');
	});

	it('mints a UUID when no submissionId is supplied', () => {
		const input = createDirectAgentSubmissionInput({
			agent: 'assistant',
			id: 'instance-1',
			message,
		});

		expect(input.submissionId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});
});

describe('custom tool run context', () => {
	const providers: FauxProviderRegistration[] = [];

	afterEach(() => {
		for (const provider of providers.splice(0)) provider.unregister();
	});

	it("carries the model's tool-call id into the tool's run context", async () => {
		const provider = registerFauxProvider({
			provider: `direct-agent-request-test-${crypto.randomUUID()}`,
		});
		providers.push(provider);
		const toolCallId = `tool:${crypto.randomUUID()}`;
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('lookup', {}, { id: toolCallId }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('Done.'),
		]);
		let receivedToolCallId: string | undefined;
		const lookup = defineTool({
			name: 'lookup',
			description: 'Look up a value.',
			run(context) {
				receivedToolCallId = context.toolCallId;
				return 'ok';
			},
		});
		const harness = await createFlueContext({
			id: 'direct-agent-request-instance',
			env: {},
			agentConfig: { resolveModel: () => provider.getModel() },
			createDefaultEnv: async () => createNoopSessionEnv(),
		}).initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				tools: [lookup],
			})),
		);

		await (await harness.session()).prompt('Use the tool.');

		expect(receivedToolCallId).toBe(toolCallId);
	});
});
