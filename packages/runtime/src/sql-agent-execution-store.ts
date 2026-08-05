/**
 * Shared SQL agent execution store implementation.
 *
 * Used by both Cloudflare (DO SQLite) and Node (`node:sqlite`). Contains all
 * SQL-level storage logic — table DDL, row parsing, and the
 * {@link AgentSubmissionStore} implementation.
 *
 * Platform-specific wiring (opening the database, providing a transaction
 * wrapper) lives in `cloudflare/agent-execution-store.ts` and
 * `node/agent-execution-store.ts`.
 *
 * INTERNAL convenience, scoped to the SQLite dialect family (`node:sqlite`
 * and Durable Object SQLite). Do NOT generalize this module across SQL
 * dialects: there is deliberately no generic-SQL abstraction spanning
 * SQLite and Postgres, and `@flue/postgres` implements the store contract
 * directly on purpose. Cross-backend parity is enforced by the documented
 * invariants on the store interfaces and the contract suites in
 * `@flue/runtime/test-utils` — the only shared code is the storage-agnostic
 * admission algorithm (`admitSubmissionWithBackend`) in adapter-helpers.
 */

import { admitSubmissionWithBackend, isSubmissionPayload } from './adapter-helpers.ts';
import type {
	AgentAttemptMarker,
	AgentDispatchAdmission,
	AgentDispatchReceipt,
	AgentExecutionStore,
	AgentSubmission,
	AgentSubmissionStore,
	SubmissionAttemptRef,
	SubmissionClaimRef,
	SubmissionSettlementObligation,
} from './agent-execution-store.ts';
import {
	DURABILITY_DEFAULT_MAX_ATTEMPTS,
	DURABILITY_DEFAULT_TIMEOUT_MS,
	LEASE_DURATION_MS,
} from './agent-execution-store.ts';
import { PersistedRowInvariantError } from './errors.ts';
import type { SqlStorage } from './sql-storage.ts';

type SqlRow = Record<string, unknown>;

import {
	hydratePersistedSubmissionAttachments,
	submissionChunkOwner,
} from './persisted-image-placement.ts';
import {
	type AgentSubmissionInput,
	createDispatchAgentSubmissionInput,
} from './runtime/agent-submissions.ts';
import type { DispatchInput } from './runtime/dispatch-queue.ts';
import { migrateFlueSqlSchema } from './schema-version.ts';
import {
	createSqlPersistedChunkStore,
	ensureSqlPersistedChunkTable,
} from './sql-persisted-chunk-store.ts';

// A single `parseOperationalRows` call hydrates a batch of pending submissions
// into memory at once, each holding its reassembled image attachments.
// MAX_SUBMISSION_IMAGE_DATA_LENGTH caps ONE message, but a burst of image-bearing
// submissions could still sum past the isolate on load. Bound the batch too: stop
// admitting rows once the cumulative attachment size would exceed this budget,
// checked BEFORE hydrating (via a cheap size query) so an over-budget row is never
// reassembled. The deferred rows stay unsettled and the coordinator re-arms the
// submission wake while any submission is unsettled, so they drain over subsequent
// ticks rather than OOM on one load.
//
// Scope and margin, stated honestly: this is a per-list-call budget, and one
// Cloudflare reconcile pass runs three such lists in sequence (unready, running,
// runnable). A submission is in exactly one of those states and each list's array
// is unreferenced between the loops (GC-eligible before the next allocation), so
// the practical peak is one list's worth, not the sum. The dominant term is a
// single message's ~2x reassembly transient (≤ MAX_SUBMISSION_IMAGE_DATA_LENGTH,
// which the per-message cap already bounds); 32 MiB of accumulated batch on top of
// that stays under a 128 MB isolate. The constant guards the Cloudflare DO isolate
// specifically; the node coordinator shares this store and inherits it harmlessly
// (it is not isolate-bounded). "Bytes" is `data.length`, a character count
// (base64, ~1 byte each), matching MAX_IMAGE_DATA_LENGTH.
const MAX_RECONCILE_ATTACHMENT_BYTES = 32 * 1024 * 1024;

