import {
	type AgentSubmissionInput,
	createDispatchAgentSubmissionInput,
	type DirectAgentSubmissionInput,
	type DispatchAgentSubmissionInput,
} from '../runtime/agent-submissions.ts';
import type { DispatchInput } from '../runtime/dispatch-queue.ts';
import { createSessionStorageKey } from '../session-identity.ts';
import type { SessionData, SessionStore } from '../types.ts';

interface SqlResult {
	toArray(): SqlRow[];
}

type SqlRow = Record<string, unknown>;

interface SqlStorage {
	exec(query: string, ...bindings: unknown[]): SqlResult;
}

interface DurableObjectStorage {
	readonly sql?: SqlStorage;
	transactionSync?<T>(closure: () => T): T;
}

type SqlAgentSubmissionStatus = 'queued' | 'running' | 'recording_interruption' | 'settled';

interface SqlAgentDispatchReceipt {
	readonly submissionId: string;
	readonly acceptedAt: number;
}

type SqlAgentDispatchAdmission =
	| { readonly kind: 'submission'; readonly submission: SqlAgentSubmission }
	| { readonly kind: 'retained_receipt'; readonly receipt: SqlAgentDispatchReceipt }
	| { readonly kind: 'conflict' };

export interface SubmissionAttemptRef {
	readonly submissionId: string;
	readonly attemptId: string;
}

export interface SqlAgentSubmission {
	readonly sequence: number;
	readonly submissionId: string;
	readonly sessionKey: string;
	readonly kind: 'dispatch' | 'direct';
	readonly input: AgentSubmissionInput;
	readonly status: SqlAgentSubmissionStatus;
	readonly acceptedAt: number;
	readonly attemptId?: string;
	readonly inputAppliedAt?: number;
	readonly recoveryRequestedAt?: number;
	readonly startedAt?: number;
	readonly error?: string;
}

type SqlAgentTurnJournalPhase =
	| 'before_provider'
	| 'provider_started'
	| 'tool_request_recorded'
	| 'committed';

interface SqlAgentTurnJournal {
	readonly submissionId: string;
	readonly sessionKey: string;
	readonly kind: 'dispatch' | 'direct';
	readonly attemptId: string;
	readonly operationId: string;
	readonly turnId: string;
	readonly recoveryRootId: string;
	readonly phase: SqlAgentTurnJournalPhase;
	readonly revision: number;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly lastProgressAt: number;
	readonly checkpointLeafId?: string;
	readonly streamHighWater?: string;
	readonly toolRequest?: unknown;
	readonly toolState?: unknown;
	readonly committed: boolean;
	readonly committedLeafId?: string;
}

interface CreateTurnJournalInput {
	readonly submissionId: string;
	readonly sessionKey: string;
	readonly kind: 'dispatch' | 'direct';
	readonly attemptId: string;
	readonly operationId: string;
	readonly turnId: string;
	readonly recoveryRootId: string;
	readonly phase: SqlAgentTurnJournalPhase;
	readonly checkpointLeafId?: string;
	readonly streamHighWater?: string;
	readonly toolRequest?: unknown;
	readonly toolState?: unknown;
}

export interface SqlAgentSubmissionStore {
	getSubmission(submissionId: string): SqlAgentSubmission | null;
	getTurnJournal(submissionId: string): SqlAgentTurnJournal | null;
	beginTurnJournal(input: CreateTurnJournalInput): boolean;
	updateTurnJournalPhase(
		attempt: SubmissionAttemptRef,
		phase: SqlAgentTurnJournalPhase,
		options?: { checkpointLeafId?: string; streamHighWater?: string; toolRequest?: unknown; toolState?: unknown },
	): boolean;
	commitTurnJournal(attempt: SubmissionAttemptRef, committedLeafId: string): boolean;
	replaceTurnJournalAttempt(attempt: SubmissionAttemptRef, nextAttemptId: string): SqlAgentSubmission | null;
	cleanupCommittedTurnJournals(committedBefore: number, limit?: number): number;
	admitDispatch(input: DispatchInput): SqlAgentDispatchAdmission;
	admitDirect(input: DirectAgentSubmissionInput): SqlAgentSubmission;
	hasUnsettledSubmissions(): boolean;
	listRunnableSubmissions(): SqlAgentSubmission[];
	listRunningSubmissions(): SqlAgentSubmission[];
	deleteSession(sessionKey: string, deleteSessionTree: () => Promise<void>): Promise<void>;
	cleanupTerminalSubmissions(completedBefore: number, limit?: number): number;
	claimSubmission(attempt: SubmissionAttemptRef): SqlAgentSubmission | null;
	markSubmissionInputApplied(attempt: SubmissionAttemptRef): boolean;
	requestSubmissionRecovery(attempt: SubmissionAttemptRef): boolean;
	requeueSubmissionBeforeInputApplied(attempt: SubmissionAttemptRef): boolean;
	beginSubmissionInterruptionRecording(attempt: SubmissionAttemptRef): boolean;
	completeSubmission(attempt: SubmissionAttemptRef): boolean;
	failSubmission(attempt: SubmissionAttemptRef, error: unknown): boolean;
	finishSubmissionInterruptionRecording(attempt: SubmissionAttemptRef, error: unknown): boolean;
}

