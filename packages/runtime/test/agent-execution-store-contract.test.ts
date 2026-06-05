/**
 * Shared contract tests for AgentExecutionStore.
 *
 * Runs the same behavioral assertions against both the Cloudflare-style SQL
 * backend (node:sqlite standing in for DO SQLite) and the Node backend
 * (node:sqlite :memory: via createNodeAgentExecutionStore).
 *
 * SQL-specific tests (schema assertions, error diagnostics, DO-specific edge
 * cases) remain in cloudflare-agent-execution-store.test.ts.
 */

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { AgentExecutionStore, SqlStorage } from '../src/agent-execution-store.ts';
import { createSqlAgentExecutionStoreFromSql } from '../src/cloudflare/agent-execution-store.ts';
import { createNodeAgentExecutionStore } from '../src/node/agent-execution-store.ts';
import type { DirectAgentSubmissionInput } from '../src/runtime/agent-submissions.ts';
import type { DispatchInput } from '../src/runtime/dispatch-queue.ts';
import type { SessionData } from '../src/types.ts';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function dispatchInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
	return {
		dispatchId: 'dispatch-1',
		agent: 'assistant',
		id: 'agent-1',
		session: 'default',
		input: { text: 'Hello' },
		acceptedAt: '2026-06-03T00:00:00.000Z',
		...overrides,
	};
}

function directInput(overrides: Partial<DirectAgentSubmissionInput> = {}): DirectAgentSubmissionInput {
	return {
		kind: 'direct',
		submissionId: 'direct-1',
		agent: 'assistant',
		id: 'agent-1',
		session: 'default',
		payload: { message: 'Hello' },
		acceptedAt: '2026-06-03T00:00:00.000Z',
		...overrides,
	};
}

function attempt(submissionId: string, attemptId: string) {
	return { submissionId, attemptId };
}

function sessionData(): SessionData {
	return {
		version: 5,
		affinityKey: 'affinity-1',
		entries: [],
		leafId: null,
		metadata: {},
		createdAt: '2026-06-03T00:00:00.000Z',
		updatedAt: '2026-06-03T00:00:00.000Z',
	};
}

// ─── Backend factories ──────────────────────────────────────────────────────

function createCloudflareSqlBackend(): AgentExecutionStore {
	const db = new DatabaseSync(':memory:');
	const sql: SqlStorage = {
		exec(query: string, ...bindings: unknown[]) {
			const stmt = db.prepare(query);
			let rows: Record<string, unknown>[];
			try {
				rows = stmt.all(...(bindings as never[])) as Record<string, unknown>[];
			} catch {
				stmt.run(...(bindings as never[]));
				rows = [];
			}
			return { toArray: () => rows };
		},
	};
	const runTransaction = <T>(closure: () => T): T => {
		db.exec('BEGIN');
		try {
			const result = closure();
			db.exec('COMMIT');
			return result;
		} catch (error) {
			db.exec('ROLLBACK');
			throw error;
		}
	};
	return createSqlAgentExecutionStoreFromSql(sql, runTransaction);
}

function createNodeBackend(): AgentExecutionStore {
	return createNodeAgentExecutionStore();
}

// ─── Contract tests ─────────────────────────────────────────────────────────

const backends = [
	{ name: 'cloudflare-sql', create: createCloudflareSqlBackend },
	{ name: 'node-sqlite', create: createNodeBackend },
] as const;