export function ensureSqlAgentExecutionTables(sql: SqlStorage): void {
	migrateFlueSqlSchema(sql, () => {
		ensureSubmissionTable(sql);
		ensureSqlPersistedChunkTable(sql);
	});
}

/** The greatest durably settled completed submission. */
export interface LatestCompletedSubmission {
	readonly sequence: number;
	readonly submissionId: string;
}

/** A query, not a store method: {@link AgentSubmissionStore} is one contract for every backend and only the Cloudflare coordinator needs this read. */
export function readLatestCompletedSubmission(
	sql: SqlStorage,
): LatestCompletedSubmission | undefined {
	// A direct submission proves completion with its settlement record; a dispatch
	// row has none and is complete exactly when `error` is null.
	const row = sql
		.exec(
			`SELECT sequence, submission_id
			 FROM flue_agent_submissions
			 WHERE status = 'settled'
			   AND ((kind = 'direct'
			         AND settlement_record_json IS NOT NULL
			         AND json_extract(settlement_record_json, '$.outcome') = 'completed')
			        OR (kind = 'dispatch'
			            AND settlement_record_json IS NULL
			            AND error IS NULL))
			 ORDER BY sequence DESC
			 LIMIT 1`,
		)
		.toArray()[0];
	if (!row) return undefined;
	if (typeof row.sequence !== 'number' || typeof row.submission_id !== 'string') {
		throw new PersistedRowInvariantError({
			table: 'flue_agent_submissions',
			reason: 'A settled submission row has a non-numeric sequence or a non-string submission_id.',
		});
	}
	return { sequence: row.sequence, submissionId: row.submission_id };
}

/**
 * Initialize an {@link AgentExecutionStore} from raw SQL primitives.
 * Used by both Cloudflare (DO SQLite) and Node (`node:sqlite`).
 *
 * **Does not run DDL.** Call {@link ensureSqlAgentExecutionTables} first
 * to ensure the schema exists.
 */
export function createSqlAgentExecutionStoreFromSql(
	sql: SqlStorage,
	runTransaction: <T>(closure: () => T) => T,
): AgentExecutionStore {
	return {
		submissions: new AgentSubmissionStoreImpl(sql, runTransaction),
	};
}

class AgentSubmissionStoreImpl implements AgentSubmissionStore {
	constructor(
		private sql: SqlStorage,
		private transactionSync: <T>(closure: () => T) => T,
	) {}

	async getSubmission(submissionId: string): Promise<AgentSubmission | null> {
		const row = this.readSubmissionRow(submissionId);
		return row ? this.parseSubmission(row) : null;
	}

	async replaceSubmissionAttempt(
		attempt: SubmissionAttemptRef,
		nextAttemptId: string,
		lease?: { ownerId: string; leaseExpiresAt: number },
	): Promise<AgentSubmission | null> {
		const now = Date.now();
		const row = this.sql
			.exec(
				`UPDATE flue_agent_submissions
				 SET attempt_id = ?, recovery_requested_at = NULL, started_at = ?, attempt_count = attempt_count + 1${
						lease ? ', owner_id = ?, lease_expires_at = ?' : ''
					}
				 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
				 RETURNING ${submissionColumns}`,
				...(lease
					? [
							nextAttemptId,
							now,
							lease.ownerId,
							lease.leaseExpiresAt,
							attempt.submissionId,
							attempt.attemptId,
						]
					: [nextAttemptId, now, attempt.submissionId, attempt.attemptId]),
			)
			.toArray()[0];
		return row ? this.parseSubmission(row) : null;
	}

