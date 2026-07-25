/** Queue-level turn activity, reported to an optional duck-typed `onFlueAgentActivity` instance method on the agent's DO class. At-least-once; timestamps come from the DO's clock. */
import type { AgentSubmissionSettlement } from '../runtime/agent-submissions.ts';
import { resolveAttachedCoordinator } from './app-signals.ts';

/** Working-heartbeat cadence in seconds; consumers derive staleness leases from this, never hardcode it. */
export const FLUE_AGENT_ACTIVITY_BEAT_SECONDS = 30;

/** One queue-level activity edge reported to `onFlueAgentActivity`. */
export type FlueAgentActivity =
	| { readonly type: 'working'; readonly at: Date }
	| { readonly type: 'idle'; readonly at: Date; readonly last?: AgentSubmissionSettlement };

/**
 * A swallowed submission-reconciliation failure, reported to an optional
 * duck-typed `onFlueReconciliationFailure` instance method so the embedding DO
 * can surface the cause the coordinator otherwise logs and drops. Reconciliation
 * catches every failure, logs it, and re-arms the submission wake — so an
 * un-reconcilable submission loops silently unless the host observes it. This
 * carries the real `Error`, synchronously and in-process, alongside the failing
 * operation so the host can attribute the loop instead of only counting it.
 */
export type FlueReconciliationFailure = {
	/** The reconciliation step that threw and was swallowed. */
	readonly operation:
		| 'materialize_submission'
		| 'reconcile_submission'
		| 'start_submission'
		| 'reconcile'
		| 'list_attempt_markers';
	/**
	 * The coordinator's own outcome label for the swallow: the failure was
	 * deferred to the next scheduled wake, or a degraded read fell back to an
	 * empty marker set.
	 */
	readonly outcome: 'deferred_to_scheduled_wake' | 'degraded_to_empty_marker_set';
	readonly submissionId?: string;
	readonly attemptId?: string;
	readonly sessionKey?: string;
	readonly error: unknown;
};

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
