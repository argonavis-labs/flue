import {
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	type FauxModelDefinition,
	type FauxProviderRegistration,
} from '@earendil-works/pi-ai/compat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineAgent } from '../src/index.ts';
import { createFlueContext } from '../src/internal.ts';
import { TaskTimeoutError } from '../src/errors.ts';
import type { SessionEnv } from '../src/types.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

const providers: FauxProviderRegistration[] = [];

afterEach(() => {
	for (const provider of providers.splice(0)) provider.unregister();
});

function createProvider(models?: FauxModelDefinition[]): FauxProviderRegistration {
	const provider = registerFauxProvider({
		provider: `task-timeout-test-${crypto.randomUUID()}`,
		models,
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

describe('delegated task timeout', () => {
	it('rejects a model-invoked task child that exceeds two minutes and lets the parent prompt continue', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		let rejectedTaskResult: unknown;
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('task', { prompt: 'Do slow work.' }), { stopReason: 'toolUse' }),
			(_context, options) =>
				new Promise<never>((_resolve, reject) => {
					const signal = options?.signal;
					if (signal?.aborted) {
						reject(signal.reason);
						return;
					}
					signal?.addEventListener(
						'abort',
						() => reject(signal.reason),
						{ once: true },
					);
				}),
			(context) => {
				rejectedTaskResult = context.messages.at(-1);
				return fauxAssistantMessage('Parent completed after child timed out.');
			},
		]);
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		vi.useFakeTimers();
		try {
			const response = session.prompt('Delegate slow work.');
			await vi.advanceTimersByTimeAsync(120_000);

			const result = await response;

			expect(result.text).toBe('Parent completed after child timed out.');
			expect(rejectedTaskResult).toMatchObject({
				role: 'toolResult',
				toolName: 'task',
				isError: true,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects a programmatic task() call when the delegated child exceeds two minutes', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		provider.setResponses([
			(_context, options) =>
				new Promise<never>((_resolve, reject) => {
					const signal = options?.signal;
					if (signal?.aborted) {
						reject(signal.reason);
						return;
					}
					signal?.addEventListener(
						'abort',
						() => reject(signal.reason),
						{ once: true },
					);
				}),
		]);
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		vi.useFakeTimers();
		try {
			const response = session.task('Do slow work.');
			await vi.advanceTimersByTimeAsync(120_000);

			const error = await response.catch((e) => e);
			expect(error).toBeInstanceOf(TaskTimeoutError);
			expect(error).toMatchObject({
				type: 'task_timeout',
				meta: { timeoutMs: 120_000 },
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not apply the two-minute timeout to a parent prompt operation', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		provider.setResponses([
			() =>
				new Promise((resolve) => {
					setTimeout(() => resolve(fauxAssistantMessage('Parent response.')), 150_000);
				}),
		]);
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		vi.useFakeTimers();
		try {
			const response = session.prompt('Take your time.');
			await vi.advanceTimersByTimeAsync(150_000);

			await expect(response).resolves.toMatchObject({ text: 'Parent response.' });
		} finally {
			vi.useRealTimers();
		}
	});
});