	private getDispatchReceipt(submissionId: string): AgentDispatchReceipt | null {
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

	async admitDispatch(input: DispatchInput): Promise<AgentDispatchAdmission> {
		return this.admitSubmission(createDispatchAgentSubmissionInput(input));
	}

	async admitDirect(input: AgentSubmissionInput): Promise<AgentSubmission> {
		const admission = this.admitSubmission(input);
		if (admission.kind !== 'submission') {
			throw new Error('[flue] Internal direct admission returned an unexpected result.');
		}
		return admission.submission;
	}

	async markSubmissionCanonicalReady(submissionId: string): Promise<AgentSubmission | null> {
		const row = this.sql
			.exec(
				`UPDATE flue_agent_submissions
				 SET canonical_ready_at = COALESCE(canonical_ready_at, ?)
				 WHERE submission_id = ? AND status = 'queued'
				 RETURNING ${submissionColumns}`,
				Date.now(),
				submissionId,
			)
			.toArray()[0];
		return row ? this.parseSubmission(row) : null;
	}

	async hasUnsettledSubmissions(): Promise<boolean> {
		return (
			this.sql
				.exec(
					`SELECT 1
					 FROM flue_agent_submissions
				 WHERE status IN ('queued', 'running', 'terminalizing')
				 LIMIT 1`,
				)
				.toArray().length > 0
		);
	}

	async listUnreadySubmissions(): Promise<AgentSubmission[]> {
		return this.parseOperationalRows(
			this.sql
				.exec(
					`SELECT ${submissionColumns}
					 FROM flue_agent_submissions
					 WHERE status = 'queued' AND canonical_ready_at IS NULL
					 ORDER BY sequence ASC`,
				)
				.toArray(),
			'queued',
		);
	}

	async listRunnableSubmissions(): Promise<AgentSubmission[]> {
		const rows = this.sql
			.exec(
				`SELECT ${submissionColumnsFor('current')}
				 FROM flue_agent_submissions AS current
				 WHERE current.status = 'queued'
				   AND current.canonical_ready_at IS NOT NULL
				   AND NOT EXISTS (
				     SELECT 1
				     FROM flue_agent_submissions AS earlier
				     WHERE earlier.session_key = current.session_key
				       AND earlier.status IN ('queued', 'running', 'terminalizing')
				       AND earlier.sequence < current.sequence
				   )
				 ORDER BY current.sequence ASC`,
			)
			.toArray();
		return this.parseOperationalRows(rows, 'queued');
	}

	async listRunningSubmissions(): Promise<AgentSubmission[]> {
		return this.parseOperationalRows(
			this.sql
				.exec(
					`SELECT ${submissionColumns}
					 FROM flue_agent_submissions
					 WHERE status = 'running'
					 ORDER BY sequence ASC`,
				)
				.toArray(),
			'active',
		);
	}

	async listPendingSubmissionSettlements(): Promise<SubmissionSettlementObligation[]> {
		return this.sql
			.exec(
				`SELECT submission_id, session_key, attempt_id, settlement_record_id,
				        settlement_record_json
				 FROM flue_agent_submissions
				 WHERE status = 'terminalizing'
				 ORDER BY sequence ASC`,
			)
			.toArray()
			.map(parseSettlementObligation);
	}

	// ── Attempt markers ──────────────────────────────────────────────────

	async insertAttemptMarker(attempt: SubmissionAttemptRef): Promise<void> {
		this.sql.exec(
			`INSERT OR IGNORE INTO flue_agent_attempt_markers (submission_id, attempt_id, created_at)
			 VALUES (?, ?, ?)`,
			attempt.submissionId,
			attempt.attemptId,
			Date.now(),
		);
	}

	async deleteAttemptMarker(attempt: SubmissionAttemptRef): Promise<void> {
		this.sql.exec(
			'DELETE FROM flue_agent_attempt_markers WHERE submission_id = ? AND attempt_id = ?',
			attempt.submissionId,
			attempt.attemptId,
		);
	}

	async listAttemptMarkers(): Promise<AgentAttemptMarker[]> {
		const rows = this.sql
			.exec('SELECT submission_id, attempt_id, created_at FROM flue_agent_attempt_markers')
			.toArray();
		return rows.map((row) => {
			if (
				typeof row.submission_id !== 'string' ||
				typeof row.attempt_id !== 'string' ||
				typeof row.created_at !== 'number'
			) {
				throw new Error('[flue] Persisted attempt marker row is malformed.');
			}
			return {
				submissionId: row.submission_id,
				attemptId: row.attempt_id,
				createdAt: row.created_at,
			};
		});
	}

	// ── Lease management ────────────────────────────────────────────────

	async renewLeases(ownerId: string, submissionIds: string[]): Promise<void> {
		if (submissionIds.length === 0) return;
		const now = Date.now();
		const leaseExpiresAt = now + LEASE_DURATION_MS;
		const placeholders = submissionIds.map(() => '?').join(', ');
		this.sql.exec(
			`UPDATE flue_agent_submissions
			 SET lease_expires_at = ?
			 WHERE owner_id = ? AND status = 'running'
			   AND submission_id IN (${placeholders})`,
			leaseExpiresAt,
			ownerId,
			...submissionIds,
		);
	}

	async listExpiredSubmissions(): Promise<AgentSubmission[]> {
		const now = Date.now();
		return this.parseOperationalRows(
			this.sql
				.exec(
					`SELECT ${submissionColumns}
					 FROM flue_agent_submissions
					 WHERE status = 'running' AND lease_expires_at > 0 AND lease_expires_at < ?
					 ORDER BY sequence ASC`,
					now,
				)
				.toArray(),
			'active',
		);
	}

	async claimSubmission(claim: SubmissionClaimRef): Promise<AgentSubmission | null> {
		const now = Date.now();
		const timeoutAt = now + DURABILITY_DEFAULT_TIMEOUT_MS;
		const row = this.sql
			.exec(
				`UPDATE flue_agent_submissions AS current
				 SET status = 'running', attempt_id = ?, started_at = ?, attempt_count = attempt_count + 1,
				     max_retry = ?, timeout_at = CASE WHEN timeout_at = 0 THEN ? ELSE timeout_at END,
				     owner_id = ?, lease_expires_at = ?
				 WHERE current.submission_id = ? AND current.status = 'queued'
				   AND current.canonical_ready_at IS NOT NULL
				   AND NOT EXISTS (
				     SELECT 1
				     FROM flue_agent_submissions AS earlier
				     WHERE earlier.session_key = current.session_key
				       AND earlier.status IN ('queued', 'running', 'terminalizing')
				       AND earlier.sequence < current.sequence
				   )
				 RETURNING ${submissionColumns}`,
				claim.attemptId,
				now,
				DURABILITY_DEFAULT_MAX_ATTEMPTS,
				timeoutAt,
				claim.ownerId,
				claim.leaseExpiresAt,
				claim.submissionId,
			)
			.toArray()[0];
		return row ? this.parseSubmission(row) : null;
	}

	async markSubmissionInputApplied(
		attempt: SubmissionAttemptRef,
		durability?: { maxRetry: number; timeoutAt: number },
	): Promise<boolean> {
		return this.updateOwnedSubmission(
			`UPDATE flue_agent_submissions
			 SET input_applied_at = COALESCE(input_applied_at, ?),
			     max_retry = CASE WHEN input_applied_at IS NULL THEN ? ELSE max_retry END,
			     timeout_at = CASE WHEN input_applied_at IS NULL THEN ? ELSE timeout_at END
			 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
			 RETURNING submission_id`,
			Date.now(),
			durability?.maxRetry ?? DURABILITY_DEFAULT_MAX_ATTEMPTS,
			durability?.timeoutAt ?? Date.now() + DURABILITY_DEFAULT_TIMEOUT_MS,
			attempt.submissionId,
			attempt.attemptId,
		);
	}

	async requestSubmissionRecovery(attempt: SubmissionAttemptRef): Promise<boolean> {
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

	async requestSessionAbort(sessionKey: string): Promise<string[]> {
		const rows = this.sql
			.exec(
				`UPDATE flue_agent_submissions
				 SET abort_requested_at = COALESCE(abort_requested_at, ?)
				 WHERE session_key = ? AND status IN ('queued', 'running')
				 RETURNING submission_id`,
				Date.now(),
				sessionKey,
			)
			.toArray();
		return rows.map((row) => String(row.submission_id));
	}

	async requeueSubmissionBeforeInputApplied(attempt: SubmissionAttemptRef): Promise<boolean> {
		return (
			this.sql
				.exec(
					`UPDATE flue_agent_submissions
					 SET status = 'queued', attempt_id = NULL, recovery_requested_at = NULL, started_at = NULL, owner_id = NULL, lease_expires_at = 0
					 WHERE submission_id = ? AND status = 'running'
					   AND attempt_id = ? AND input_applied_at IS NULL
					 RETURNING submission_id`,
					attempt.submissionId,
					attempt.attemptId,
				)
				.toArray().length > 0
		);
	}

	async reserveSubmissionSettlement(
		attempt: SubmissionAttemptRef,
		settlement: {
			recordId: string;
			record: import('./conversation-records.ts').SubmissionSettledRecord;
		},
	): Promise<SubmissionSettlementObligation | null> {
		if (settlement.record.id !== settlement.recordId) return null;
		const recordJson = JSON.stringify(settlement.record);
		return this.transactionSync(() => {
			const inserted = this.sql
				.exec(
					`UPDATE flue_agent_submissions
					 SET status = 'terminalizing', settlement_record_id = ?, settlement_record_json = ?
					 WHERE submission_id = ? AND kind = 'direct' AND status = 'running' AND attempt_id = ?
					 RETURNING submission_id, session_key, attempt_id, settlement_record_id,
					           settlement_record_json`,
					settlement.recordId,
					recordJson,
					attempt.submissionId,
					attempt.attemptId,
				)
				.toArray()[0];
			if (inserted) return parseSettlementObligation(inserted);
			const existing = this.sql
				.exec(
					`SELECT submission_id, session_key, attempt_id, settlement_record_id,
					        settlement_record_json
					 FROM flue_agent_submissions
					 WHERE submission_id = ? AND kind = 'direct' AND status = 'terminalizing'
					   AND attempt_id = ? AND settlement_record_id = ? AND settlement_record_json = ?`,
					attempt.submissionId,
					attempt.attemptId,
					settlement.recordId,
					recordJson,
				)
				.toArray()[0];
			return existing ? parseSettlementObligation(existing) : null;
		});
	}

	async finalizeSubmissionSettlement(
		attempt: SubmissionAttemptRef,
		recordId: string,
	): Promise<boolean> {
		return this.updateOwnedSubmission(
			`UPDATE flue_agent_submissions
			 SET status = 'settled', settled_at = ?, error = NULL
			 WHERE submission_id = ? AND status = 'terminalizing' AND attempt_id = ?
			   AND settlement_record_id = ?
			 RETURNING submission_id`,
			Date.now(),
			attempt.submissionId,
			attempt.attemptId,
			recordId,
		);
	}

	async completeSubmission(attempt: SubmissionAttemptRef): Promise<boolean> {
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

	async failSubmission(attempt: SubmissionAttemptRef, error: unknown): Promise<boolean> {
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

	private admitSubmission(input: AgentSubmissionInput): AgentDispatchAdmission {
		return this.transactionSync(() => {
			const chunkStore = createSqlPersistedChunkStore(this.sql);
			const admission = admitSubmissionWithBackend<SqlRow>(input, {
				getDispatchReceipt: (submissionId) => this.getDispatchReceipt(submissionId),
				insertIfAbsent: (row) => {
					this.sql.exec(
						`INSERT OR IGNORE INTO flue_agent_submissions
						 (submission_id, session_key, kind, payload, status, accepted_at)
						 VALUES (?, ?, ?, ?, 'queued', ?)`,
						row.submissionId,
						row.sessionKey,
						row.kind,
						row.payload,
						row.acceptedAt,
					);
				},
				getExisting: (submissionId) => this.readSubmissionRow(submissionId),
				readChunks: (owner) => chunkStore.read(owner),
				replaceChunks: (owner, chunks) => chunkStore.replace(owner, chunks),
				parseSubmission,
			});
			// Unreachable: every backend callback above is synchronous, so the
			// shared algorithm completes inside `transactionSync`.
			if (admission instanceof Promise) {
				throw new Error('[flue] Internal SQLite admission backend must be synchronous.');
			}
			return admission;
		});
	}

	private updateOwnedSubmission(query: string, ...bindings: unknown[]): boolean {
		return this.sql.exec(query, ...bindings).toArray().length > 0;
	}

	private parseSubmission(row: SqlRow): AgentSubmission {
		return parseSubmission(
			row,
			createSqlPersistedChunkStore(this.sql).read(submissionChunkOwner(String(row.submission_id))),
		);
	}

	// Total persisted attachment bytes for a submission, summed in SQLite without
	// materializing the chunk data — so an over-budget row is measured, then
	// deferred, without ever being read into memory.
	private pendingAttachmentByteSize(submissionId: string): number {
		const owner = submissionChunkOwner(submissionId);
		const row = this.sql
			.exec(
				`SELECT COALESCE(SUM(LENGTH(data)), 0) AS bytes
				 FROM flue_image_chunks
				 WHERE owner_kind = ? AND owner_id = ? AND owner_part = ?`,
				owner.kind,
				owner.id,
				owner.part,
			)
			.toArray()[0];
		return typeof row?.bytes === 'number' ? row.bytes : 0;
	}

	private parseOperationalRows(rows: SqlRow[], status: 'queued' | 'active'): AgentSubmission[] {
		const submissions: AgentSubmission[] = [];
		let attachmentBytes = 0;
		for (const row of rows) {
			const rowBytes =
				typeof row.submission_id === 'string'
					? this.pendingAttachmentByteSize(row.submission_id)
					: 0;
			// Defer once admitting this row would push the batch past the reconcile
			// budget — checked BEFORE hydrating, so an over-budget row is never
			// reassembled. The deferred rows stay unsettled and the coordinator's
			// submission wake re-arms to pick them up next tick. Always admit at
			// least one — the per-message cap bounds each submission's attachments to
			// the budget, so no single one is starved.
			if (submissions.length > 0 && attachmentBytes + rowBytes > MAX_RECONCILE_ATTACHMENT_BYTES) {
				break;
			}
			try {
				submissions.push(this.parseSubmission(row));
				attachmentBytes += rowBytes;
			} catch (error) {
				if (typeof row.sequence !== 'number') throw error;
				console.error(
					'[flue] Terminating malformed submission (sequence %d):',
					row.sequence,
					error,
				);
				this.failSubmissionSequence(row.sequence, status, error);
			}
		}
		return submissions;
	}

	private failSubmissionSequence(
		sequence: number,
		status: 'queued' | 'active',
		error: unknown,
	): void {
		this.sql.exec(
			`UPDATE flue_agent_submissions
			 SET status = 'settled', settled_at = ?, error = ?
			 WHERE sequence = ? AND ${status === 'queued' ? "status = 'queued'" : "status = 'running'"}`,
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
	'sequence, submission_id, session_key, kind, payload, status, accepted_at, canonical_ready_at, attempt_id, input_applied_at, recovery_requested_at, abort_requested_at, started_at, error, attempt_count, max_retry, timeout_at, owner_id, lease_expires_at';

function submissionColumnsFor(table: string): string {
	return submissionColumns
		.split(', ')
		.map((column) => `${table}.${column}`)
		.join(', ');
}

// Row parsers are intentionally adapter-specific: each backend has its own
// column types, coercion rules, and storage representation. Keeping them
// local avoids a shared abstraction that would need to accommodate every
// backend's quirks.

function parseSettlementObligation(row: SqlRow): SubmissionSettlementObligation {
	if (
		typeof row.submission_id !== 'string' ||
		typeof row.session_key !== 'string' ||
		typeof row.attempt_id !== 'string' ||
		typeof row.settlement_record_id !== 'string' ||
		typeof row.settlement_record_json !== 'string'
	) {
		throw new Error('[flue] Persisted submission settlement obligation is malformed.');
	}
	return {
		submissionId: row.submission_id,
		sessionKey: row.session_key,
		attemptId: row.attempt_id,
		recordId: row.settlement_record_id,
		record: JSON.parse(row.settlement_record_json),
	};
}

function parseSubmission(
	row: SqlRow,
	chunks: Parameters<typeof hydratePersistedSubmissionAttachments>[1],
): AgentSubmission {
	if (
		typeof row.sequence !== 'number' ||
		typeof row.submission_id !== 'string' ||
		typeof row.session_key !== 'string' ||
		(row.kind !== 'dispatch' && row.kind !== 'direct') ||
		typeof row.payload !== 'string' ||
		(row.status !== 'queued' &&
			row.status !== 'running' &&
			row.status !== 'terminalizing' &&
			row.status !== 'settled') ||
		typeof row.accepted_at !== 'number' ||
		(row.canonical_ready_at !== null &&
			row.canonical_ready_at !== undefined &&
			typeof row.canonical_ready_at !== 'number') ||
		(row.attempt_id !== null &&
			row.attempt_id !== undefined &&
			typeof row.attempt_id !== 'string') ||
		(row.input_applied_at !== null &&
			row.input_applied_at !== undefined &&
			typeof row.input_applied_at !== 'number') ||
		(row.recovery_requested_at !== null &&
			row.recovery_requested_at !== undefined &&
			typeof row.recovery_requested_at !== 'number') ||
		(row.abort_requested_at !== null &&
			row.abort_requested_at !== undefined &&
			typeof row.abort_requested_at !== 'number') ||
		(row.started_at !== null &&
			row.started_at !== undefined &&
			typeof row.started_at !== 'number') ||
		(row.status === 'queued' &&
			(row.attempt_id !== null ||
				row.input_applied_at !== null ||
				row.recovery_requested_at !== null ||
				row.started_at !== null)) ||
		((row.status === 'running' || row.status === 'terminalizing') &&
			(typeof row.attempt_id !== 'string' || typeof row.started_at !== 'number')) ||
		typeof row.attempt_count !== 'number' ||
		typeof row.max_retry !== 'number' ||
		typeof row.timeout_at !== 'number'
	) {
		throw new Error('[flue] Persisted agent submission row is malformed.');
	}
	const parsedPayload = JSON.parse(row.payload);
	const input = hydratePersistedSubmissionAttachments(
		parsedPayload as AgentSubmissionInput,
		chunks,
	);
	if (
		!isSubmissionPayload(input, {
			kind: row.kind as string,
			submissionId: row.submission_id as string,
			sessionKey: row.session_key as string,
			acceptedAt: row.accepted_at as number,
		})
	) {
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
		canonicalReadyAt: typeof row.canonical_ready_at === 'number' ? row.canonical_ready_at : null,
		...(typeof row.attempt_id === 'string' ? { attemptId: row.attempt_id } : {}),
		...(typeof row.input_applied_at === 'number' ? { inputAppliedAt: row.input_applied_at } : {}),
		...(typeof row.recovery_requested_at === 'number'
			? { recoveryRequestedAt: row.recovery_requested_at }
			: {}),
		...(typeof row.abort_requested_at === 'number'
			? { abortRequestedAt: row.abort_requested_at }
			: {}),
		...(typeof row.started_at === 'number' ? { startedAt: row.started_at } : {}),
		...(typeof row.error === 'string' ? { error: row.error } : {}),
		attemptCount: row.attempt_count,
		maxRetry: row.max_retry,
		timeoutAt: row.timeout_at,
		...(typeof row.owner_id === 'string' ? { ownerId: row.owner_id } : {}),
		leaseExpiresAt: typeof row.lease_expires_at === 'number' ? row.lease_expires_at : 0,
	};
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
		 canonical_ready_at INTEGER,
		 attempt_id TEXT,
		 input_applied_at INTEGER,
		 recovery_requested_at INTEGER,
		 abort_requested_at INTEGER,
		 started_at INTEGER,
		 settled_at INTEGER,
		 error TEXT,
		 attempt_count INTEGER NOT NULL DEFAULT 0,
		 max_retry INTEGER NOT NULL DEFAULT ${DURABILITY_DEFAULT_MAX_ATTEMPTS},
		 timeout_at INTEGER NOT NULL DEFAULT 0,
		 owner_id TEXT,
		 lease_expires_at INTEGER NOT NULL DEFAULT 0,
		 settlement_record_id TEXT,
		 settlement_record_json TEXT
		)`,
	);
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_agent_dispatch_receipts (
		 dispatch_id TEXT PRIMARY KEY,
		 accepted_at INTEGER NOT NULL
		)`,
	);
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_agent_attempt_markers (
		 submission_id TEXT NOT NULL,
		 attempt_id TEXT NOT NULL,
		 created_at INTEGER NOT NULL,
		 PRIMARY KEY (submission_id, attempt_id)
		)`,
	);
	sql.exec(
		'CREATE INDEX IF NOT EXISTS flue_agent_submissions_status_sequence_idx ON flue_agent_submissions (status, sequence ASC)',
	);
	sql.exec(
		'CREATE INDEX IF NOT EXISTS flue_agent_submissions_session_status_sequence_idx ON flue_agent_submissions (session_key, status, sequence ASC)',
	);
}
