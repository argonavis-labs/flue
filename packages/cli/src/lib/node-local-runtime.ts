import { resetProviderRuntime } from '@flue/runtime/internal';
import { createNodeApplicationLoader, type NodeApplicationLoader } from './node-application-loader.ts';
import {
	createStableNodeListener,
	type LoadedNodeApplication,
	type NodeRuntimeStatus,
} from './node-http-listener.ts';
import type { LocalHttpRuntimeOutput } from './local-http-runtime.ts';

export interface NodeLocalRuntime {
	readonly port: number;
	readonly url: string;
	readonly status: NodeRuntimeStatus;
	start(): Promise<void>;
	reload(): Promise<void>;
	stop(): Promise<void>;
	closeSync(): void;
}

export async function createNodeLocalRuntime(options: {
	root: string;
	sourceRoot: string;
	port: number;
	temporaryLocalExposure: boolean;
	hostname?: string;
	env?: NodeJS.ProcessEnv;
	onOutput?: (output: LocalHttpRuntimeOutput) => void;
	internalDevLogs?: boolean;
	reloadTimeoutMs?: number;
}): Promise<NodeLocalRuntime> {
	const listener = createStableNodeListener({ port: options.port, hostname: options.hostname });
	let loader: NodeApplicationLoader | undefined;
	let application: LoadedNodeApplication | undefined;
	let starting: Promise<void> | undefined;
	let reloading: Promise<void> | undefined;
	let reloadQueued = false;
	let stopping: Promise<void> | undefined;

	async function loadApplication(): Promise<LoadedNodeApplication> {
		resetProviderRuntime();
		loader ??= await createNodeApplicationLoader(options);
		return loader.load();
	}

	async function start(): Promise<void> {
		if (starting) return starting;
		starting = (async () => {
			await listener.listen();
			try {
				application = await loadApplication();
				listener.install(application);
			} catch (error) {
				await listener.stop();
				throw error;
			}
		})();
		return starting;
	}

	async function runReload(): Promise<void> {
		const current = application;
		listener.beginDrain();
		current?.pauseAdmissions();
		if (!current) {
			listener.setLoading();
			try {
				application = await loadApplication();
				listener.install(application);
			} catch (error) {
				listener.setFailed();
				throw error;
			}
			return;
		}
		try {
			await withTimeout(current.waitForIdle(), options.reloadTimeoutMs ?? 30_000);
		} catch (error) {
			listener.setFailed();
			void current.waitForIdle().then(async () => {
				try {
					await current.stop();
				} finally {
					if (application === current) application = undefined;
				}
			}).catch(() => undefined);
			throw error;
		}
		await current.stop();
		application = undefined;
		listener.setLoading();
		try {
			application = await loadApplication();
			listener.install(application);
		} catch (error) {
			listener.setFailed();
			throw error;
		}
	}

	async function reload(): Promise<void> {
		if (reloading) {
			reloadQueued = true;
			return reloading;
		}
		reloading = (async () => {
			do {
				reloadQueued = false;
				await runReload();
			} while (reloadQueued);
		})().finally(() => {
			reloading = undefined;
		});
		return reloading;
	}

	return {
		get port() {
			return listener.port;
		},
		get url() {
			return listener.url;
		},
		get status() {
			return listener.status;
		},
		start,
		reload,
		stop() {
			if (stopping) return stopping;
			stopping = (async () => {
				const errors: unknown[] = [];
				listener.beginDrain();
				try {
					await application?.stop({ abort: true, timeoutMs: 30_000 });
				} catch (error) {
					errors.push(error);
				}
				try {
					await loader?.close();
				} catch (error) {
					errors.push(error);
				}
				try {
					await listener.stop();
				} catch (error) {
					errors.push(error);
				}
				if (errors.length === 1) throw errors[0];
				if (errors.length > 1) throw new AggregateError(errors, 'Node local runtime shutdown failed.');
			})();
			return stopping;
		},
		closeSync() {
			application?.closeSync();
			listener.closeSync();
		},
	};
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`Runtime drain timed out after ${timeoutMs}ms.`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
