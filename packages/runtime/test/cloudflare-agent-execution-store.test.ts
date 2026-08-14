import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { AgentExecutionStore } from '../src/agent-execution-store.ts';
import { createSqlAgentExecutionStore } from '../src/cloudflare/agent-execution-store.ts';
import { PersistedRowInvariantError } from '../src/errors.ts';
import { IMAGE_DATA_CHUNK_LENGTH } from '../src/persisted-images.ts';
import type { DispatchInput } from '../src/runtime/dispatch-queue.ts';
import {
	readLatestCompletedSubmission,
	readLatestSettledSubmission,
} from '../src/sql-agent-execution-store.ts';

function makeFakeSql() {
	const db = new DatabaseSync(':memory:');
	return {
		db,
		transactionSync<T>(closure: () => T): T {
			db.exec('BEGIN');
			try {
				const result = closure();
				db.exec('COMMIT');
				return result;
			} catch (error) {
				db.exec('ROLLBACK');
				throw error;
			}
		},
		sql: {
			exec(query: string, ...bindings: unknown[]) {
				const stmt = db.prepare(query);
				let rows: unknown[];
				const trimmed = query.trimStart().toUpperCase();
				const expectsRows =
					trimmed.startsWith('SELECT') ||
					trimmed.startsWith('WITH') ||
					/\bRETURNING\b/i.test(query);
				if (expectsRows) {
					rows = stmt.all(...(bindings as never[]));
				} else {
					stmt.run(...(bindings as never[]));
					rows = [];
				}
				return {
					toArray() {
						return rows as Record<string, unknown>[];
					},
				};
			},
		},
	};
}

function dispatchInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
	return {
		dispatchId: 'dispatch-1',
		agent: 'assistant',
		id: 'agent-1',
		message: { kind: 'signal', type: 'test.event', body: 'Hello' },
		acceptedAt: '2026-06-03T00:00:00.000Z',
		...overrides,
	};
}

