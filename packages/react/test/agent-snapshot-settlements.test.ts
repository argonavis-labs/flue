import type { FlueClient, FlueConversationSettlement } from '@flue/sdk';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { emptyAgentState, reduceAgentEvent } from '../src/agent-reducer.ts';
import { AgentSession } from '../src/agent-session.ts';
import { useFlueAgent } from '../src/use-agent.ts';
import { conversation, createFakeObservation } from './fixtures/observation.ts';

function client(overrides: Partial<FlueClient>): FlueClient {
	return overrides as FlueClient;
}

describe('AgentSnapshot settlements', () => {
	const failedSettlement: FlueConversationSettlement = {
		submissionId: 'submission-backend',
		outcome: 'failed',
		error: { message: 'provider exploded' },
	};

	it('carries observed conversation settlements onto the reducer state', () => {
		const state = reduceAgentEvent(emptyAgentState, {
			type: 'local_observation',
			conversation: conversation([], [failedSettlement]),
			phase: 'live',
			error: undefined,
		});

		// A backend-submitted turn is never a local send, so `error`/`failedSends`
		// cannot carry its failure — the settlement row is its only permanent record.
		expect(state.settlements).toEqual([failedSettlement]);
		expect(state.failedSends).toEqual([]);
		expect(state.error).toBeUndefined();
	});

	it('surfaces settlements on the session public snapshot', () => {
		const observation = createFakeObservation();
		const observe = vi.fn().mockReturnValue(observation);
		const session = new AgentSession(
			client({ agents: { observe } as unknown as FlueClient['agents'] }),
			'agent',
			'id',
		);

		session.start();
		expect(session.getSnapshot().settlements).toEqual([]);

		observation.emit({
			conversation: conversation([], [failedSettlement]),
			offset: 'offset-history',
			phase: 'live',
			error: undefined,
		});

		expect(session.getSnapshot().settlements).toEqual([failedSettlement]);
		session.dispose();
	});

	it('defaults settlements to an empty array before any conversation is observed', () => {
		expect(emptyAgentState.settlements).toEqual([]);

		// A dormant hook (no id yet) serves the module-level empty snapshot; it
		// must expose the same `settlements: []` default as the reducer state.
		const { result } = renderHook(() => useFlueAgent({ name: 'agent', client: client({}) }));
		expect(result.current.settlements).toEqual([]);
	});
});
