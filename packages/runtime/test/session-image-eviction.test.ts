import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	registerFauxProvider,
} from '@earendil-works/pi-ai/compat';
import { afterEach, describe, expect, it } from 'vitest';
import { defineAgent } from '../src/index.ts';
import { createFlueContext } from '../src/internal.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

// The image bytes are incidental plumbing, not the behavior under test: each
// image only needs distinct, valid base64 so we can tell which survived in the
// provider request. `evicted` images have no bytes there at all.
const bytes = (label: string): string => Buffer.from(label).toString('base64');

const image = (label: string) =>
	({ type: 'image' as const, data: bytes(label), mimeType: 'image/png' });

const providers: FauxProviderRegistration[] = [];
afterEach(() => {
	for (const provider of providers.splice(0)) provider.unregister();
});

function createProvider(): FauxProviderRegistration {
	const provider = registerFauxProvider({
		provider: `session-image-eviction-test-${crypto.randomUUID()}`,
		models: [{ id: 'reviewer' }],
	});
	providers.push(provider);
	return provider;
}

function createContext(provider: FauxProviderRegistration) {
	return createFlueContext({
		id: 'session-image-eviction-instance',
		env: {},
		agentConfig: {
			resolveModel: (specifier) =>
				specifier ? provider.getModel(specifier.slice(specifier.indexOf('/') + 1)) : undefined,
		},
		createDefaultEnv: async () => createNoopSessionEnv(),
	});
}

describe('image-memory eviction', () => {
	it('evicts all but the newest maxImages images from the provider request when a session exceeds the cap', async () => {
		const provider = createProvider();
		let lastTurnMessages: unknown[] = [];
		provider.setResponses([
			fauxAssistantMessage('one'),
			fauxAssistantMessage('two'),
			(context) => {
				lastTurnMessages = context.messages;
				return fauxAssistantMessage('three');
			},
		]);
		const harness = await createContext(provider).initializeRootHarness(
			// compaction:false isolates eviction from token-driven image dropping.
			defineAgent(() => ({
				model: `${provider.getModel().provider}/reviewer`,
				compaction: false,
				imageMemory: { maxImages: 2 },
			})),
		);
		const session = await harness.session();

		await session.prompt('first', { images: [image('image-one')] });
		await session.prompt('second', { images: [image('image-two')] });
		await session.prompt('third', { images: [image('image-three')] });

		const json = JSON.stringify(lastTurnMessages);
		// Oldest image is evicted: its bytes are gone, replaced by a placeholder.
		expect(json).not.toContain(bytes('image-one'));
		expect(json).toContain('evicted />');
		// The newest two images are still sent to the model as real bytes.
		expect(json).toContain(bytes('image-two'));
		expect(json).toContain(bytes('image-three'));
	});

	it('keeps the three newest images by default when no imageMemory cap is configured', async () => {
		const provider = createProvider();
		let lastTurnMessages: unknown[] = [];
		provider.setResponses([
			fauxAssistantMessage('1'),
			fauxAssistantMessage('2'),
			fauxAssistantMessage('3'),
			(context) => {
				lastTurnMessages = context.messages;
				return fauxAssistantMessage('4');
			},
		]);
		const harness = await createContext(provider).initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer`, compaction: false })),
		);
		const session = await harness.session();

		await session.prompt('a', { images: [image('img-a')] });
		await session.prompt('b', { images: [image('img-b')] });
		await session.prompt('c', { images: [image('img-c')] });
		await session.prompt('d', { images: [image('img-d')] });

		const json = JSON.stringify(lastTurnMessages);
		expect(json).not.toContain(bytes('img-a')); // oldest evicted at the default cap of 3
		expect(json).toContain(bytes('img-b'));
		expect(json).toContain(bytes('img-c'));
		expect(json).toContain(bytes('img-d'));
	});
});