describe('createSqlAgentExecutionStore()', () => {
	it('creates the initial flue_agent_submissions schema and ordering indexes when initialized', () => {
		const { db, sql, transactionSync } = makeFakeSql();

		createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');

		const columnNames = (table: string) =>
			new Set(
				(
					db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{
						name: string;
					}>
				).map((row) => row.name),
			);
		expect(columnNames('flue_agent_submissions')).toEqual(
			new Set([
				'sequence',
				'submission_id',
				'session_key',
				'kind',
				'payload',
				'status',
				'accepted_at',
				'attempt_id',
				'canonical_ready_at',
				'input_applied_at',
				'recovery_requested_at',
				'abort_requested_at',
				'started_at',
				'settled_at',
				'error',
				'attempt_count',
				'max_retry',
				'timeout_at',
				'owner_id',
				'lease_expires_at',
				'settlement_record_id',
				'settlement_record_json',
			]),
		);
		const tableNames = new Set(
			(
				db
					.prepare(
						"SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
					)
					.all() as Array<{ name: string }>
			).map((row) => row.name),
		);
		expect(tableNames).toEqual(
			new Set([
				'flue_agent_attempt_markers',
				'flue_agent_dispatch_receipts',
				'flue_agent_submissions',
				'flue_image_chunks',
				'flue_meta',
			]),
		);
		const submissionIndexNames = (
			db
				.prepare(
					"SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'flue_agent_submissions'",
				)
				.all() as Array<{ name: string }>
		).map((row) => row.name);
		expect(submissionIndexNames).toEqual(
			expect.arrayContaining([
				'flue_agent_submissions_session_status_sequence_idx',
				'flue_agent_submissions_status_sequence_idx',
			]),
		);
	});

	it('stores direct submission images outside the submission payload', async () => {
		const { db, sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		const imageData = 'a'.repeat(IMAGE_DATA_CHUNK_LENGTH + 1);
		const input = {
			kind: 'direct' as const,
			submissionId: 'direct-1',
			agent: 'assistant',
			id: 'agent-1',
			acceptedAt: '2026-06-03T00:00:00.000Z',
			message: {
				kind: 'user' as const,
				body: 'hello',
				attachments: [{ type: 'image' as const, data: imageData, mimeType: 'image/png' }],
			},
		};
		const submission = await store.submissions.admitDirect(input);
		const replay = await store.submissions.admitDirect(input);
		const row = db
			.prepare('SELECT payload FROM flue_agent_submissions WHERE submission_id = ?')
			.get('direct-1') as { payload: string };
		expect(row.payload).not.toContain(imageData);
		expect(submission.input).toMatchObject({ message: { attachments: [{ data: imageData }] } });
		expect(replay.input).toEqual(submission.input);
		expect(
			db
				.prepare("SELECT COUNT(*) AS count FROM flue_image_chunks WHERE owner_kind = 'submission'")
				.get(),
		).toEqual({ count: 2 });
		await expect(
			store.submissions.admitDirect({
				...input,
				message: {
					...input.message,
					attachments: [{ type: 'image', data: `b${imageData.slice(1)}`, mimeType: 'image/png' }],
				},
			}),
		).rejects.toThrow('unexpected result');
	});

	it('bounds a reconcile batch by attachment bytes and drains the deferred rows next pass', async () => {
		const { sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		// 11 MiB each (under the 14 MiB per-image cap). One image differs by its
		// first byte so images are distinct; the bytes are shared by reference so
		// the test allocates ~11 MiB, not 44.
		const tail = 'a'.repeat(11 * 1024 * 1024 - 1);
		for (let i = 0; i < 4; i++) {
			await store.submissions.admitDirect({
				kind: 'direct' as const,
				submissionId: `bulk-${i}`,
				agent: 'assistant',
				id: 'agent-1',
				acceptedAt: '2026-06-03T00:00:00.000Z',
				message: {
					kind: 'user' as const,
					body: 'x',
					attachments: [{ type: 'image' as const, data: `${i}${tail}`, mimeType: 'image/png' }],
				},
			});
		}
		// 4 × 11 MiB = 44 MiB of pending attachments; the 32 MiB reconcile budget
		// admits two (~22 MiB — a third would reach ~33 MiB > budget, and the check
		// is pre-emptive) and defers the rest, so one wake never hydrates the whole
		// set at once.
		const first = await store.submissions.listUnreadySubmissions();
		expect(first.map((submission) => submission.submissionId)).toEqual(['bulk-0', 'bulk-1']);
		// Advancing the loaded rows lets the next pass reach the deferred ones.
		for (const submission of first) {
			await store.submissions.markSubmissionCanonicalReady(submission.submissionId);
		}
		const second = await store.submissions.listUnreadySubmissions();
		expect(second.map((submission) => submission.submissionId)).toEqual(['bulk-2', 'bulk-3']);
	});

	it('replays direct submissions with more than ten images exactly', async () => {
		const { sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		const input = {
			kind: 'direct' as const,
			submissionId: 'direct-many-images',
			agent: 'assistant',
			id: 'agent-1',
			acceptedAt: '2026-06-03T00:00:00.000Z',
			message: {
				kind: 'user' as const,
				body: 'hello',
				attachments: Array.from({ length: 12 }, (_, index) => ({
					type: 'image' as const,
					data: `image-${index}`,
					mimeType: 'image/png',
				})),
			},
		};
		const admitted = await store.submissions.admitDirect(input);
		const replay = await store.submissions.admitDirect(input);
		expect(replay.input).toEqual(admitted.input);
	});

	it('ensures only one SQL row per replayed dispatch admission', async () => {
		const { db, sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');

		await store.submissions.admitDispatch(dispatchInput());
		await store.submissions.admitDispatch(dispatchInput());

		expect(db.prepare('SELECT COUNT(*) AS count FROM flue_agent_submissions').get()).toEqual({
			count: 1,
		});
	});

	it('terminalizes malformed queued payloads while returning healthy runnable rows', async () => {
		const { db, sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		await store.submissions.admitDispatch(dispatchInput({ dispatchId: 'healthy' }));
		await store.submissions.markSubmissionCanonicalReady('healthy');
		db.prepare(
			`INSERT INTO flue_agent_submissions
			 (submission_id, session_key, kind, payload, status, accepted_at, canonical_ready_at)
			 VALUES (?, ?, 'dispatch', ?, 'queued', ?, ?)`,
		).run('malformed', 'agent-session:["agent-1","default","other"]', '{', 1, 1);

		expect(await store.submissions.listRunnableSubmissions()).toEqual([
			expect.objectContaining({ submissionId: 'healthy' }),
		]);
		expect(
			db
				.prepare('SELECT status, error FROM flue_agent_submissions WHERE submission_id = ?')
				.get('malformed'),
		).toMatchObject({ status: 'settled', error: expect.any(String) });
	});

	it('terminalizes impossible queued input markers instead of replaying them', async () => {
		const { db, sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		await store.submissions.admitDispatch(dispatchInput());
		await store.submissions.markSubmissionCanonicalReady('dispatch-1');
		db.prepare(
			'UPDATE flue_agent_submissions SET input_applied_at = ? WHERE submission_id = ?',
		).run(1, 'dispatch-1');

		expect(await store.submissions.listRunnableSubmissions()).toEqual([]);
		expect(await store.submissions.getSubmission('dispatch-1')).toMatchObject({
			status: 'settled',
			error: expect.any(String),
		});
	});

	it('rejects missing Durable Object SQLite with migration guidance', () => {
		expect(() => createSqlAgentExecutionStore({}, 'FlueAssistantAgent')).toThrow(
			'Add "FlueAssistantAgent" to a Wrangler migration\'s "new_sqlite_classes" list before its first deploy; do not use legacy "new_classes". Existing KV-backed Durable Object classes cannot be converted to SQLite in place.',
		);
	});

	it('rejects SQLite-compatible storage without synchronous transaction support', () => {
		const { sql } = makeFakeSql();

		expect(() => createSqlAgentExecutionStore({ sql }, 'FlueAssistantAgent')).toThrow(
			'[flue] Cloudflare durable agent class "FlueAssistantAgent" requires Durable Object SQLite.',
		);
	});

	it('reports SQL initialization failures without misdiagnosing missing SQLite', () => {
		const { sql, transactionSync } = makeFakeSql();
		sql.exec('CREATE TABLE flue_agent_submissions (sequence INTEGER PRIMARY KEY AUTOINCREMENT)');

		expect(() =>
			createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent'),
		).toThrow(
			'[flue] Cloudflare durable agent class "FlueAssistantAgent" could not initialize its SQLite execution store. Underlying error: This database records an unrecognized schema version ("unversioned"; this runtime supports version 5).',
		);
	});
});

describe('readLatestCompletedSubmission()', () => {
	// Terminal shapes only; the lifecycle test below proves these match what a
	// real reserve -> canonical append -> finalize actually writes.
	function seedSettledRow(
		db: DatabaseSync,
		row: {
			submissionId: string;
			kind: 'direct' | 'dispatch';
			error?: string;
			record?: { outcome: 'completed' | 'failed' | 'aborted' };
		},
	) {
		db.prepare(
			`INSERT INTO flue_agent_submissions
			 (submission_id, session_key, kind, payload, status, accepted_at, settled_at,
			  error, settlement_record_json)
			 VALUES (?, 'agents/assistant/agent-1', ?, '{}', 'settled', 1, 2, ?, ?)`,
		).run(
			row.submissionId,
			row.kind,
			row.error ?? null,
			row.record ? JSON.stringify(row.record) : null,
		);
	}

	function directInput(submissionId: string) {
		return {
			kind: 'direct' as const,
			submissionId,
			agent: 'assistant',
			id: 'agent-1',
			acceptedAt: '2026-06-03T00:00:00.000Z',
			message: { kind: 'user' as const, body: 'hello' },
		};
	}

	function settlementRecord(submissionId: string, outcome: 'completed' | 'failed' | 'aborted') {
		return {
			v: 1 as const,
			id: `${submissionId}:settled`,
			type: 'submission_settled' as const,
			conversationId: 'conversation-1',
			harness: 'default',
			session: 'default',
			timestamp: '2026-06-22T00:00:00.000Z',
			submissionId,
			attemptId: 'attempt-1',
			outcome,
		};
	}

	/** Drives the real direct path: admit -> claim -> reserve -> finalize. */
	async function settleDirect(
		store: AgentExecutionStore,
		submissionId: string,
		outcome: 'completed' | 'failed' | 'aborted',
	) {
		await store.submissions.admitDirect(directInput(submissionId));
		await store.submissions.markSubmissionCanonicalReady(submissionId);
		await store.submissions.claimSubmission({
			submissionId,
			attemptId: 'attempt-1',
			ownerId: 'test-owner',
			leaseExpiresAt: Date.now() + 30_000,
		});
		const record = settlementRecord(submissionId, outcome);
		await store.submissions.reserveSubmissionSettlement(
			{ submissionId, attemptId: 'attempt-1' },
			{ recordId: record.id, record },
		);
		await store.submissions.finalizeSubmissionSettlement(
			{ submissionId, attemptId: 'attempt-1' },
			record.id,
		);
	}

	it('returns undefined when no completed submission exists', () => {
		const { sql, transactionSync } = makeFakeSql();
		createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');

		expect(readLatestCompletedSubmission(sql)).toBeUndefined();
	});

	it('reads a direct submission settled through its real lifecycle', async () => {
		const { sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');

		await settleDirect(store, 'direct-1', 'completed');

		expect(readLatestCompletedSubmission(sql)).toEqual({
			sequence: 1,
			submissionId: 'direct-1',
		});
	});

	it('does not report a direct submission whose settlement record says failed or aborted', async () => {
		const { sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');

		await settleDirect(store, 'direct-1', 'completed');
		await settleDirect(store, 'direct-2', 'failed');
		await settleDirect(store, 'direct-3', 'aborted');

		expect(readLatestCompletedSubmission(sql)).toEqual({
			sequence: 1,
			submissionId: 'direct-1',
		});
	});

	// A direct row can only claim completion through its canonical settlement
	// record, so the dispatch encoding never speaks for one.
	it('does not report a direct row carrying the dispatch completion encoding', () => {
		const { db, sql, transactionSync } = makeFakeSql();
		createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		seedSettledRow(db, { submissionId: 'direct-1', kind: 'direct' });

		expect(readLatestCompletedSubmission(sql)).toBeUndefined();
	});

	it('returns the greatest completed submission across kinds', () => {
		const { db, sql, transactionSync } = makeFakeSql();
		createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		seedSettledRow(db, { submissionId: 's-1', kind: 'direct', record: { outcome: 'completed' } });
		seedSettledRow(db, { submissionId: 'd-2', kind: 'dispatch' });

		expect(readLatestCompletedSubmission(sql)).toEqual({ sequence: 2, submissionId: 'd-2' });
	});

	it('counts a dispatch row with a null error as completed', () => {
		const { db, sql, transactionSync } = makeFakeSql();
		createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		seedSettledRow(db, { submissionId: 'd-1', kind: 'dispatch' });

		expect(readLatestCompletedSubmission(sql)).toEqual({ sequence: 1, submissionId: 'd-1' });
	});

	it('a failed dispatch row neither returns nor masks an earlier completed cursor', () => {
		const { db, sql, transactionSync } = makeFakeSql();
		createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		seedSettledRow(db, { submissionId: 's-1', kind: 'direct', record: { outcome: 'completed' } });
		seedSettledRow(db, { submissionId: 'd-2', kind: 'dispatch', error: 'boom' });

		expect(readLatestCompletedSubmission(sql)).toEqual({ sequence: 1, submissionId: 's-1' });
	});

	it('ignores unsettled rows', () => {
		const { db, sql, transactionSync } = makeFakeSql();
		createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		db.prepare(
			`INSERT INTO flue_agent_submissions
			 (submission_id, session_key, kind, payload, status, accepted_at)
			 VALUES ('r-1', 'agents/assistant/agent-1', 'direct', '{}', 'running', 1)`,
		).run();

		expect(readLatestCompletedSubmission(sql)).toBeUndefined();
	});

	// The live schema declares submission_id NOT NULL, so only a table written by
	// an incompatible writer can reach the guard; this stands in for one.
	it('rejects a settled row whose identity columns do not match their declared shape', () => {
		const { db, sql } = makeFakeSql();
		db.exec(`CREATE TABLE flue_agent_submissions (
			sequence INTEGER PRIMARY KEY AUTOINCREMENT,
			submission_id TEXT,
			kind TEXT,
			status TEXT,
			error TEXT,
			settlement_record_json TEXT
		)`);
		db.exec(
			"INSERT INTO flue_agent_submissions (submission_id, kind, status) VALUES (NULL, 'dispatch', 'settled')",
		);

		expect(() => readLatestCompletedSubmission(sql)).toThrow(PersistedRowInvariantError);
		try {
			readLatestCompletedSubmission(sql);
		} catch (error) {
			expect(error).toMatchObject({
				type: 'persisted_row_invariant',
				meta: { table: 'flue_agent_submissions' },
			});
		}
	});
});

describe('readLatestSettledSubmission()', () => {
	it('returns the latest direct failure when its settlement record stores an error', async () => {
		const { sql, transactionSync } = makeFakeSql();
		const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		const input = {
			kind: 'direct' as const,
			submissionId: 'direct-1',
			agent: 'assistant',
			id: 'agent-1',
			acceptedAt: '2026-06-03T00:00:00.000Z',
			message: { kind: 'user' as const, body: 'hello' },
		};
		await store.submissions.admitDirect(input);
		await store.submissions.markSubmissionCanonicalReady(input.submissionId);
		await store.submissions.claimSubmission({
			submissionId: input.submissionId,
			attemptId: 'attempt-1',
			ownerId: 'test-owner',
			leaseExpiresAt: Date.now() + 30_000,
		});
		const record = {
			v: 1 as const,
			id: 'direct-1:settled',
			type: 'submission_settled' as const,
			conversationId: 'conversation-1',
			harness: 'default',
			session: 'default',
			timestamp: '2026-06-22T00:00:00.000Z',
			submissionId: 'direct-1',
			attemptId: 'attempt-1',
			outcome: 'failed' as const,
			error: { name: 'ProviderError', message: 'upstream failed', type: 'provider_error' },
		};
		await store.submissions.reserveSubmissionSettlement(
			{ submissionId: 'direct-1', attemptId: 'attempt-1' },
			{ recordId: record.id, record },
		);
		await store.submissions.finalizeSubmissionSettlement(
			{ submissionId: 'direct-1', attemptId: 'attempt-1' },
			record.id,
		);

		expect(readLatestSettledSubmission(sql)).toEqual({
			sequence: 1,
			submissionId: 'direct-1',
			outcome: 'failed',
			error: { name: 'ProviderError', message: 'upstream failed', type: 'provider_error' },
		});
	});

	it('returns a failed dispatch result when the error column is set', () => {
		const { db, sql, transactionSync } = makeFakeSql();
		createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		db.prepare(
			`INSERT INTO flue_agent_submissions
			 (submission_id, session_key, kind, payload, status, accepted_at, settled_at, error)
			 VALUES ('dispatch-1', 'agents/assistant/agent-1', 'dispatch', '{}', 'settled', 1, 2, 'dispatch failed')`,
		).run();

		expect(readLatestSettledSubmission(sql)).toEqual({
			sequence: 1,
			submissionId: 'dispatch-1',
			outcome: 'failed',
			error: 'dispatch failed',
		});
	});

	it('returns a failed direct result when reconciliation stores only an error', () => {
		const { db, sql, transactionSync } = makeFakeSql();
		createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		db.prepare(
			`INSERT INTO flue_agent_submissions
			 (submission_id, session_key, kind, payload, status, accepted_at, settled_at, error)
			 VALUES ('direct-1', 'agents/assistant/agent-1', 'direct', '{}', 'settled', 1, 2, 'invalid payload')`,
		).run();

		expect(readLatestSettledSubmission(sql)).toEqual({
			sequence: 1,
			submissionId: 'direct-1',
			outcome: 'failed',
			error: 'invalid payload',
		});
	});

	it('returns an aborted direct result when it follows an older completion', async () => {
		const { db, sql, transactionSync } = makeFakeSql();
		createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
		db.prepare(
			`INSERT INTO flue_agent_submissions
			 (submission_id, session_key, kind, payload, status, accepted_at, settled_at,
			  settlement_record_json)
			 VALUES
			 ('direct-1', 'agents/assistant/agent-1', 'direct', '{}', 'settled', 1, 2,
			  '{"outcome":"completed"}'),
			 ('direct-2', 'agents/assistant/agent-1', 'direct', '{}', 'settled', 2, 3,
			  '{"outcome":"aborted"}')`,
		).run();

		expect(readLatestSettledSubmission(sql)).toEqual({
			sequence: 2,
			submissionId: 'direct-2',
			outcome: 'aborted',
		});
	});
});
