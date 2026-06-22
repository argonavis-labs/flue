import type { ConsoleController } from './console-controller.ts';
import type { ExecutionLifecycle } from './execution-lifecycle.ts';

const EXECUTION_SHUTDOWN_TIMEOUT_MS = 5000;

export interface BoundedShutdownOptions {
	close(): Promise<void>;
	forceCloseSync(): void;
	exitCode: number;
	timeoutMs?: number;
	beforeTerminate?: () => void;
	terminate?: (code: number) => unknown;
}

export function consoleSignalExitCode(signal: NodeJS.Signals): 130 | 143 {
	return signal === 'SIGINT' ? 130 : 143;
}

export async function boundedShutdown(options: BoundedShutdownOptions): Promise<void> {
	process.exitCode = options.exitCode;
	let timer: NodeJS.Timeout | undefined;
	let timedOut = false;
	try {
		const closing = Promise.resolve().then(() => options.close());
		void closing.catch(() => {});
		await Promise.race([
			closing,
			new Promise<void>((resolve) => {
				timer = setTimeout(() => {
					timedOut = true;
					resolve();
				}, options.timeoutMs ?? EXECUTION_SHUTDOWN_TIMEOUT_MS);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
		if (timedOut) {
			options.forceCloseSync();
			options.beforeTerminate?.();
			(options.terminate ?? process.exit)(options.exitCode);
		}
	}
}

export async function closeConsoleForSignal(
	signal: NodeJS.Signals,
	controller: ConsoleController,
	closeUi: () => void,
	terminate?: (code: number) => unknown,
): Promise<void> {
	const exitCode = consoleSignalExitCode(signal);
	try {
		await boundedShutdown({
			close: () => controller.close(),
			forceCloseSync: () => controller.forceCloseSync(),
			exitCode,
			beforeTerminate: closeUi,
			terminate,
		});
	} finally {
		closeUi();
	}
}

export function closeExecutionForSignal(
	signal: NodeJS.Signals,
	lifecycle: ExecutionLifecycle,
	terminate?: (code: number) => unknown,
): Promise<void> {
	const exitCode = consoleSignalExitCode(signal);
	lifecycle.cancel();
	return boundedShutdown({
		close: () => lifecycle.close(),
		forceCloseSync: () => lifecycle.forceCloseSync(),
		exitCode,
		terminate,
	});
}
