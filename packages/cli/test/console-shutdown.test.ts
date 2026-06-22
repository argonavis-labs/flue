import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleController } from '../src/lib/console-controller.ts';
import { boundedShutdown, closeConsoleForSignal, closeExecutionForSignal, consoleSignalExitCode } from '../src/lib/console-shutdown.ts';
import type { ExecutionLifecycle } from '../src/lib/execution-lifecycle.ts';

const originalExitCode = process.exitCode;

afterEach(() => {
	process.exitCode = originalExitCode;
	vi.useRealTimers();
});

describe('boundedShutdown()', () => {
	it('force-cleans and terminates after the cleanup bound', async () => {
		vi.useFakeTimers();
		const forceCloseSync = vi.fn();
		const beforeTerminate = vi.fn();
		const terminate = vi.fn();
		const shutdown = boundedShutdown({
			close: () => new Promise<void>(() => {}),
			forceCloseSync,
			exitCode: 130,
			timeoutMs: 10,
			beforeTerminate,
			terminate,
		});

		await vi.advanceTimersByTimeAsync(10);
		await shutdown;

		expect(forceCloseSync).toHaveBeenCalledOnce();
		expect(beforeTerminate).toHaveBeenCalledOnce();
		expect(terminate).toHaveBeenCalledWith(130);
	});
});

describe('closeConsoleForSignal()', () => {
	it('sets conventional signal exit codes and closes the UI after cleanup', async () => {
		let release: (() => void) | undefined;
		const order: string[] = [];
		const close = vi.fn(() => new Promise<void>((resolve) => {
			release = () => {
				order.push('cleanup');
				resolve();
			};
		}));
		const controller = { close, forceCloseSync: vi.fn() } as unknown as ConsoleController;
		const closeUi = vi.fn(() => order.push('ui'));

		const shutdown = closeConsoleForSignal('SIGINT', controller, closeUi);
		await Promise.resolve();
		expect(process.exitCode).toBe(130);
		expect(closeUi).not.toHaveBeenCalled();
		release?.();
		await shutdown;

		expect(order).toEqual(['cleanup', 'ui']);
		expect(consoleSignalExitCode('SIGTERM')).toBe(143);
	});
});

describe('closeExecutionForSignal()', () => {
	it('cancels run execution before bounded cleanup', async () => {
		const cancel = vi.fn();
		const close = vi.fn(async () => {});
		const lifecycle = { cancel, close, forceCloseSync: vi.fn() } as unknown as ExecutionLifecycle;

		await closeExecutionForSignal('SIGTERM', lifecycle, vi.fn());

		expect(cancel).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
		expect(process.exitCode).toBe(143);
	});
});
