import { createAdaptorServer } from '@hono/node-server';
import { RuntimeUnavailableError, toHttpResponse } from '@flue/runtime/internal';

export type NodeRuntimeStatus = 'loading' | 'ready' | 'draining' | 'failed' | 'closed';

export interface LoadedNodeApplication {
	fetch(request: Request, env?: unknown): Response | Promise<Response>;
	enterActivity(): { release(): void };
	pauseAdmissions(): void;
	resumeAdmissions(): void;
	waitForIdle(): Promise<void>;
	stop(options?: { abort?: boolean; timeoutMs?: number }): Promise<void>;
	closeSync(): void;
}

export interface StableNodeListener {
	readonly port: number;
	readonly url: string;
	readonly status: NodeRuntimeStatus;
	listen(): Promise<void>;
	install(application: LoadedNodeApplication): void;
	beginDrain(): LoadedNodeApplication | undefined;
	setLoading(): void;
	setFailed(): void;
	closeConnections(): void;
	stop(): Promise<void>;
	closeSync(): void;
}

function isObservationRequest(request: Request): boolean {
	if (request.method !== 'GET' && request.method !== 'HEAD') return false;
	const pathname = new URL(request.url).pathname;
	return (
		pathname.endsWith('/openapi.json') ||
		/\/(?:healthz?|readyz?|livez?)$/.test(pathname) ||
		/\/(?:agents\/[^/]+\/[^/]+|runs\/[^/]+)$/.test(pathname)
	);
}

function retainLeaseForResponse(
	response: Response,
	lease: { release(): void },
): Response {
	if (!response.body) {
		lease.release();
		return response;
	}
	const reader = response.body.getReader();
	return new Response(
		new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const result = await reader.read();
					if (result.done) {
						lease.release();
						controller.close();
						return;
					}
					controller.enqueue(result.value);
				} catch (error) {
					lease.release();
					controller.error(error);
				}
			},
			async cancel(reason) {
				try {
					await reader.cancel(reason);
				} finally {
					lease.release();
				}
			},
		}),
		{
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		},
	);
}

export function createStableNodeListener(options: {
	port: number;
	hostname?: string;
}): StableNodeListener {
	let status: NodeRuntimeStatus = 'loading';
	let application: LoadedNodeApplication | undefined;
	let server: ReturnType<typeof createAdaptorServer> | undefined;
	let listening: Promise<void> | undefined;
	let stopping: Promise<void> | undefined;

	return {
		get port() {
			const address = server?.address();
			return address && typeof address === 'object' ? address.port : options.port;
		},
		get url() {
			const address = server?.address();
			const port = address && typeof address === 'object' ? address.port : options.port;
			return `http://${options.hostname ?? 'localhost'}:${port}`;
		},
		get status() {
			return status;
		},
		listen() {
			if (listening) return listening;
			listening = new Promise<void>((resolve, reject) => {
				let settled = false;
				const onError = (error: Error) => {
					if (settled) return;
					settled = true;
					reject(error);
				};
				server = createAdaptorServer({
					async fetch(request, env) {
						if (status !== 'ready' || !application) {
							const state = status === 'closed' ? 'failed' : status;
							return toHttpResponse(
								new RuntimeUnavailableError({
									state: state === 'ready' ? 'failed' : state,
								}),
							);
						}
						if (isObservationRequest(request)) return application.fetch(request, env);
						const lease = application.enterActivity();
						try {
							const response = await application.fetch(request, env);
							return retainLeaseForResponse(response, lease);
						} catch (error) {
							lease.release();
							throw error;
						}
					},
					serverOptions: { requestTimeout: 0 },
				});
				server.once('error', onError);
				const onListening = () => {
					if (settled) return;
					settled = true;
					server?.off('error', onError);
					resolve();
				};
				if (options.hostname) server.listen(options.port, options.hostname, onListening);
				else server.listen(options.port, onListening);
			});
			return listening;
		},
		install(next) {
			application = next;
			next.resumeAdmissions();
			status = 'ready';
		},
		beginDrain() {
			status = 'draining';
			application?.pauseAdmissions();
			return application;
		},
		setLoading() {
			status = 'loading';
			application = undefined;
		},
		setFailed() {
			status = 'failed';
		},
		closeConnections() {
			if (server && 'closeAllConnections' in server) server.closeAllConnections();
		},
		stop() {
			if (stopping) return stopping;
			status = 'closed';
			stopping = new Promise<void>((resolve, reject) => {
				if (!server) {
					resolve();
					return;
				}
				server.close((error) => {
					if (error) reject(error);
					else resolve();
				});
				if ('closeAllConnections' in server) server.closeAllConnections();
			});
			return stopping;
		},
		closeSync() {
			status = 'closed';
			if (server && 'closeAllConnections' in server) server.closeAllConnections();
			server?.close();
		},
	};
}
