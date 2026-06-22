import * as path from 'node:path';
import { createBuildContext, createSharedViteConfig, viteGeneratedEntryDependencyResolver } from './build.ts';
import { NodePlugin } from './build-plugin-node.ts';
import type { LocalHttpRuntimeOutput } from './local-http-runtime.ts';
import type { LoadedNodeApplication } from './node-http-listener.ts';
import { withScopedConsoleCapture } from './scoped-console-capture.ts';

const virtualEntry = 'virtual:flue/node-local-bootstrap';
const resolvedEntry = '\0virtual:flue/node-local-bootstrap';

export interface NodeApplicationLoader {
	load(): Promise<LoadedNodeApplication>;
	close(): Promise<void>;
}

export async function createNodeApplicationLoader(options: {
	root: string;
	sourceRoot: string;
	temporaryLocalExposure: boolean;
	env?: NodeJS.ProcessEnv;
	onOutput?: (output: LocalHttpRuntimeOutput) => void;
	internalDevLogs?: boolean;
}): Promise<NodeApplicationLoader> {
	let server: Awaited<ReturnType<typeof import('vite')['createServer']>> | undefined;

	async function close(): Promise<void> {
		const current = server;
		server = undefined;
		await current?.close();
	}

	return {
		async load() {
			await close();
			const ctx = createBuildContext({
				root: options.root,
				sourceRoot: options.sourceRoot,
				output: options.root,
				target: 'node',
				temporaryLocalExposure: options.temporaryLocalExposure,
			});
			if (ctx.agents.length === 0 && ctx.workflows.length === 0) {
				throw new Error(
					`[flue] No agent or workflow files found.\n\nExpected at: ${path.join(options.sourceRoot, 'agents')}/ or ${path.join(options.sourceRoot, 'workflows')}/\nAdd at least one agent or workflow file.`,
				);
			}
			const code = new NodePlugin().generateRuntimeEntryPoint(ctx);
			const shared = createSharedViteConfig(options.root, [], [resolvedEntry]);
			const { createServer } = await import('vite');
			const viteServer = await createServer({
				...shared,
				appType: 'custom',
				logLevel: 'silent',
				resolve: { preserveSymlinks: true },
				optimizeDeps: { noDiscovery: true, include: [] },
				server: { middlewareMode: true, hmr: false, watch: null },
				plugins: [
					...shared.plugins,
					{
						name: 'flue-node-local-bootstrap',
						resolveId(id: string) {
							if (id === virtualEntry) return resolvedEntry;
						},
						load(id: string) {
							if (id === resolvedEntry) return code;
						},
					},
					viteGeneratedEntryDependencyResolver(options.root, { external: true }),
				],
			});
			server = viteServer;
			try {
				const loaded = (await withScopedConsoleCapture(options.onOutput, () =>
					viteServer.ssrLoadModule(virtualEntry),
				)) as {
					loadFlueNodeApplication(options: object): Promise<LoadedNodeApplication>;
				};
				return await loaded.loadFlueNodeApplication({
					local: true,
					env: { ...process.env, ...options.env },
					onOutput: options.onOutput,
					internalDevLogs: options.internalDevLogs,
				});
			} catch (error) {
				await close();
				throw error;
			}
		},
		close,
	};
}
