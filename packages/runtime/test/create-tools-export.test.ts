import { describe, expect, it } from 'vitest';
import { createTools } from '../src/index.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

describe('createTools() root export', () => {
	it('returns the standard sandbox tool surface without a task runner', () => {
		const tools = createTools(createNoopSessionEnv());

		expect(tools.map((tool) => tool.name)).toEqual([
			'read',
			'write',
			'edit',
			'bash',
			'grep',
			'glob',
		]);
	});

	it('appends the task tool when the options provide a task runner', () => {
		const tools = createTools(createNoopSessionEnv(), {
			task: async () => ({ content: [], details: { taskId: 'task-1', session: 'session-1' } }),
			subagents: {},
		});

		expect(tools.map((tool) => tool.name)).toEqual([
			'read',
			'write',
			'edit',
			'bash',
			'grep',
			'glob',
			'task',
		]);
	});
});
