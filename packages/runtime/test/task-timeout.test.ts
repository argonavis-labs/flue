import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from '@earendil-works/pi-ai/compat';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { afterEach, describe, expect, it } from 'vitest';
import {
	attachTaskPartialWork,
	createTaskTool,
	DEFAULT_TASK_TIMEOUT_MS,
	taskPartialWorkOf,
	type TaskToolParams,
	type TaskToolResultDetails,
} from '../src/agent.ts';
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
		const tool = createTaskTool(hangingRunTask(seen), {}, { salvageGraceMs: 25 });

		await expect(
			tool.execute('call-1', { prompt: 'Hang forever.', timeout: 0.05 }, undefined),
		).rejects.toThrow('Task timed out after 0.05 seconds');
		expect(seen.signal?.aborted).toBe(true);
	});

	it('applies the configured default when the model sets no timeout', async () => {
		const tool = createTaskTool(hangingRunTask(), {}, { timeoutMs: 50, salvageGraceMs: 25 });

		await expect(tool.execute('call-1', { prompt: 'Hang forever.' }, undefined)).rejects.toThrow(
			'Task timed out after 0.05 seconds',
		);
	});

	it('lets a per-call timeout override the configured default', async () => {
		// The default alone would let this hung task run for a minute; the
		// short per-call value must win, so the call fails immediately.
		const tool = createTaskTool(hangingRunTask(), {}, { timeoutMs: 60_000, salvageGraceMs: 25 });

		await expect(
			tool.execute('call-1', { prompt: 'Hang forever.', timeout: 0.05 }, undefined),
		).rejects.toThrow('Task timed out after 0.05 seconds');
	});

	it("applies the selected profile's taskTimeoutMs when the model sets no timeout", async () => {
		const tool = createTaskTool(
			hangingRunTask(),
			{ helper: { name: 'helper', taskTimeoutMs: 50 } },
			{ salvageGraceMs: 25 },
		);

		await expect(
			tool.execute('call-1', { prompt: 'Hang forever.', agent: 'helper' }, undefined),
		).rejects.toThrow('Task timed out after 0.05 seconds');
	});

	it("lets the selected profile's value override the session default", async () => {
		// The session default alone would allow a minute; the profile cap wins.
		const tool = createTaskTool(
			hangingRunTask(),
			{ helper: { name: 'helper', taskTimeoutMs: 50 } },
			{ timeoutMs: 60_000, salvageGraceMs: 25 },
		);

		await expect(
			tool.execute('call-1', { prompt: 'Hang forever.', agent: 'helper' }, undefined),
		).rejects.toThrow('Task timed out after 0.05 seconds');
	});

	it("lets a per-call timeout override the selected profile's value", async () => {
		// The profile cap alone would allow a minute; the per-call value wins.
		const tool = createTaskTool(
			hangingRunTask(),
			{ helper: { name: 'helper', taskTimeoutMs: 60_000 } },
			{ salvageGraceMs: 25 },
		);

		await expect(
			tool.execute(
				'call-1',
				{ prompt: 'Hang forever.', agent: 'helper', timeout: 0.05 },
				undefined,
			),
		).rejects.toThrow('Task timed out after 0.05 seconds');
	});

	it('falls back to the session default when the selected profile sets no value', async () => {
		const tool = createTaskTool(
			hangingRunTask(),
			{ helper: { name: 'helper' } },
			{ timeoutMs: 50, salvageGraceMs: 25 },
		);

		await expect(
			tool.execute('call-1', { prompt: 'Hang forever.', agent: 'helper' }, undefined),
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

	it('applies the built-in default cap when nothing is configured — a task is never uncapped', async () => {
		let sawSignal: AbortSignal | undefined;
		const tool = createTaskTool(async (_params, signal) => {
			sawSignal = signal;
			return OK_RESULT;
		}, {});

		await expect(tool.execute('call-1', { prompt: 'Finish.' }, undefined)).resolves.toEqual(
			OK_RESULT,
		);
		// The built-in 15-minute deadline is too long to wait out in a test;
		// the armed merged signal proves the cap exists on the bare call.
		expect(sawSignal).toBeDefined();
		expect(sawSignal?.aborted).toBe(false);
		expect(DEFAULT_TASK_TIMEOUT_MS).toBe(900_000);
	});

	it('hands the child partial work to the parent when the timeout aborts a settling child', async () => {
		// The child observes the abort, rejects, and its rejection carries the
		// text it had completed. The timeout error must carry that text on to
		// the parent instead of discarding it.
		const tool = createTaskTool(
			(_params, signal) =>
				new Promise<AgentToolResult<TaskToolResultDetails>>((_, reject) => {
					signal?.addEventListener(
						'abort',
						() => {
							const error = new Error('aborted');
							attachTaskPartialWork(error, {
								text: 'Finding 1: the connector returned 400.',
								toolTrace: '2 tool calls\n- execute\n- execute',
							});
							reject(error);
						},
						{ once: true },
					);
				}),
			{},
			{ timeoutMs: 50, salvageGraceMs: 500 },
		);

		await expect(tool.execute('call-1', { prompt: 'Report findings.' }, undefined)).rejects.toThrow(
			/Task timed out after 0.05 seconds[\s\S]*Finding 1: the connector returned 400\.[\s\S]*helper trace: 2 tool calls/,
		);
	});

	it('reports no salvageable work when the hung child never settles inside the grace window', async () => {
		const tool = createTaskTool(hangingRunTask(), {}, { timeoutMs: 50, salvageGraceMs: 25 });

		await expect(tool.execute('call-1', { prompt: 'Hang forever.' }, undefined)).rejects.toThrow(
			'It produced no salvageable partial work.',
		);
	});

	it('keeps a stale success as partial work instead of discarding it', async () => {
		// A sandbox adapter that ignores the merged signal can resolve after
		// the deadline. The call still fails as a timeout, but the text it
		// produced rides along.
		const tool = createTaskTool(
			() =>
				new Promise<AgentToolResult<TaskToolResultDetails>>((resolve) => {
					setTimeout(
						() => resolve({ content: [{ type: 'text', text: 'late answer' }], details: OK_RESULT.details }),
						100,
					);
				}),
			{},
			{ timeoutMs: 50, salvageGraceMs: 500 },
		);

		await expect(tool.execute('call-1', { prompt: 'Finish late.' }, undefined)).rejects.toThrow(
			/Task timed out after 0.05 seconds[\s\S]*late answer/,
		);
	});

	it('never attaches an empty partial, so an idle child stays terse', async () => {
		const error = new Error('aborted');
		attachTaskPartialWork(error, { text: '   ', toolTrace: '' });
		expect(taskPartialWorkOf(error)).toBeUndefined();

		attachTaskPartialWork(error, { text: '', toolTrace: 'no tool calls' });
		expect(taskPartialWorkOf(error)?.toolTrace).toBe('no tool calls');
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

	it('describes the task as bounded and never invites a generous timeout', () => {
		// Production callers measured the old wording's effect: prompts that
		// framed open-ended research rode "Set timeout generously" into the cap
		// and returned nothing. The description now states the bound and the
		// consequence, and must not steer the model toward research or toward
		// raising the timeout.
		const tool = createTaskTool(async () => OK_RESULT, {});
		expect(tool.description).toContain('one short, bounded subtask');
		expect(tool.description).toContain(
			'aborted and returns at most a fragment of unverified partial work',
		);
		expect(tool.description).toContain('keep open-ended research and multi-step work in this session');
		expect(tool.description).not.toContain('generously');
		expect(tool.description).not.toContain('Use this for independent research');

		const promptSchema = (tool.parameters.properties as { prompt: { description?: string } })
			.prompt;
		expect(promptSchema.description).toContain('a few sentences');
		expect(promptSchema.description).toContain('one bounded deliverable');
		expect(promptSchema.description).toContain('The child sees nothing else from this conversation');
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