export interface SqlAgentExecutionStore {
	readonly sessions: SessionStore;
	readonly submissions: SqlAgentSubmissionStore;
}

export function createSqlSessionStore(sql: SqlStorage): SessionStore {
	ensureSessionTable(sql);
	return new SqlSessionStore(sql);
}

export function createSqlAgentExecutionStore(
	storage: DurableObjectStorage | undefined,
	className: string,
): SqlAgentExecutionStore {
	const sql = storage?.sql;
	const transactionSync = storage?.transactionSync;
	if (!sql || typeof sql.exec !== 'function' || typeof transactionSync !== 'function') {
		throw new Error(
			`[flue] Cloudflare durable agent class "${className}" requires Durable Object SQLite. ` +
				`Add "${className}" to a Wrangler migration's "new_sqlite_classes" list before its first deploy; ` +
				`do not use legacy "new_classes". Existing KV-backed Durable Object classes cannot be converted ` +
				`to SQLite in place.`,
		);
	}
	try {
		const sessions = createSqlSessionStore(sql);
		ensureSubmissionTable(sql);
		ensureTurnJournalTable(sql);
		const runTransaction = <T>(closure: () => T): T => transactionSync.call(storage, closure) as T;
		return {
			sessions,
			submissions: new SqlAgentSubmissionStoreImpl(sql, runTransaction),
		};
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		throw new Error(
			`[flue] Cloudflare durable agent class "${className}" could not initialize its SQLite execution store. ` +
				`Underlying error: ${detail}`,
			{ cause },
		);
	}
}

class SqlSessionStore implements SessionStore {
	constructor(private sql: SqlStorage) {}

	async save(id: string, data: SessionData): Promise<void> {
		this.sql.exec(
			'INSERT OR REPLACE INTO flue_sessions (id, data, updated_at) VALUES (?, ?, ?)',
			id,
			JSON.stringify(data),
			Date.now(),
		);
	}

	async load(id: string): Promise<SessionData | null> {
		const rows = this.sql.exec('SELECT data FROM flue_sessions WHERE id = ?', id).toArray();
		const row = rows[0];
		if (!row) return null;
		if (typeof row.data !== 'string') throw new Error('[flue] Persisted session row is malformed.');
		return JSON.parse(row.data) as SessionData;
	}

	async delete(id: string): Promise<void> {
		this.sql.exec('DELETE FROM flue_sessions WHERE id = ?', id);
	}
}

class SqlAgentSubmissionStoreImpl implements SqlAgentSubmissionStore {
	private pendingSessionDeletions = new Map<string, Promise<void>>();

	constructor(
		private sql: SqlStorage,
		private transactionSync: NonNullable<DurableObjectStorage['transactionSync']>,
	) {}

	getSubmission(submissionId: string): SqlAgentSubmission | null {
		const row = this.readSubmissionRow(submissionId);
		return row ? parseSubmission(row) : null;
	}

	getTurnJournal(submissionId: string): SqlAgentTurnJournal | null {
		const row = this.sql
			.exec(
				`SELECT submission_id, session_key, kind, attempt_id, operation_id, turn_id, recovery_root_id,
				        phase, revision, created_at, updated_at, last_progress_at, checkpoint_leaf_id,
				        stream_high_water, tool_request_json, tool_state_json, committed, committed_leaf_id
				 FROM flue_agent_turn_journals
				 WHERE submission_id = ?
				 LIMIT 1`,
				submissionId,
			)
			.toArray()[0];
		return row ? parseTurnJournal(row) : null;
	}

