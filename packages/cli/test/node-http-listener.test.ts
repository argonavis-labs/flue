import { afterEach, describe, expect, it } from 'vitest';
import { createStableNodeListener, type LoadedNodeApplication } from '../src/lib/node-http-listener.ts';

const listeners: Array<ReturnType<typeof createStableNodeListener>> = [];

afterEach(async () => {
	await Promise.allSettled(listeners.splice(0).map((listener) => listener.stop()));
});

describe('createStableNodeListener()', () => {
	it('returns structured unavailable responses when no application is ready', async () => {
		const listener = createStableNodeListener({ port: 0 });
		listeners.push(listener);
		await listener.listen();

		const response = await fetch(listener.url);

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { type: 'runtime_unavailable', meta: { state: 'loading' } },
		});
	});

	it('delegates ready requests without changing authored responses', async () => {
		const listener = createStableNodeListener({ port: 0 });
		listeners.push(listener);
		await listener.listen();
		listener.install(application(() => new Response('authored', { status: 207, headers: { 'x-app': 'yes' } })));

		const response = await fetch(listener.url);

		expect(response.status).toBe(207);
		expect(response.headers.get('x-app')).toBe('yes');
		expect(await response.text()).toBe('authored');
	});

	it('keeps accepted requests alive while rejecting new requests during drain', async () => {
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const listener = createStableNodeListener({ port: 0 });
		listeners.push(listener);
		await listener.listen();
		let entered!: () => void;
		const didEnter = new Promise<void>((resolve) => {
			entered = resolve;
		});
		listener.install(application(async () => {
			entered();
			await pending;
			return new Response('settled');
		}));
		const accepted = fetch(listener.url);
		await didEnter;

		listener.beginDrain();
		const rejected = await fetch(listener.url);
		release();

		expect(rejected.status).toBe(503);
		expect(await accepted.then((response) => response.text())).toBe('settled');
	});
});

function application(
	fetch: LoadedNodeApplication['fetch'],
): LoadedNodeApplication {
	return {
		fetch,
		enterActivity: () => ({ release() {} }),
		pauseAdmissions() {},
		resumeAdmissions() {},
		waitForIdle: async () => undefined,
		stop: async () => undefined,
		closeSync() {},
	};
}
