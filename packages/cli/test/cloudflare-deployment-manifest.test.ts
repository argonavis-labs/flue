import { describe, expect, it } from 'vitest';
import { createCloudflareDeploymentManifest } from '../src/lib/cloudflare-wrangler-merge.ts';

describe('createCloudflareDeploymentManifest()', () => {
	it('projects a representative generated wrangler config into the v1 manifest shape', () => {
		const manifest = createCloudflareDeploymentManifest(
			{
				name: 'fixture-worker',
				main: 'index.js',
				account_id: 'acct-123',
				compatibility_date: '2026-04-01',
				compatibility_flags: ['nodejs_compat'],
				observability: { enabled: true },
				vars: { MODE: 'production' },
				durable_objects: {
					bindings: [{ name: 'FLUE_ASSISTANT_AGENT', class_name: 'FlueAssistantAgent' }],
				},
				worker_loaders: [{ binding: 'SANDBOX_LOADER' }],
			},
			'dist/fixture-worker',
		);

		expect(manifest).toEqual({
			v: 1,
			worker: {
				name: 'fixture-worker',
				artifactRoot: 'dist/fixture-worker',
				main: 'index.js',
				accountId: 'acct-123',
				compatibilityDate: '2026-04-01',
				compatibilityFlags: ['nodejs_compat'],
				observability: { enabled: true },
			},
			vars: { MODE: 'production' },
			durableObjects: [{ binding: 'FLUE_ASSISTANT_AGENT', className: 'FlueAssistantAgent' }],
			workerLoaders: [{ binding: 'SANDBOX_LOADER' }],
		});
	});

	it('omits optional worker fields the generated config does not set', () => {
		const manifest = createCloudflareDeploymentManifest(
			{
				name: 'fixture-worker',
				main: 'index.js',
				compatibility_date: '2026-04-01',
			},
			'dist/fixture-worker',
		);

		expect(manifest.worker).not.toHaveProperty('accountId');
		expect(manifest.worker).not.toHaveProperty('observability');
		expect(manifest.worker.compatibilityFlags).toEqual([]);
		expect(manifest.vars).toEqual({});
		expect(manifest.durableObjects).toEqual([]);
		expect(manifest.workerLoaders).toEqual([]);
	});

	it('rejects a cross-script Durable Object binding a deploy driver could not honor', () => {
		expect(() =>
			createCloudflareDeploymentManifest(
				{
					name: 'fixture-worker',
					main: 'index.js',
					compatibility_date: '2026-04-01',
					durable_objects: {
						bindings: [
							{
								name: 'FLUE_ASSISTANT_AGENT',
								class_name: 'FlueAssistantAgent',
								script_name: 'other-worker',
							},
						],
					},
				},
				'dist/fixture-worker',
			),
		).toThrow('only supports local Durable Object bindings');
	});

	it('rejects a generated config missing a required worker field', () => {
		expect(() =>
			createCloudflareDeploymentManifest(
				{ main: 'index.js', compatibility_date: '2026-04-01' },
				'dist/fixture-worker',
			),
		).toThrow('missing worker.name');
	});
});
