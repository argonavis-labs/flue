/**
 * Shared agent execution store interface.
 *
 * Both Cloudflare (DO SQLite) and Node (node:sqlite :memory:) implement this
 * contract using the same underlying SQL store. The interface is target-neutral
 * so that future persistent backends (Postgres, MySQL, Turso, etc.) can
 * implement it directly.
 */

import type { AgentSubmissionInput, DirectAgentSubmissionInput } from './runtime/agent-submissions.ts';
import type { DispatchInput } from './runtime/dispatch-queue.ts';
import type { SessionData, SessionStore } from './types.ts';

// ─── SQL storage adapter ────────────────────────────────────────────────────

/** Minimal SQLite storage interface shared by both Cloudflare DO and node:sqlite. */
export interface SqlStorage {
	exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

// ─── Durability defaults ────────────────────────────────────────────────────

/** Default maximum recovery attempts before terminalization. */
export const DURABILITY_DEFAULT_MAX_RETRY = 10;
/** Default submission timeout in minutes. */
export const DURABILITY_DEFAULT_TIMEOUT_MINUTES = 60;

// ─── Submission ─────────────────────────────────────────────────────────────

export type AgentSubmissionStatus = 'queued' | 'running' | 'recording_interruption' | 'settled';

export interface AgentSubmission {
	readonly sequence: number;
	readonly submissionId: string;
	readonly sessionKey: string;
	readonly kind: 'dispatch' | 'direct';
	readonly input: AgentSubmissionInput;
	readonly status: AgentSubmissionStatus;
	readonly acceptedAt: number;
	readonly attemptId?: string;
	readonly inputAppliedAt?: number;
	readonly recoveryRequestedAt?: number;
	readonly startedAt?: number;
	readonly error?: string;
	readonly attemptCount: number;
	readonly maxRetry: number;
	readonly timeoutAt: number;
}

export interface SubmissionAttemptRef {
	readonly submissionId: string;
	readonly attemptId: string;
}

// ─── Dispatch admission ─────────────────────────────────────────────────────

export interface AgentDispatchReceipt {
	readonly submissionId: string;
	readonly acceptedAt: number;
}

export type AgentDispatchAdmission =
	| { readonly kind: 'submission'; readonly submission: AgentSubmission }
	| { readonly kind: 'retained_receipt'; readonly receipt: AgentDispatchReceipt }
	| { readonly kind: 'conflict' };

// ─── Turn journal ───────────────────────────────────────────────────────────

export type AgentTurnJournalPhase =
	| 'before_provider'
	| 'provider_started'
	| 'tool_request_recorded'
	| 'committed';

export interface AgentTurnJournal {
	readonly submissionId: string;
	readonly sessionKey: string;
	readonly kind: 'dispatch' | 'direct';
	readonly attemptId: string;
	readonly operationId: string;
	readonly turnId: string;
	readonly phase: AgentTurnJournalPhase;
	readonly revision: number;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly checkpointLeafId?: string;
	readonly toolRequest?: unknown;
	readonly committed: boolean;
	readonly committedLeafId?: string;
}

export interface CreateTurnJournalInput {
	readonly submissionId: string;
	readonly sessionKey: string;
	readonly kind: 'dispatch' | 'direct';
	readonly attemptId: string;
	readonly operationId: string;
	readonly turnId: string;
	readonly phase: AgentTurnJournalPhase;
	readonly checkpointLeafId?: string;
	readonly toolRequest?: unknown;
}

// ─── Submission store ───────────────────────────────────────────────────────

export interface AgentSubmissionStore {
	// Query
	getSubmission(submissionId: string): AgentSubmission | null;
	getTurnJournal(submissionId: string): AgentTurnJournal | null;
	hasUnsettledSubmissions(): boolean;
	listRunnableSubmissions(): AgentSubmission[];
	listRunningSubmissions(): AgentSubmission[];

	// Turn journal lifecycle
	beginTurnJournal(input: CreateTurnJournalInput): boolean;
	updateTurnJournalPhase(
		attempt: SubmissionAttemptRef,
		phase: AgentTurnJournalPhase,
		options?: {
			checkpointLeafId?: string;
			toolRequest?: unknown;
		},
	): boolean;
	commitTurnJournal(attempt: SubmissionAttemptRef, committedLeafId: string): boolean;
	replaceTurnJournalAttempt(attempt: SubmissionAttemptRef, nextAttemptId: string): AgentSubmission | null;

	// Admission
	admitDispatch(input: DispatchInput): AgentDispatchAdmission;
	admitDirect(input: DirectAgentSubmissionInput): AgentSubmission;

	// Submission lifecycle
	claimSubmission(attempt: SubmissionAttemptRef, durability?: { maxRetry: number; timeoutAt: number }): AgentSubmission | null;
	markSubmissionInputApplied(attempt: SubmissionAttemptRef): boolean;
	requestSubmissionRecovery(attempt: SubmissionAttemptRef): boolean;
	requeueSubmissionBeforeInputApplied(attempt: SubmissionAttemptRef): boolean;
	beginSubmissionInterruptionRecording(attempt: SubmissionAttemptRef): boolean;
	completeSubmission(attempt: SubmissionAttemptRef): boolean;
	failSubmission(attempt: SubmissionAttemptRef, error: unknown): boolean;
	finishSubmissionInterruptionRecording(attempt: SubmissionAttemptRef, error: unknown): boolean;

	// Deletion
	deleteSession(sessionKey: string, deleteSessionTree: () => Promise<void>): Promise<void>;
}

// ─── Execution store ────────────────────────────────────────────────────────

export interface AgentExecutionStore {
	readonly sessions: SessionStore;
	readonly submissions: AgentSubmissionStore;
}