describe.each(backends)('AgentExecutionStore ($name)', ({ create }) => {
	// ── Sessions ──────────────────────────────────────────────────────────

	describe('sessions', () => {
		it('loads null for missing sessions', async () => {
			const store = create();
			expect(await store.sessions.load('missing')).toBeNull();
		});

		it('saves and loads session data', async () => {
			const store = create();
			await store.sessions.save('s1', sessionData());
			expect(await store.sessions.load('s1')).toEqual(sessionData());
		});

		it('overwrites existing session data', async () => {
			const store = create();
			await store.sessions.save('s1', sessionData());
			const updated = { ...sessionData(), updatedAt: '2026-06-04T00:00:00.000Z' };
			await store.sessions.save('s1', updated);
			expect(await store.sessions.load('s1')).toEqual(updated);
		});

		it('deletes existing sessions', async () => {
			const store = create();
			await store.sessions.save('s1', sessionData());
			await store.sessions.delete('s1');
			expect(await store.sessions.load('s1')).toBeNull();
		});

		it('silently handles deleting nonexistent sessions', async () => {
			const store = create();
			await expect(store.sessions.delete('missing')).resolves.toBeUndefined();
		});
	});

	// ── Dispatch admission ────────────────────────────────────────────────

	describe('dispatch admission', () => {
		it('admits one queued dispatch row when the same submission is replayed', () => {
			const store = create();
			const first = store.submissions.admitDispatch(dispatchInput());
			const replay = store.submissions.admitDispatch(dispatchInput());
			expect(replay).toEqual(first);
			expect(first).toMatchObject({
				kind: 'submission',
				submission: {
					submissionId: 'dispatch-1',
					sessionKey: 'agent-session:["agent-1","default","default"]',
					status: 'queued',
				},
			});
		});

		it('returns conflict when one dispatch id is reused with another payload', () => {
			const store = create();
			store.submissions.admitDispatch(dispatchInput());
			expect(store.submissions.admitDispatch(dispatchInput({ input: { text: 'Different' } }))).toEqual({
				kind: 'conflict',
			});
		});
	});

	// ── Submission ordering ───────────────────────────────────────────────

	describe('submission ordering', () => {
		it('orders direct and dispatched submissions together within one session', () => {
			const store = create();
			const direct = store.submissions.admitDirect(directInput());
			store.submissions.admitDispatch(dispatchInput());
			const other = store.submissions.admitDirect(
				directInput({ submissionId: 'direct-2', session: 'other' }),
			);
			expect(store.submissions.listRunnableSubmissions()).toEqual([direct, other]);
			expect(store.submissions.claimSubmission(attempt('dispatch-1', 'attempt-blocked'))).toBeNull();
		});

		it('lists queued dispatches in admission order and selects one runnable head per session', () => {
			const store = create();
			store.submissions.admitDispatch(dispatchInput());
			store.submissions.admitDispatch(dispatchInput({ dispatchId: 'dispatch-2' }));
			store.submissions.admitDispatch(dispatchInput({ dispatchId: 'dispatch-3', session: 'other' }));

			expect(store.submissions.listRunnableSubmissions()).toEqual([
				expect.objectContaining({ submissionId: 'dispatch-1' }),
				expect.objectContaining({ submissionId: 'dispatch-3' }),
			]);
		});
	});

	// ── Claim semantics ──────────────────────────────────────────────────

	describe('claim semantics', () => {
		it('claims only runnable session heads while allowing separate sessions to claim independently', () => {
			const store = create();
			store.submissions.admitDispatch(dispatchInput());
			store.submissions.admitDispatch(dispatchInput({ dispatchId: 'dispatch-2' }));
			store.submissions.admitDispatch(dispatchInput({ dispatchId: 'dispatch-3', session: 'other' }));

			const first = store.submissions.claimSubmission(attempt('dispatch-1', 'attempt-1'));
			const blocked = store.submissions.claimSubmission(attempt('dispatch-2', 'attempt-2'));
			const other = store.submissions.claimSubmission(attempt('dispatch-3', 'attempt-3'));

			expect(first).toMatchObject({
				submissionId: 'dispatch-1',
				status: 'running',
				attemptId: 'attempt-1',
				startedAt: expect.any(Number),
			});
			expect(blocked).toBeNull();
			expect(other).toMatchObject({
				submissionId: 'dispatch-3',
				status: 'running',
				attemptId: 'attempt-3',
			});
			expect(store.submissions.listRunningSubmissions()).toEqual([first, other]);
			expect(store.submissions.listRunnableSubmissions()).toEqual([]);
		});
	});

	// ── Lifecycle transitions ─────────────────────────────────────────────

	describe('lifecycle transitions', () => {
		it('records input application and recovery requests only for the owning attempt', () => {
			const store = create();
			store.submissions.admitDispatch(dispatchInput());
			store.submissions.claimSubmission(attempt('dispatch-1', 'attempt-1'));

			expect(store.submissions.markSubmissionInputApplied(attempt('dispatch-1', 'attempt-1'))).toBe(true);
			expect(store.submissions.markSubmissionInputApplied(attempt('dispatch-1', 'stale-attempt'))).toBe(false);
			expect(store.submissions.requestSubmissionRecovery(attempt('dispatch-1', 'attempt-1'))).toBe(true);
			expect(store.submissions.requestSubmissionRecovery(attempt('dispatch-1', 'stale-attempt'))).toBe(false);

			expect(store.submissions.getSubmission('dispatch-1')).toMatchObject({
				status: 'running',
				attemptId: 'attempt-1',
				inputAppliedAt: expect.any(Number),
				recoveryRequestedAt: expect.any(Number),
			});
		});

		it('requeues interrupted attempts only before canonical input application', () => {
			const store = create();
			store.submissions.admitDispatch(dispatchInput({ dispatchId: 'requeue-safe' }));
			store.submissions.admitDispatch(dispatchInput({ dispatchId: 'requeue-unsafe', session: 'other' }));
			store.submissions.claimSubmission(attempt('requeue-safe', 'attempt-safe'));
			store.submissions.claimSubmission(attempt('requeue-unsafe', 'attempt-unsafe'));
			store.submissions.markSubmissionInputApplied(attempt('requeue-unsafe', 'attempt-unsafe'));

			expect(store.submissions.requeueSubmissionBeforeInputApplied(attempt('requeue-safe', 'attempt-safe'))).toBe(true);
			expect(store.submissions.requeueSubmissionBeforeInputApplied(attempt('requeue-unsafe', 'attempt-unsafe'))).toBe(false);
			expect(store.submissions.getSubmission('requeue-safe')).toMatchObject({ status: 'queued' });
			expect(store.submissions.getSubmission('requeue-unsafe')).toMatchObject({ status: 'running' });
		});

		it('reports unsettled visibility until a claimed dispatch completes', () => {
			const store = create();
			store.submissions.admitDispatch(dispatchInput());
			expect(store.submissions.hasUnsettledSubmissions()).toBe(true);
			store.submissions.claimSubmission(attempt('dispatch-1', 'attempt-1'));
			expect(store.submissions.listRunningSubmissions()).toHaveLength(1);
			store.submissions.completeSubmission(attempt('dispatch-1', 'attempt-1'));
			expect(store.submissions.hasUnsettledSubmissions()).toBe(false);
			expect(store.submissions.getSubmission('dispatch-1')).toMatchObject({ status: 'settled' });
		});

		it('ignores stale-attempt settlement and keeps the first owning terminal state', () => {
			const store = create();
			store.submissions.admitDispatch(dispatchInput());
			store.submissions.claimSubmission(attempt('dispatch-1', 'attempt-1'));

			store.submissions.completeSubmission(attempt('dispatch-1', 'stale-attempt'));
			store.submissions.failSubmission(attempt('dispatch-1', 'attempt-1'), new Error('first failure'));
			store.submissions.completeSubmission(attempt('dispatch-1', 'attempt-1'));
			store.submissions.failSubmission(attempt('dispatch-1', 'attempt-1'), new Error('later failure'));

			expect(store.submissions.getSubmission('dispatch-1')).toMatchObject({
				status: 'settled',
				error: 'first failure',
			});
		});

		});

	// ── Durability ───────────────────────────────────────────────────────

	describe('durability', () => {
		it('initializes attempt_count to 0 and timeout_at to 0 at admission', () => {
			const store = create();
			store.submissions.admitDispatch(dispatchInput());
			const submission = store.submissions.getSubmission('dispatch-1');
			expect(submission).toMatchObject({
				attemptCount: 0,
				maxRetry: 10,
				timeoutAt: 0,
			});
		});

		it('sets attempt_count to 1 and applies system defaults at claim time', () => {
			const store = create();
			store.submissions.admitDispatch(dispatchInput());
			const before = Date.now();
			store.submissions.claimSubmission(attempt('dispatch-1', 'attempt-1'));
			const claimed = store.submissions.getSubmission('dispatch-1')!;
			expect(claimed.attemptCount).toBe(1);
			expect(claimed.maxRetry).toBe(10);
			expect(claimed.timeoutAt).toBeGreaterThanOrEqual(before + 60 * 60_000);
		});

		it('applies custom durability at claim time when provided', () => {
			const store = create();
			store.submissions.admitDispatch(dispatchInput());
			const customTimeout = Date.now() + 6 * 60 * 60_000;
			store.submissions.claimSubmission(attempt('dispatch-1', 'attempt-1'), {
				maxRetry: 5,
				timeoutAt: customTimeout,
			});
			expect(store.submissions.getSubmission('dispatch-1')).toMatchObject({
				attemptCount: 1,
				maxRetry: 5,
				timeoutAt: customTimeout,
			});
		});

		it('increments attempt_count on recovery via replaceTurnJournalAttempt', () => {
			const store = create();
			store.submissions.admitDispatch(dispatchInput());
			store.submissions.claimSubmission(attempt('dispatch-1', 'attempt-1'));
			expect(store.submissions.getSubmission('dispatch-1')).toMatchObject({ attemptCount: 1 });

			store.submissions.beginTurnJournal({
				submissionId: 'dispatch-1',
				sessionKey: 'agent-session:["agent-1","default","default"]',
				kind: 'dispatch',
				attemptId: 'attempt-1',
				operationId: 'op-1',
				turnId: 'turn-1',
				phase: 'before_provider',
			});

			const replaced = store.submissions.replaceTurnJournalAttempt(
				attempt('dispatch-1', 'attempt-1'),
				'attempt-2',
			);
			expect(replaced).toMatchObject({ attemptCount: 2, attemptId: 'attempt-2' });
		});
	});

	// ── Turn journal lifecycle ────────────────────────────────────────────

	describe('turn journal lifecycle', () => {
		it('creates, advances, and commits a turn journal through all phases', () => {
			const store = create();
			store.submissions.admitDispatch(dispatchInput());
			store.submissions.claimSubmission(attempt('dispatch-1', 'attempt-1'));

			expect(
				store.submissions.beginTurnJournal({
					submissionId: 'dispatch-1',
					sessionKey: 'agent-session:["agent-1","default","default"]',
					kind: 'dispatch',
					attemptId: 'attempt-1',
					operationId: 'op-1',
					turnId: 'turn-1',
					phase: 'before_provider',
				}),
			).toBe(true);
			expect(store.submissions.updateTurnJournalPhase(attempt('dispatch-1', 'attempt-1'), 'provider_started')).toBe(true);
			expect(store.submissions.updateTurnJournalPhase(attempt('dispatch-1', 'attempt-1'), 'tool_request_recorded', {
				toolRequest: { toolCalls: ['lookup'] },
			})).toBe(true);
			expect(store.submissions.getTurnJournal('dispatch-1')).toMatchObject({
				phase: 'tool_request_recorded',
				committed: false,
				toolRequest: { toolCalls: ['lookup'] },
			});
			expect(store.submissions.commitTurnJournal(attempt('dispatch-1', 'attempt-1'), 'leaf-1')).toBe(true);
			expect(store.submissions.getTurnJournal('dispatch-1')).toMatchObject({
				phase: 'committed',
				committed: true,
				committedLeafId: 'leaf-1',
			});
		});

		it('double-commit returns false', () => {
			const store = create();
			store.submissions.admitDispatch(dispatchInput());
			store.submissions.claimSubmission(attempt('dispatch-1', 'attempt-1'));
			store.submissions.beginTurnJournal({
				submissionId: 'dispatch-1',
				sessionKey: 'agent-session:["agent-1","default","default"]',
				kind: 'dispatch',
				attemptId: 'attempt-1',
				operationId: 'op-1',
				turnId: 'turn-1',
					phase: 'before_provider',
				});
			store.submissions.commitTurnJournal(attempt('dispatch-1', 'attempt-1'), 'leaf-1');
			expect(store.submissions.commitTurnJournal(attempt('dispatch-1', 'attempt-1'), 'leaf-1')).toBe(false);
		});

		it('resets journal on new turn after commit', () => {
			const store = create();
			store.submissions.admitDispatch(dispatchInput());
			store.submissions.claimSubmission(attempt('dispatch-1', 'attempt-1'));
			store.submissions.beginTurnJournal({
				submissionId: 'dispatch-1',
				sessionKey: 'agent-session:["agent-1","default","default"]',
				kind: 'dispatch',
				attemptId: 'attempt-1',
				operationId: 'op-1',
				turnId: 'turn-1',
				phase: 'before_provider',
			});
			store.submissions.commitTurnJournal(attempt('dispatch-1', 'attempt-1'), 'leaf-1');

			store.submissions.beginTurnJournal({
				submissionId: 'dispatch-1',
				sessionKey: 'agent-session:["agent-1","default","default"]',
				kind: 'dispatch',
				attemptId: 'attempt-1',
				operationId: 'op-2',
				turnId: 'turn-2',
				phase: 'before_provider',
			});

			expect(store.submissions.getTurnJournal('dispatch-1')).toMatchObject({
				phase: 'before_provider',
				committed: false,
				operationId: 'op-2',
				turnId: 'turn-2',
			});
		});

		it('replaces the journal attempt and returns the updated submission', () => {
			const store = create();
			store.submissions.admitDispatch(dispatchInput());
			store.submissions.claimSubmission(attempt('dispatch-1', 'attempt-1'));
			store.submissions.beginTurnJournal({
				submissionId: 'dispatch-1',
				sessionKey: 'agent-session:["agent-1","default","default"]',
				kind: 'dispatch',
				attemptId: 'attempt-1',
				operationId: 'op-1',
				turnId: 'turn-1',
				phase: 'before_provider',
			});

			const replaced = store.submissions.replaceTurnJournalAttempt(
				attempt('dispatch-1', 'attempt-1'),
				'attempt-2',
			);

			expect(replaced).toMatchObject({
				submissionId: 'dispatch-1',
				status: 'running',
				attemptId: 'attempt-2',
			});
			expect(store.submissions.getTurnJournal('dispatch-1')).toMatchObject({
				attemptId: 'attempt-2',
			});
		});

	});

	// ── Session deletion coordination ─────────────────────────────────────

	describe('session deletion', () => {
		it('rejects deletion while submissions are queued or running', async () => {
			const store = create();
			store.submissions.admitDispatch(dispatchInput());
			const sessionKey = 'agent-session:["agent-1","default","default"]';

			await expect(
				store.submissions.deleteSession(sessionKey, async () => {}),
			).rejects.toThrow('Session cannot be deleted while durable agent submissions are queued or running.');
		});

		it('blocks new submissions until session deletion completes', async () => {
			const store = create();
			const sessionKey = 'agent-session:["agent-1","default","default"]';
			let releaseDeletion: () => void = () => {};
			const deletionReleased = new Promise<void>((resolve) => {
				releaseDeletion = resolve;
			});

			const deletion = store.submissions.deleteSession(sessionKey, () => deletionReleased);
			expect(() => store.submissions.admitDispatch(dispatchInput())).toThrow(
				'Durable agent submission admission is unavailable while this session is being deleted.',
			);
			releaseDeletion();
			await deletion;
			expect(store.submissions.admitDispatch(dispatchInput())).toMatchObject({
				kind: 'submission',
				submission: { status: 'queued' },
			});
		});

		it('shares session deletion work while deletion is in progress', async () => {
			const store = create();
			const sessionKey = 'agent-session:["agent-1","default","default"]';
			let releaseDeletion: () => void = () => {};
			const deletionReleased = new Promise<void>((resolve) => {
				releaseDeletion = resolve;
			});
			let deletionCalls = 0;

			const first = store.submissions.deleteSession(sessionKey, async () => {
				deletionCalls += 1;
				await deletionReleased;
			});
			const second = store.submissions.deleteSession(sessionKey, async () => {
				deletionCalls += 1;
			});

			expect(second).toBe(first);
			expect(deletionCalls).toBe(1);
			releaseDeletion();
			await Promise.all([first, second]);
		});

		it('keeps new submissions blocked when snapshot deletion fails', async () => {
			const store = create();
			const sessionKey = 'agent-session:["agent-1","default","default"]';

			await expect(
				store.submissions.deleteSession(sessionKey, async () => {
					throw new Error('snapshot deletion failed');
				}),
			).rejects.toThrow('snapshot deletion failed');
			expect(() => store.submissions.admitDispatch(dispatchInput())).toThrow(
				'Durable agent submission admission is unavailable while this session is being deleted.',
			);
			await expect(store.submissions.deleteSession(sessionKey, async () => {})).resolves.toBeUndefined();
			expect(store.submissions.admitDispatch(dispatchInput())).toMatchObject({
				kind: 'submission',
				submission: { status: 'queued' },
			});
		});

		it('clears terminal rows when a settled session is deleted', async () => {
			const store = create();
			const sessionKey = 'agent-session:["agent-1","default","default"]';
			store.submissions.admitDispatch(dispatchInput());
			store.submissions.claimSubmission(attempt('dispatch-1', 'attempt-1'));
			store.submissions.completeSubmission(attempt('dispatch-1', 'attempt-1'));

			await store.submissions.deleteSession(sessionKey, async () => {});

			expect(store.submissions.getSubmission('dispatch-1')).toBeNull();
		});

		it('returns retained receipt after deletion removed the settled dispatch row', async () => {
			const store = create();
			const sessionKey = 'agent-session:["agent-1","default","default"]';
			store.submissions.admitDispatch(dispatchInput());
			store.submissions.claimSubmission(attempt('dispatch-1', 'attempt-1'));
			store.submissions.completeSubmission(attempt('dispatch-1', 'attempt-1'));
			await store.submissions.deleteSession(sessionKey, async () => {});

			expect(store.submissions.admitDispatch(dispatchInput())).toEqual({
				kind: 'retained_receipt',
				receipt: {
					submissionId: 'dispatch-1',
					acceptedAt: Date.parse('2026-06-03T00:00:00.000Z'),
				},
			});
		});
	});

	// ── Edge cases ──────────────────────────────────────────────────────

	describe('edge cases', () => {
		it('reports no unsettled submissions initially', () => {
			const store = create();
			expect(store.submissions.hasUnsettledSubmissions()).toBe(false);
		});

		it('getSubmission returns null for unknown ids', () => {
			const store = create();
			expect(store.submissions.getSubmission('nonexistent')).toBeNull();
		});

		it('getTurnJournal returns null for unknown submissions', () => {
			const store = create();
			expect(store.submissions.getTurnJournal('nonexistent')).toBeNull();
		});

	});
});