	beginTurnJournal(input: CreateTurnJournalInput): boolean {
		const now = Date.now();
		return (
			this.sql
				.exec(
					`INSERT INTO flue_agent_turn_journals
					 (submission_id, session_key, kind, attempt_id, operation_id, turn_id, recovery_root_id,
					  phase, revision, created_at, updated_at, last_progress_at, checkpoint_leaf_id,
					  stream_high_water, tool_request_json, tool_state_json, committed, committed_leaf_id)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
						 ON CONFLICT(submission_id) DO UPDATE SET
						  attempt_id = excluded.attempt_id,
						  operation_id = excluded.operation_id,
						  turn_id = excluded.turn_id,
						  phase = excluded.phase,
						  revision = flue_agent_turn_journals.revision + 1,
						  updated_at = excluded.updated_at,
						  last_progress_at = excluded.last_progress_at,
						  checkpoint_leaf_id = excluded.checkpoint_leaf_id,
						  stream_high_water = excluded.stream_high_water,
						  tool_request_json = excluded.tool_request_json,
						  tool_state_json = excluded.tool_state_json,
						  committed = 0,
						  committed_leaf_id = NULL
						 RETURNING submission_id`,

					input.submissionId,
					input.sessionKey,
					input.kind,
					input.attemptId,
					input.operationId,
					input.turnId,
					input.recoveryRootId,
					input.phase,
					now,
					now,
					now,
					input.checkpointLeafId ?? null,
					input.streamHighWater ?? null,
					input.toolRequest === undefined ? null : JSON.stringify(input.toolRequest),
					input.toolState === undefined ? null : JSON.stringify(input.toolState),
				)
				.toArray().length > 0
		);
	}

	updateTurnJournalPhase(
		attempt: SubmissionAttemptRef,
		phase: SqlAgentTurnJournalPhase,
		options: { checkpointLeafId?: string; streamHighWater?: string; toolRequest?: unknown; toolState?: unknown } = {},
	): boolean {
		const now = Date.now();
		return (
			this.sql
				.exec(
					`UPDATE flue_agent_turn_journals
					 SET phase = ?, revision = revision + 1, updated_at = ?, last_progress_at = ?,
					     checkpoint_leaf_id = COALESCE(?, checkpoint_leaf_id),
					     stream_high_water = COALESCE(?, stream_high_water),
					     tool_request_json = COALESCE(?, tool_request_json),
					     tool_state_json = COALESCE(?, tool_state_json)
					 WHERE submission_id = ? AND attempt_id = ? AND committed = 0
					 RETURNING submission_id`,
					phase,
					now,
					now,
					options.checkpointLeafId ?? null,
					options.streamHighWater ?? null,
					options.toolRequest === undefined ? null : JSON.stringify(options.toolRequest),
					options.toolState === undefined ? null : JSON.stringify(options.toolState),
					attempt.submissionId,
					attempt.attemptId,
				)
				.toArray().length > 0
		);
	}

	commitTurnJournal(attempt: SubmissionAttemptRef, committedLeafId: string): boolean {
		const now = Date.now();
		return (
			this.sql
				.exec(
					`UPDATE flue_agent_turn_journals
					 SET phase = 'committed', revision = revision + 1, updated_at = ?, last_progress_at = ?,
					     committed = 1, committed_leaf_id = ?
					 WHERE submission_id = ? AND attempt_id = ? AND committed = 0
					 RETURNING submission_id`,
					now,
					now,
					committedLeafId,
					attempt.submissionId,
					attempt.attemptId,
				)
				.toArray().length > 0
		);
	}

	replaceTurnJournalAttempt(attempt: SubmissionAttemptRef, nextAttemptId: string): SqlAgentSubmission | null {
		const row = this.sql
			.exec(
				`UPDATE flue_agent_submissions
				 SET attempt_id = ?, recovery_requested_at = NULL, started_at = ?
				 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
				 RETURNING ${submissionColumns}`,
				nextAttemptId,
				Date.now(),
				attempt.submissionId,
				attempt.attemptId,
			)
			.toArray()[0];
		if (!row) return null;
		this.sql.exec(
			`UPDATE flue_agent_turn_journals
			 SET attempt_id = ?, revision = revision + 1, updated_at = ?, last_progress_at = ?
			 WHERE submission_id = ? AND attempt_id = ? AND committed = 0`,
			nextAttemptId,
			Date.now(),
			Date.now(),
			attempt.submissionId,
			attempt.attemptId,
		);
		return parseSubmission(row);
	}

	cleanupCommittedTurnJournals(committedBefore: number, limit = 100): number {
		if (!Number.isInteger(limit) || limit <= 0) {
			throw new Error('[flue] Committed turn journal cleanup limit must be a positive integer.');
		}
		const rows = this.sql
			.exec(
				`SELECT submission_id
				 FROM flue_agent_turn_journals
				 WHERE committed = 1 AND updated_at < ?
				 ORDER BY updated_at ASC, submission_id ASC
				 LIMIT ?`,
				committedBefore,
				limit,
			)
			.toArray();
		for (const row of rows) {
			if (typeof row.submission_id !== 'string') {
				throw new Error('[flue] Persisted committed turn journal row is malformed.');
			}
			this.sql.exec(
				'DELETE FROM flue_agent_turn_journals WHERE submission_id = ? AND committed = 1 AND updated_at < ?',
				row.submission_id,
				committedBefore,
			);
		}
		return rows.length;
	}

