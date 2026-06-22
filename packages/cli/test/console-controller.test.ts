import type { FlueClient } from '@flue/sdk';
import { describe, expect, it, vi } from 'vitest';
import { createConsoleController } from '../src/lib/console-controller.ts';
import type { ExecutionLifecycle } from '../src/lib/execution-lifecycle.ts';

function lifecycle(
	client: FlueClient,
	kind: 'agent' | 'workflow' = 'agent',
	overrides: Partial<ExecutionLifecycle> = {},
) {
	const close = vi.fn(async () => {});
	const cancel = vi.fn();
	const forceCloseSync = vi.fn();
	const prepared = {
		resource: { kind, name: kind === 'agent' ? 'support' : 'deploy', filePath: '' },
		instanceId: kind === 'agent' ? 'instance-1' : undefined,
		target: 'node' as const,
		root: '/app',
		configPath: undefined,
		envFile: undefined,
		remote: false,
	};
	return {
		value: {
			signal: new AbortController().signal,
			prepare: vi.fn(async () => prepared),
			start: vi.fn(async () => ({ ...prepared, client, baseUrl: 'http://localhost:3000' })),
			cancel,
			close,
			forceCloseSync,
			...overrides,
		} satisfies ExecutionLifecycle,
		close,
		cancel,
	};
}

describe('createConsoleController()', () => {
	it('runs complete initial agent input and follow-up prompts on one instance', async () => {
		const send = vi.fn().mockResolvedValue({ streamUrl: 'x', offset: '0', submissionId: 'sub' });
		const wait = vi.fn().mockResolvedValue({ text: 'done' });
		const setup = lifecycle({ agents: { send, wait } } as unknown as FlueClient);
		const initialInput = { message: 'inspect', images: [{ type: 'image' as const, data: 'abc', mimeType: 'image/png' }] };
		const controller = createConsoleController({ lifecycle: setup.value, initialInput });

		await controller.start();
		await controller.submit('continue');

		expect(send).toHaveBeenNthCalledWith(1, 'support', 'instance-1', { ...initialInput, signal: expect.any(AbortSignal) });
		expect(send).toHaveBeenNthCalledWith(2, 'support', 'instance-1', { message: 'continue', signal: expect.any(AbortSignal) });
		expect(controller.getSnapshot()).toMatchObject({ status: 'completed', composerEnabled: true, id: 'instance-1' });
	});

	it('re-enables the composer after a failed prompt and closes once', async () => {
		const send = vi.fn().mockRejectedValue(new Error('denied'));
		const setup = lifecycle({ agents: { send } } as unknown as FlueClient);
		const controller = createConsoleController({ lifecycle: setup.value });

		await controller.start();
		await controller.submit('hello');
		expect(controller.getSnapshot()).toMatchObject({ status: 'failed', composerEnabled: true });
		await Promise.all([controller.close(), controller.close()]);

		expect(controller.getSnapshot().composerEnabled).toBe(false);
		expect(setup.cancel).toHaveBeenCalledOnce();
		expect(setup.close).toHaveBeenCalledOnce();
	});

	it('awaits lifecycle cleanup and exposes cleanup failure', async () => {
		let releaseClose: (() => void) | undefined;
		const close = vi.fn(() => new Promise<void>((resolve) => { releaseClose = resolve; }));
		const setup = lifecycle({ agents: {} } as unknown as FlueClient, 'agent', { close });
		const controller = createConsoleController({ lifecycle: setup.value });
		await controller.start();

		let settled = false;
		const closing = controller.close().then(() => { settled = true; });
		await Promise.resolve();
		expect(settled).toBe(false);
		releaseClose?.();
		await closing;
		expect(controller.getSnapshot().status).toBe('closed');

		const failure = lifecycle({ agents: {} } as unknown as FlueClient, 'agent', { close: vi.fn(async () => { throw new Error('cleanup failed'); }) });
		const failedController = createConsoleController({ lifecycle: failure.value });
		await failedController.start();
		await expect(failedController.close()).rejects.toThrow('cleanup failed');
		expect(failedController.getSnapshot().status).toBe('failed');
	});

	it('does not publish active or completed state after closing during startup or execution', async () => {
		let releaseStart: (() => void) | undefined;
		const setup = lifecycle({ agents: {} } as unknown as FlueClient);
		const startedExecution = await setup.value.start();
		const delayed = lifecycle({ agents: {} } as unknown as FlueClient, 'agent', {
			start: vi.fn(() => new Promise<typeof startedExecution>((resolve) => { releaseStart = () => resolve(startedExecution); })),
		});
		const startupController = createConsoleController({ lifecycle: delayed.value });
		const starting = startupController.start();
		await Promise.resolve();
		const closing = startupController.close();
		expect(startupController.getSnapshot().status).toBe('closing');
		releaseStart?.();
		await Promise.all([starting, closing]);
		expect(startupController.getSnapshot().status).toBe('closed');

		let releaseWait: (() => void) | undefined;
		const send = vi.fn().mockResolvedValue({ streamUrl: 'x', offset: '0', submissionId: 'sub' });
		const wait = vi.fn(() => new Promise((resolve) => { releaseWait = () => resolve({ text: 'late' }); }));
		const active = lifecycle({ agents: { send, wait } } as unknown as FlueClient);
		const activeController = createConsoleController({ lifecycle: active.value });
		await activeController.start();
		const prompt = activeController.submit('hello');
		await Promise.resolve();
		await activeController.close();
		releaseWait?.();
		await prompt;
		expect(activeController.getSnapshot().status).toBe('closed');
		expect(activeController.getSnapshot().transcript.records.some((record) => record.text.includes('result'))).toBe(false);
	});

	it('records lifecycle states and preserves server stream tones', async () => {
		const setup = lifecycle({ agents: {} } as unknown as FlueClient);
		const controller = createConsoleController({ lifecycle: setup.value });
		controller.setLifecycleStatus('building');
		controller.setLifecycleStatus('starting');
		controller.recordServerOutput('listening', 'stdout');
		controller.recordServerOutput('failed line', 'stderr');

		expect(controller.getSnapshot().transcript.records).toEqual([
			expect.objectContaining({ text: 'building application', tone: 'dim' }),
			expect.objectContaining({ text: 'starting runtime', tone: 'dim' }),
			expect.objectContaining({ text: 'server stdout listening', tone: 'dim' }),
			expect.objectContaining({ text: 'server stderr failed line', tone: 'error' }),
		]);
	});

	it('invokes a workflow once with omitted input and exposes no composer', async () => {
		const run = vi.fn().mockResolvedValue({ runId: 'run-1', result: { ok: true } });
		const setup = lifecycle({ workflows: { run } } as unknown as FlueClient, 'workflow');
		const controller = createConsoleController({ lifecycle: setup.value });

		await controller.start();

		expect(run).toHaveBeenCalledOnce();
		expect(run).toHaveBeenCalledWith('deploy', { input: undefined, onEvent: expect.any(Function), signal: expect.any(AbortSignal) });
		expect(controller.getSnapshot()).toMatchObject({ id: 'run-1', status: 'completed', composerEnabled: false });
	});
});
