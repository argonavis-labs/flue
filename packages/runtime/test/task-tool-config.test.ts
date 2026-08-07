import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	registerFauxProvider,
} from '@earendil-works/pi-ai/compat';
import { afterEach, describe, expect, it } from 'vitest';
import { defineAgent, defineAgentProfile, type FlueEvent } from '../src/index.ts';
import { createFlueContext, type FlueContextConfig } from '../src/internal.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

const providers: FauxProviderRegistration[] = [];

afterEach(() => {
	for (const provider of providers.splice(0)) provider.unregister();
});

function createProvider(): FauxProviderRegistration {
	const provider = registerFauxProvider({ provider: `task-tool-test-${crypto.randomUUID()}` });
	providers.push(provider);
	return provider;
}

function createContext(provider: FauxProviderRegistration, overrides: Partial<FlueContextConfig> = {}) {
	return createFlueContext({
		id: 'task-tool-instance',
		env: {},
		agentConfig: {
			resolveModel: () => provider.getModel(),
		},
		createDefaultEnv: async () => createNoopSessionEnv(),
		...overrides,
	});
}

function agentTurnToolNames(events: FlueEvent[]): string[] {
	const turn = events.find(
		(event): event is Extract<FlueEvent, { type: 'turn_request' }> =>
			event.type === 'turn_request' && event.purpose === 'agent',
	);
	return turn?.request.input.tools?.map((tool) => tool.name) ?? [];
}

function childTurnToolNames(events: FlueEvent[]): string[] {
	const turn = events.find(
		(event): event is Extract<FlueEvent, { type: 'turn_request' }> =>
			event.type === 'turn_request' &&
			event.purpose === 'agent' &&
			(event.session?.startsWith('task:') ?? false),
	);
	return turn?.request.input.tools?.map((tool) => tool.name) ?? [];
}

describe('task tool model exposure', () => {
	it('exposes the task tool by default, even when no subagents are declared', async () => {
		const provider = createProvider();
		provider.setResponses([fauxAssistantMessage('ok')]);
		const ctx = createContext(provider);
		const events: FlueEvent[] = [];
		ctx.subscribeEvent((event) => {
			events.push(event);
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/${provider.getModel().id}` })),
		);
		const session = await harness.session();

		await session.prompt('hello');

		expect(agentTurnToolNames(events)).toContain('task');
	});

	it('omits the model-facing task tool when taskTool is false while keeping other framework tools', async () => {
		const provider = createProvider();
		provider.setResponses([fauxAssistantMessage('ok')]);
		const ctx = createContext(provider);
		const events: FlueEvent[] = [];
		ctx.subscribeEvent((event) => {
			events.push(event);
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				taskTool: false,
				skills: [{ name: 'review', description: 'Review code.' }],
			})),
		);
		const session = await harness.session();

		await session.prompt('hello');

		const toolNames = agentTurnToolNames(events);
		expect(toolNames).not.toContain('task');
		expect(toolNames).toContain('activate_skill');
	});

	it('still allows programmatic session.task() when the model-facing task tool is disabled', async () => {
		const provider = createProvider();
		provider.setResponses([fauxAssistantMessage('child done')]);
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				taskTool: false,
			})),
		);
		const session = await harness.session();

		const result = await session.task('do work');

		expect(result.text).toBe('child done');
	});
});

describe('taskTool resolution', () => {
	it('lets runtime config enable the task tool when the profile disables it', async () => {
		const provider = createProvider();
		provider.setResponses([fauxAssistantMessage('ok')]);
		const ctx = createContext(provider);
		const events: FlueEvent[] = [];
		ctx.subscribeEvent((event) => {
			events.push(event);
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({
				profile: defineAgentProfile({
					model: `${provider.getModel().provider}/${provider.getModel().id}`,
					taskTool: false,
				}),
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				taskTool: true,
			})),
		);
		const session = await harness.session();

		await session.prompt('hello');

		expect(agentTurnToolNames(events)).toContain('task');
	});

	it('lets runtime config disable the task tool when the profile enables it', async () => {
		const provider = createProvider();
		provider.setResponses([fauxAssistantMessage('ok')]);
		const ctx = createContext(provider);
		const events: FlueEvent[] = [];
		ctx.subscribeEvent((event) => {
			events.push(event);
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({
				profile: defineAgentProfile({
					model: `${provider.getModel().provider}/${provider.getModel().id}`,
					taskTool: true,
				}),
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				taskTool: false,
			})),
		);
		const session = await harness.session();

		await session.prompt('hello');

		expect(agentTurnToolNames(events)).not.toContain('task');
	});

	it('inherits the parent taskTool setting for child profiles that do not declare one', async () => {
		const provider = createProvider();
		provider.setResponses([fauxAssistantMessage('child done')]);
		const ctx = createContext(provider);
		const events: FlueEvent[] = [];
		ctx.subscribeEvent((event) => {
			events.push(event);
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				taskTool: false,
				subagents: [
					defineAgentProfile({
						name: 'reviewer',
						model: `${provider.getModel().provider}/${provider.getModel().id}`,
					}),
				],
			})),
		);
		const session = await harness.session();

		const result = await session.task('review', { agent: 'reviewer' });

		expect(result.text).toBe('child done');
		expect(childTurnToolNames(events)).not.toContain('task');
	});
});