	private getDispatchReceipt(submissionId: string): SqlAgentDispatchReceipt | null {
		const row = this.sql
			.exec(
				'SELECT dispatch_id, accepted_at FROM flue_agent_dispatch_receipts WHERE dispatch_id = ? LIMIT 1',
				submissionId,
			)
			.toArray()[0];
		if (!row) return null;
		if (typeof row.dispatch_id !== 'string' || typeof row.accepted_at !== 'number') {
			throw new Error('[flue] Persisted dispatch receipt row is malformed.');
		}
		return { submissionId: row.dispatch_id, acceptedAt: row.accepted_at };
	}

	admitDispatch(input: DispatchInput): SqlAgentDispatchAdmission {
		return this.admitSubmission(createDispatchAgentSubmissionInput(input));
	}

	admitDirect(input: DirectAgentSubmissionInput): SqlAgentSubmission {
		const admission = this.admitSubmission(input);
		if (admission.kind !== 'submission') {
			throw new Error('[flue] Internal direct admission returned an unexpected result.');
		}
		return admission.submission;
	}

	hasUnsettledSubmissions(): boolean {
		return (
			this.sql
				.exec(
					`SELECT 1
					 FROM flue_agent_submissions
					 WHERE status IN ('queued', 'running', 'recording_interruption')
					 LIMIT 1`,
				)
				.toArray().length > 0
		);
	}

	listRunnableSubmissions(): SqlAgentSubmission[] {
		const rows = this.sql
			.exec(
				`SELECT ${submissionColumnsFor('current')}
				 FROM flue_agent_submissions AS current
				 WHERE current.status = 'queued'
				   AND NOT EXISTS (
				     SELECT 1
				     FROM flue_agent_submissions AS earlier
				     WHERE earlier.session_key = current.session_key
				       AND earlier.status IN ('queued', 'running', 'recording_interruption')
				       AND earlier.sequence < current.sequence
				   )
				 ORDER BY current.sequence ASC`,
			)
			.toArray();
		return this.parseOperationalRows(rows, 'queued');
	}

	listRunningSubmissions(): SqlAgentSubmission[] {
		return this.parseOperationalRows(
			this.sql
				.exec(
					`SELECT ${submissionColumns}
					 FROM flue_agent_submissions
					 WHERE status IN ('running', 'recording_interruption')
					 ORDER BY sequence ASC`,
				)
				.toArray(),
			'active',
		);
	}

	deleteSession(sessionKey: string, deleteSessionTree: () => Promise<void>): Promise<void> {
		const pending = this.pendingSessionDeletions.get(sessionKey);
		if (pending) return pending;
		const deletion = this.runSessionDeletion(sessionKey, deleteSessionTree);
		this.pendingSessionDeletions.set(sessionKey, deletion);
		void deletion.then(
			() => this.clearPendingSessionDeletion(sessionKey, deletion),
			() => this.clearPendingSessionDeletion(sessionKey, deletion),
		);
		return deletion;
	}

	private async runSessionDeletion(sessionKey: string, deleteSessionTree: () => Promise<void>): Promise<void> {
		this.transactionSync(() => {
			const active = this.sql
				.exec(
					`SELECT 1
					 FROM flue_agent_submissions
					 WHERE session_key = ? AND status IN ('queued', 'running', 'recording_interruption')
					 LIMIT 1`,
					sessionKey,
				)
				.toArray();
			if (active.length > 0) {
				throw new Error(
					'[flue] Session cannot be deleted while durable agent submissions are queued or running. Wait for accepted work to settle, then retry deletion.',
				);
			}
			this.sql.exec(
				'INSERT OR IGNORE INTO flue_agent_session_deletions (session_key, started_at) VALUES (?, ?)',
				sessionKey,
				Date.now(),
			);
		});
		await deleteSessionTree();
		this.transactionSync(() => {
			this.sql.exec(
				`INSERT OR IGNORE INTO flue_agent_dispatch_receipts (dispatch_id, accepted_at, settled_at)
				 SELECT submission_id, accepted_at, settled_at
				 FROM flue_agent_submissions
				 WHERE session_key = ? AND kind = 'dispatch' AND status = 'settled'`,
				sessionKey,
			);
			this.sql.exec(
				`DELETE FROM flue_agent_submissions
				 WHERE session_key = ? AND status = 'settled'`,
				sessionKey,
			);
			this.sql.exec('DELETE FROM flue_agent_session_deletions WHERE session_key = ?', sessionKey);
		});
	}

