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

// ─── Durability defaults ────────────────────────────────────────────────────

/** Default maximum recovery attempts before terminalization. */
export const DURABILITY_DEFAULT_MAX_RETRY = 10;
/** Default submission timeout in minutes. */
export const DURABILITY_DEFAULT_TIMEOUT_MINUTES = 60;

// ─── Submission ─────────────────────────────────────────────────────────────

type AgentSubmissionStatus = 'queued' | 'running' | 'settled';

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

export interface SubmissionDurability {
	readonly maxRetry: number;
	readonly timeoutAt: number;
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
	getSubmission(submissionId: string): Promise<AgentSubmission | null>;
	getTurnJournal(submissionId: string): Promise<AgentTurnJournal | null>;
	hasUnsettledSubmissions(): Promise<boolean>;
	listRunnableSubmissions(): Promise<AgentSubmission[]>;
	listRunningSubmissions(): Promise<AgentSubmission[]>;

	// Turn journal lifecycle
	beginTurnJournal(input: CreateTurnJournalInput): Promise<boolean>;
	updateTurnJournalPhase(
		attempt: SubmissionAttemptRef,
		phase: AgentTurnJournalPhase,
		options?: {
			checkpointLeafId?: string;
			toolRequest?: unknown;
		},
	): Promise<boolean>;
	commitTurnJournal(attempt: SubmissionAttemptRef, committedLeafId: string): Promise<boolean>;
	replaceTurnJournalAttempt(attempt: SubmissionAttemptRef, nextAttemptId: string): Promise<AgentSubmission | null>;

	// Admission
	admitDispatch(input: DispatchInput): Promise<AgentDispatchAdmission>;
	admitDirect(input: DirectAgentSubmissionInput): Promise<AgentSubmission>;

	// Submission lifecycle
	claimSubmission(attempt: SubmissionAttemptRef): Promise<AgentSubmission | null>;
	markSubmissionInputApplied(attempt: SubmissionAttemptRef, durability?: SubmissionDurability): Promise<boolean>;
	requestSubmissionRecovery(attempt: SubmissionAttemptRef): Promise<boolean>;
	requeueSubmissionBeforeInputApplied(attempt: SubmissionAttemptRef): Promise<boolean>;
	completeSubmission(attempt: SubmissionAttemptRef): Promise<boolean>;
	failSubmission(attempt: SubmissionAttemptRef, error: unknown): Promise<boolean>;

	// Deletion
	deleteSession(sessionKey: string, deleteSessionTree: () => Promise<void>): Promise<void>;
}

// ─── Execution store ────────────────────────────────────────────────────────

export interface AgentExecutionStore {
	readonly sessions: SessionStore;
	readonly submissions: AgentSubmissionStore;
}

// ─── Persistence adapter ────────────────────────────────────────────────────

/**
 * A persistence adapter provides an {@link AgentExecutionStore} backed by a
 * specific database. Users configure persistence by creating a `db.ts` file
 * in their source root and default-exporting an adapter.
 *
 * Adapter packages export a factory function that returns this interface.
 * The built-in `sqlite()` adapter is available from `@flue/runtime/node`.
 *
 * Lifecycle: the framework calls `migrate()` (if present) once at startup
 * to ensure the schema exists, then calls `connect()` to obtain the store.
 * On shutdown, `close()` is called to release resources.
 */
export interface PersistenceAdapter {
	/** Open the database connection and return the execution store. */
	connect(): AgentExecutionStore;
	/**
	 * Run idempotent schema setup (CREATE TABLE IF NOT EXISTS, etc.).
	 * Called once at startup before {@link connect}. Adapters that create
	 * schema implicitly (e.g. LMDB) may omit this method.
	 */
	migrate?(): void | Promise<void>;
	/** Gracefully release resources (connection pools, file handles). */
	close?(): void | Promise<void>;
}
