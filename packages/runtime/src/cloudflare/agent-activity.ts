/** Queue-level turn activity, reported to an optional duck-typed `onFlueAgentActivity` instance method on the agent's DO class. At-least-once; timestamps come from the DO's clock. */
import type { AgentSubmissionSettlement } from '../runtime/agent-submissions.ts';
import { resolveAttachedCoordinator } from './app-signals.ts';

/** Working-heartbeat cadence in seconds; consumers derive staleness leases from this, never hardcode it. */
export const FLUE_AGENT_ACTIVITY_BEAT_SECONDS = 30;

/** One queue-level activity edge reported to `onFlueAgentActivity`. */
export type FlueAgentActivity =
	| { readonly type: 'working'; readonly at: Date }
	| { readonly type: 'idle'; readonly at: Date; readonly last?: AgentSubmissionSettlement };

/** True while the instance's submission queue has unsettled work. */
export async function agentQueueBusy(instance: object): Promise<boolean> {
	return resolveAttachedCoordinator(instance).queueBusy();
}

/** The submission's attempt counter (1 on first claim, +1 per recovery re-drive); undefined when unknown. */
export async function agentSubmissionAttemptCount(
	instance: object,
	submissionId: string,
): Promise<number | undefined> {
	return resolveAttachedCoordinator(instance).submissionAttemptCount(submissionId);
}