	private clearPendingSessionDeletion(sessionKey: string, deletion: Promise<void>): void {
		if (this.pendingSessionDeletions.get(sessionKey) === deletion) {
			this.pendingSessionDeletions.delete(sessionKey);
		}
	}

	cleanupTerminalSubmissions(settledBefore: number, limit = 100): number {
		if (!Number.isInteger(limit) || limit <= 0) {
			throw new Error('[flue] Terminal submission cleanup limit must be a positive integer.');
		}
		const rows = this.sql
			.exec(
				`SELECT sequence
				 FROM flue_agent_submissions
				 WHERE status = 'settled' AND settled_at < ?
				 ORDER BY settled_at ASC, sequence ASC
				 LIMIT ?`,
				settledBefore,
				limit,
			)
			.toArray();
		for (const row of rows) {
			if (typeof row.sequence !== 'number') {
				throw new Error('[flue] Persisted terminal submission row is malformed.');
			}
			this.sql.exec(
				`DELETE FROM flue_agent_submissions
				 WHERE sequence = ? AND status = 'settled' AND settled_at < ?`,
				row.sequence,
				settledBefore,
			);
		}
		this.sql.exec(
			`DELETE FROM flue_agent_dispatch_receipts
			 WHERE dispatch_id IN (
			   SELECT dispatch_id
			   FROM flue_agent_dispatch_receipts
			   WHERE settled_at < ?
			   ORDER BY settled_at ASC, dispatch_id ASC
			   LIMIT ?
			 )`,
			settledBefore,
			limit,
		);
		return rows.length;
	}

	claimSubmission(attempt: SubmissionAttemptRef): SqlAgentSubmission | null {
		const row = this.sql
			.exec(
				`UPDATE flue_agent_submissions AS current
				 SET status = 'running', attempt_id = ?, started_at = ?
				 WHERE current.submission_id = ? AND current.status = 'queued'
				   AND NOT EXISTS (
				     SELECT 1
				     FROM flue_agent_submissions AS earlier
				     WHERE earlier.session_key = current.session_key
				       AND earlier.status IN ('queued', 'running', 'recording_interruption')
				       AND earlier.sequence < current.sequence
				   )
				 RETURNING ${submissionColumns}`,
				attempt.attemptId,
				Date.now(),
				attempt.submissionId,
			)
			.toArray()[0];
		return row ? parseSubmission(row) : null;
	}

	markSubmissionInputApplied(attempt: SubmissionAttemptRef): boolean {
		return this.updateOwnedSubmission(
			`UPDATE flue_agent_submissions
			 SET input_applied_at = COALESCE(input_applied_at, ?)
			 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
			 RETURNING submission_id`,
			Date.now(),
			attempt.submissionId,
			attempt.attemptId,
		);
	}

	requestSubmissionRecovery(attempt: SubmissionAttemptRef): boolean {
		return this.updateOwnedSubmission(
			`UPDATE flue_agent_submissions
			 SET recovery_requested_at = COALESCE(recovery_requested_at, ?)
			 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
			 RETURNING submission_id`,
			Date.now(),
			attempt.submissionId,
			attempt.attemptId,
		);
	}

	requeueSubmissionBeforeInputApplied(attempt: SubmissionAttemptRef): boolean {
		return (
			this.sql
				.exec(
					`UPDATE flue_agent_submissions
					 SET status = 'queued', attempt_id = NULL, recovery_requested_at = NULL, started_at = NULL
					 WHERE submission_id = ? AND status = 'running'
					   AND attempt_id = ? AND input_applied_at IS NULL
					 RETURNING submission_id`,
					attempt.submissionId,
					attempt.attemptId,
				)
				.toArray().length > 0
		);
	}

	beginSubmissionInterruptionRecording(attempt: SubmissionAttemptRef): boolean {
		return this.updateOwnedSubmission(
			`UPDATE flue_agent_submissions
			 SET status = 'recording_interruption'
			 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
			 RETURNING submission_id`,
			attempt.submissionId,
			attempt.attemptId,
		);
	}

	completeSubmission(attempt: SubmissionAttemptRef): boolean {
		return this.updateOwnedSubmission(
			`UPDATE flue_agent_submissions
			 SET status = 'settled', settled_at = ?, error = NULL
			 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
			 RETURNING submission_id`,
			Date.now(),
			attempt.submissionId,
			attempt.attemptId,
		);
	}

