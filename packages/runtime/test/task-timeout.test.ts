import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from '@earendil-works/pi-ai/compat';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskTool, type TaskToolParams, type TaskToolResultDetails } from '../src/agent.ts';
import { defineAgent, defineAgentProfile } from '../src/index.ts';
import { createFlueContext } from '../src/internal.ts';
import type { SessionEnv } from '../src/types.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

const providers: FauxProviderRegistration[] = [];

afterEach(() => {
	for (const provider of providers.splice(0)) provider.unregister();
});

function createProvider(): FauxProviderRegistration {
	const provider = registerFauxProvider({
		provider: `task-timeout-test-${crypto.randomUUID()}`,
		models: [{ id: 'reviewer' }],
	});
	providers.push(provider);
	return provider;
}

function createContext(provider: FauxProviderRegistration, options: { env?: SessionEnv } = {}) {
	return createFlueContext({
		id: 'task-timeout-instance',
		env: {},
		agentConfig: {
			resolveModel: (specifier) => {
				if (!specifier) return undefined;
				return provider.getModel(specifier.slice(specifier.indexOf('/') + 1));
			},
		},
		createDefaultEnv: async () => options.env ?? createNoopSessionEnv(),
	});
}

const OK_RESULT: AgentToolResult<TaskToolResultDetails> = {
	content: [{ type: 'text', text: 'done' }],
	details: { taskId: 'task-1', session: 'child-1' },
};

/** A runTask fake that never settles — a hung spawn or a sick sandbox. */
function hangingRunTask(seen: { signal?: AbortSignal } = {}) {
	return (_params: TaskToolParams, signal?: AbortSignal) => {
		seen.signal = signal;
		return new Promise<AgentToolResult<TaskToolResultDetails>>(() => {});
	};
}

describe('task tool timeout', () => {
	it('fails a hung task at the per-call timeout and aborts the merged signal', async () => {
		const seen: { signal?: AbortSignal } = {};
		const tool = createTaskTool(hangingRunTask(seen), {});

		await expect(
			tool.execute('call-1', { prompt: 'Hang forever.', timeout: 0.05 }, undefined),
		).rejects.toThrow('Task timed out after 0.05 seconds');
		expect(seen.signal?.aborted).toBe(true);
	});

	it('applies the configured default when the model sets no timeout', async () => {
		const tool = createTaskTool(hangingRunTask(), {}, { timeoutMs: 50 });

		await expect(tool.execute('call-1', { prompt: 'Hang forever.' }, undefined)).rejects.toThrow(
			'Task timed out after 0.05 seconds',
		);
	});

	it('lets a per-call timeout override the configured default', async () => {
		// The default alone would let this hung task run for a minute; the
		// short per-call value must win, so the call fails immediately.
		const tool = createTaskTool(hangingRunTask(), {}, { timeoutMs: 60_000 });

		await expect(
			tool.execute('call-1', { prompt: 'Hang forever.', timeout: 0.05 }, undefined),
		).rejects.toThrow('Task timed out after 0.05 seconds');
	});

	it('passes an in-time result through and leaves the signal untouched', async () => {
		const seen: { signal?: AbortSignal } = {};
		const tool = createTaskTool(
			async (_params, signal) => {
				seen.signal = signal;
				return OK_RESULT;
			},
			{},
			{ timeoutMs: 5_000 },
		);

		await expect(tool.execute('call-1', { prompt: 'Finish.' }, undefined)).resolves.toEqual(
			OK_RESULT,
		);
		expect(seen.signal?.aborted).toBe(false);
	});

	it('runs without any cap when neither a timeout nor a default is set', async () => {
		let sawSignal: AbortSignal | undefined;
		const tool = createTaskTool(async (_params, signal) => {
			sawSignal = signal;
			return OK_RESULT;
		}, {});

		await expect(tool.execute('call-1', { prompt: 'Finish.' }, undefined)).resolves.toEqual(
			OK_RESULT,
		);
		expect(sawSignal).toBeUndefined();
	});

	it('rethrows a host abort instead of shaping it as a timeout', async () => {
		const controller = new AbortController();
		const tool = createTaskTool(
			(_params, signal) =>
				new Promise<AgentToolResult<TaskToolResultDetails>>((_, reject) => {
					signal?.addEventListener('abort', () => reject(new Error('host aborted the turn')), {
						once: true,
					});
				}),
			{},
			{ timeoutMs: 5_000 },
		);

		const run = tool.execute('call-1', { prompt: 'Hang until abort.' }, controller.signal);
		controller.abort();
		await expect(run).rejects.toThrow('host aborted the turn');
	});

	it('advertises the timeout parameter in the tool description', () => {
		const tool = createTaskTool(async () => OK_RESULT, {});
		expect(tool.description).toContain('timeout');
	});
});

describe('taskTimeoutMs configuration', () => {
	it('rejects a non-positive-integer taskTimeoutMs on an agent definition', () => {
		expect(() => defineAgentProfile({ taskTimeoutMs: 0 })).toThrow(
			'taskTimeoutMs must be a positive integer',
		);
		expect(() => defineAgentProfile({ taskTimeoutMs: 1.5 })).toThrow(
			'taskTimeoutMs must be a positive integer',
		);
	});

	it('caps a model-invoked task through the agent definition default and returns a recoverable error result', async () => {
		const provider = createProvider();
		const model = `${provider.getModel().provider}/reviewer`;
		const parentFollowUps: string[] = [];
		provider.setResponses([
			// Parent turn 1: delegate.
			fauxAssistantMessage(fauxToolCall('task', { prompt: 'Hang forever.', agent: 'reviewer' }), {
				stopReason: 'toolUse',
			}),
			// Child model call: never settles — the timeout must free the parent.
			() => new Promise(() => {}),
			// Parent turn 2: sees the timeout tool result and recovers.
			(context) => {
				parentFollowUps.push(JSON.stringify(context.messages));
				return fauxAssistantMessage('Recovered after the task timed out.');
			},
		]);
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({
				model,
				taskTimeoutMs: 100,
				subagents: [{ name: 'reviewer', model }],
			})),
		);
		const session = await harness.session();

		const response = await session.prompt('Delegate something doomed.');

		expect(response.text).toBe('Recovered after the task timed out.');
		expect(parentFollowUps.join('\n')).toContain('Task timed out after 0.1 seconds');
	});
});
