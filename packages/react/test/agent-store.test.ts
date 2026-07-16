import type { FlueClient } from '@flue/sdk';
import { describe, expect, it, vi } from 'vitest';
import { createFlueAgentStore } from '../src/index.ts';
import { conversation, createFakeObservation } from './fixtures/observation.ts';

describe('createFlueAgentStore()', () => {
	it('retains its snapshot when observation is stopped and restarted', () => {
		const firstObservation = createFakeObservation();
		const secondObservation = createFakeObservation();
		const observe = vi
			.fn()
			.mockReturnValueOnce(firstObservation)
			.mockReturnValueOnce(secondObservation);
		const store = createFlueAgentStore({
			client: { agents: { observe } } as unknown as FlueClient,
			name: 'agent',
			id: 'conversation',
		});

		store.start();
		firstObservation.emit({
			conversation: conversation([
				{
					id: 'entry-user',
					role: 'user',
					purpose: 'user',
					display: 'visible',
					parts: [{ type: 'text', text: 'hello', state: 'done' }],
				},
			]),
			offset: 'offset-1',
			phase: 'live',
			error: undefined,
		});

		store.stop();
		expect(firstObservation.close).toHaveBeenCalledOnce();
		expect(store.getSnapshot().messages.map((message) => message.id)).toEqual(['entry-user']);

		store.start();
		expect(observe).toHaveBeenCalledTimes(2);
		expect(store.getSnapshot().messages.map((message) => message.id)).toEqual(['entry-user']);

		secondObservation.emit({
			conversation: conversation([
				{
					id: 'entry-user',
					role: 'user',
					purpose: 'user',
					display: 'visible',
					parts: [{ type: 'text', text: 'hello', state: 'done' }],
				},
				{
					id: 'entry-assistant',
					role: 'assistant',
					purpose: 'assistant',
					display: 'visible',
					parts: [],
					metadata: { model: { provider: 'test', id: 'model' } },
				},
			]),
			offset: 'offset-2',
			phase: 'live',
			error: undefined,
		});

		expect(store.getSnapshot().messages.map((message) => message.id)).toEqual([
			'entry-user',
			'entry-assistant',
		]);
		store.stop();
	});
});