	failSubmission(attempt: SubmissionAttemptRef, error: unknown): boolean {
		return this.updateOwnedSubmission(
			`UPDATE flue_agent_submissions
			 SET status = 'settled', settled_at = ?, error = ?
			 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
			 RETURNING submission_id`,
			Date.now(),
			error instanceof Error ? error.message : String(error),
			attempt.submissionId,
			attempt.attemptId,
		);
	}

	finishSubmissionInterruptionRecording(attempt: SubmissionAttemptRef, error: unknown): boolean {
		return this.updateOwnedSubmission(
			`UPDATE flue_agent_submissions
			 SET status = 'settled', settled_at = ?, error = ?
			 WHERE submission_id = ? AND status = 'recording_interruption' AND attempt_id = ?
			 RETURNING submission_id`,
			Date.now(),
			error instanceof Error ? error.message : String(error),
			attempt.submissionId,
			attempt.attemptId,
		);
	}

	private admitSubmission(input: AgentSubmissionInput): SqlAgentDispatchAdmission {
		const { kind, submissionId } = input;
		const payload = JSON.stringify(input);
		const acceptedAt = parseAcceptedAt(input.acceptedAt, `${kind} admission`);
		const sessionKey = createSessionStorageKey(input.id, 'default', input.session);
		return this.transactionSync(() => {
			if (kind === 'dispatch') {
				const receipt = this.getDispatchReceipt(submissionId);
				if (receipt) return { kind: 'retained_receipt', receipt };
			}
			const deleting = this.sql
				.exec('SELECT 1 FROM flue_agent_session_deletions WHERE session_key = ? LIMIT 1', sessionKey)
				.toArray();
			if (deleting.length > 0) {
				throw new Error('[flue] Durable agent submission admission is unavailable while this session is being deleted. Retry after deletion completes.');
			}
			this.sql.exec(
				`INSERT OR IGNORE INTO flue_agent_submissions
				 (submission_id, session_key, kind, payload, status, accepted_at)
				 VALUES (?, ?, ?, ?, 'queued', ?)`,
				submissionId,
				sessionKey,
				kind,
				payload,
				acceptedAt,
			);
			const row = this.readSubmissionRow(submissionId);
			if (!row) throw new Error(`[flue] Durable ${kind} admission did not create a submission row.`);
			if (row.kind !== kind || row.payload !== payload) return { kind: 'conflict' };
			return { kind: 'submission', submission: parseSubmission(row) };
		});
	}

	private updateOwnedSubmission(query: string, ...bindings: unknown[]): boolean {
		return this.sql.exec(query, ...bindings).toArray().length > 0;
	}

	private parseOperationalRows(
		rows: SqlRow[],
		status: 'queued' | 'active',
	): SqlAgentSubmission[] {
		const submissions: SqlAgentSubmission[] = [];
		for (const row of rows) {
			try {
				submissions.push(parseSubmission(row));
			} catch (error) {
				if (typeof row.sequence !== 'number') throw error;
				this.failSubmissionSequence(row.sequence, status, error);
			}
		}
		return submissions;
	}

	private failSubmissionSequence(sequence: number, status: 'queued' | 'active', error: unknown): void {
		this.sql.exec(
			`UPDATE flue_agent_submissions
			 SET status = 'settled', settled_at = ?, error = ?
			 WHERE sequence = ? AND ${status === 'queued' ? "status = 'queued'" : "status IN ('running', 'recording_interruption')"}`,
			Date.now(),
			error instanceof Error ? error.message : String(error),
			sequence,
		);
	}

	private readSubmissionRow(submissionId: string): SqlRow | undefined {
		return this.sql
			.exec(
				`SELECT ${submissionColumns}
				 FROM flue_agent_submissions
				 WHERE submission_id = ?
				 LIMIT 1`,
				submissionId,
			)
			.toArray()[0];
	}
}

const submissionColumns =
	'sequence, submission_id, session_key, kind, payload, status, accepted_at, attempt_id, input_applied_at, recovery_requested_at, started_at, error';

function submissionColumnsFor(table: string): string {
	return submissionColumns
		.split(', ')
		.map((column) => `${table}.${column}`)
		.join(', ');
}

function parseTurnJournal(row: SqlRow): SqlAgentTurnJournal {
	if (
		typeof row.submission_id !== 'string' ||
		typeof row.session_key !== 'string' ||
		(row.kind !== 'dispatch' && row.kind !== 'direct') ||
		typeof row.attempt_id !== 'string' ||
		typeof row.operation_id !== 'string' ||
		typeof row.turn_id !== 'string' ||
		typeof row.recovery_root_id !== 'string' ||
		(row.phase !== 'before_provider' &&
			row.phase !== 'provider_started' &&
			row.phase !== 'tool_request_recorded' &&
			row.phase !== 'committed') ||
		typeof row.revision !== 'number' ||
		typeof row.created_at !== 'number' ||
		typeof row.updated_at !== 'number' ||
		typeof row.last_progress_at !== 'number' ||
		(row.checkpoint_leaf_id !== null && row.checkpoint_leaf_id !== undefined && typeof row.checkpoint_leaf_id !== 'string') ||
		(row.stream_high_water !== null && row.stream_high_water !== undefined && typeof row.stream_high_water !== 'string') ||
		(row.committed !== 0 && row.committed !== 1) ||
		(row.committed_leaf_id !== null && row.committed_leaf_id !== undefined && typeof row.committed_leaf_id !== 'string')
	) {
		throw new Error('[flue] Persisted turn journal row is malformed.');
	}
	return {
		submissionId: row.submission_id,
		sessionKey: row.session_key,
		kind: row.kind,
		attemptId: row.attempt_id,
		operationId: row.operation_id,
		turnId: row.turn_id,
		recoveryRootId: row.recovery_root_id,
		phase: row.phase,
		revision: row.revision,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastProgressAt: row.last_progress_at,
		...(typeof row.checkpoint_leaf_id === 'string' ? { checkpointLeafId: row.checkpoint_leaf_id } : {}),
		...(typeof row.stream_high_water === 'string' ? { streamHighWater: row.stream_high_water } : {}),
		...(typeof row.tool_request_json === 'string' ? { toolRequest: JSON.parse(row.tool_request_json) as unknown } : {}),
		...(typeof row.tool_state_json === 'string' ? { toolState: JSON.parse(row.tool_state_json) as unknown } : {}),
		committed: row.committed === 1,
		...(typeof row.committed_leaf_id === 'string' ? { committedLeafId: row.committed_leaf_id } : {}),
	};
}

function parseSubmission(row: SqlRow): SqlAgentSubmission {
	if (
		typeof row.sequence !== 'number' ||
		typeof row.submission_id !== 'string' ||
		typeof row.session_key !== 'string' ||
		(row.kind !== 'dispatch' && row.kind !== 'direct') ||
		typeof row.payload !== 'string' ||
		(row.status !== 'queued' &&
			row.status !== 'running' &&
			row.status !== 'recording_interruption' &&
			row.status !== 'settled') ||
		typeof row.accepted_at !== 'number' ||
		(row.attempt_id !== null && row.attempt_id !== undefined && typeof row.attempt_id !== 'string') ||
		(row.input_applied_at !== null &&
			row.input_applied_at !== undefined &&
			typeof row.input_applied_at !== 'number') ||
		(row.recovery_requested_at !== null &&
			row.recovery_requested_at !== undefined &&
			typeof row.recovery_requested_at !== 'number') ||
		(row.started_at !== null && row.started_at !== undefined && typeof row.started_at !== 'number') ||
		(row.status === 'queued' &&
			(row.attempt_id !== null ||
				row.input_applied_at !== null ||
				row.recovery_requested_at !== null ||
				row.started_at !== null)) ||
		((row.status === 'running' || row.status === 'recording_interruption') &&
			(typeof row.attempt_id !== 'string' || typeof row.started_at !== 'number'))
	) {
		throw new Error('[flue] Persisted agent submission row is malformed.');
	}
	const input = JSON.parse(row.payload) as unknown;
	if (!isSubmissionPayload(input, row)) {
		throw new Error('[flue] Persisted agent submission payload is malformed.');
	}
	return {
		sequence: row.sequence,
		submissionId: row.submission_id,
		sessionKey: row.session_key,
		kind: row.kind,
		input,
		status: row.status,
		acceptedAt: row.accepted_at,
		...(typeof row.attempt_id === 'string' ? { attemptId: row.attempt_id } : {}),
		...(typeof row.input_applied_at === 'number' ? { inputAppliedAt: row.input_applied_at } : {}),
		...(typeof row.recovery_requested_at === 'number'
			? { recoveryRequestedAt: row.recovery_requested_at }
			: {}),
		...(typeof row.started_at === 'number' ? { startedAt: row.started_at } : {}),
		...(typeof row.error === 'string' ? { error: row.error } : {}),
	};
}

function isSubmissionPayload(input: unknown, row: SqlRow): input is AgentSubmissionInput {
	if (!input || typeof input !== 'object') return false;
	const value = input as Partial<AgentSubmissionInput>;
	if (value.kind !== row.kind || value.submissionId !== row.submission_id) return false;
	if (value.kind === 'dispatch') {
		const dispatch = value as Partial<DispatchAgentSubmissionInput>;
		return (
			typeof dispatch.dispatchId === 'string' &&
			dispatch.dispatchId === value.submissionId &&
			typeof dispatch.agent === 'string' &&
			typeof dispatch.id === 'string' &&
			typeof dispatch.session === 'string' &&
			createSessionStorageKey(dispatch.id, 'default', dispatch.session) === row.session_key &&
			typeof dispatch.acceptedAt === 'string' &&
			Date.parse(dispatch.acceptedAt) === row.accepted_at &&
			'input' in dispatch &&
			dispatch.input !== undefined
		);
	}
	const direct = value as Partial<DirectAgentSubmissionInput>;
	return (
		typeof direct.agent === 'string' &&
		typeof direct.id === 'string' &&
		typeof direct.session === 'string' &&
		createSessionStorageKey(direct.id, 'default', direct.session) === row.session_key &&
		typeof direct.acceptedAt === 'string' &&
		Date.parse(direct.acceptedAt) === row.accepted_at &&
		isDirectPayload(direct.payload)
	);
}

function isDirectPayload(value: unknown): boolean {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const payload = value as { message?: unknown; session?: unknown };
	return (
		typeof payload.message === 'string' &&
		(payload.session === undefined || typeof payload.session === 'string')
	);
}

function parseAcceptedAt(value: string, label: string): number {
	const acceptedAt = Date.parse(value);
	if (!Number.isFinite(acceptedAt)) {
		throw new Error(`[flue] Internal ${label} received an invalid acceptedAt timestamp.`);
	}
	return acceptedAt;
}

function ensureSessionTable(sql: SqlStorage): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_sessions (
		 id TEXT PRIMARY KEY,
		 data TEXT NOT NULL,
		 updated_at INTEGER NOT NULL
		)`,
	);
}

function ensureTurnJournalTable(sql: SqlStorage): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_agent_turn_journals (
		 submission_id TEXT PRIMARY KEY,
		 session_key TEXT NOT NULL,
		 kind TEXT NOT NULL,
		 attempt_id TEXT NOT NULL,
		 operation_id TEXT NOT NULL,
		 turn_id TEXT NOT NULL,
		 recovery_root_id TEXT NOT NULL,
		 phase TEXT NOT NULL,
		 revision INTEGER NOT NULL,
		 created_at INTEGER NOT NULL,
		 updated_at INTEGER NOT NULL,
		 last_progress_at INTEGER NOT NULL,
		 checkpoint_leaf_id TEXT,
		 stream_high_water TEXT,
		 tool_request_json TEXT,
		 tool_state_json TEXT,
		 committed INTEGER NOT NULL DEFAULT 0,
		 committed_leaf_id TEXT
		)`,
	);
	sql.exec(
		'CREATE INDEX IF NOT EXISTS flue_agent_turn_journals_session_updated_idx ON flue_agent_turn_journals (session_key, updated_at ASC)',
	);
	sql.exec(
		'CREATE INDEX IF NOT EXISTS flue_agent_turn_journals_committed_updated_idx ON flue_agent_turn_journals (committed, updated_at ASC)',
	);
}

function ensureSubmissionTable(sql: SqlStorage): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_agent_submissions (
		 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
		 submission_id TEXT NOT NULL UNIQUE,
		 session_key TEXT NOT NULL,
		 kind TEXT NOT NULL,
		 payload TEXT NOT NULL,
		 status TEXT NOT NULL,
		 accepted_at INTEGER NOT NULL,
		 attempt_id TEXT,
		 input_applied_at INTEGER,
		 recovery_requested_at INTEGER,
		 started_at INTEGER,
		 settled_at INTEGER,
		 error TEXT
		)`,
	);
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_agent_session_deletions (
		 session_key TEXT PRIMARY KEY,
		 started_at INTEGER NOT NULL
		)`,
	);
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_agent_dispatch_receipts (
		 dispatch_id TEXT PRIMARY KEY,
		 accepted_at INTEGER NOT NULL,
		 settled_at INTEGER NOT NULL
		)`,
	);
	sql.exec(
		'CREATE INDEX IF NOT EXISTS flue_agent_submissions_status_sequence_idx ON flue_agent_submissions (status, sequence ASC)',
	);
	sql.exec(
		'CREATE INDEX IF NOT EXISTS flue_agent_submissions_session_status_sequence_idx ON flue_agent_submissions (session_key, status, sequence ASC)',
	);
	sql.exec(
		'CREATE INDEX IF NOT EXISTS flue_agent_dispatch_receipts_settled_at_dispatch_id_idx ON flue_agent_dispatch_receipts (settled_at ASC, dispatch_id ASC)',
	);
}
