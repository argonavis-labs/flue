import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { healIncompatibleAgentStore } from '../src/agent-store-self-heal.ts';
import { createCloudflareAgentRuntime } from '../src/cloudflare/agent-coordinator.ts';
import { createSqlAgentExecutionStore } from '../src/cloudflare/agent-execution-store.ts';
import { sqlite } from '../src/node/agent-execution-store.ts';

function makeFakeSql() {
	const db = new DatabaseSync(':memory:');
	const sql = {
		exec(query: string, ...bindings: unknown[]) {
			const stmt = db.prepare(query);
			const trimmed = query.trimStart().toUpperCase();
			const expectsRows =
				trimmed.startsWith('SELECT') ||
				trimmed.startsWith('WITH') ||
				/\bRETURNING\b/i.test(query);
			let rows: unknown[];
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
	};
	const transactionSync = <T>(closure: () => T): T => {
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
	return { db, sql, transactionSync };
}

function tableExists(db: DatabaseSync, table: string): boolean {
	return (
		db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).all(table)
			.length > 0
	);
}

function storedVersion(db: DatabaseSync): string | undefined {
	const row = db.prepare(`SELECT value FROM flue_meta WHERE key = 'schema_version'`).get() as
		| { value: string }
		| undefined;
	return row?.value;
}

function seedStoreStampedAt(version: string) {
	const fake = makeFakeSql();
	const { db, sql, transactionSync } = fake;
	const store = createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent');
	// operational data
	db.prepare(
		`INSERT INTO flue_agent_submissions
		 (submission_id, session_key, kind, payload, status, accepted_at)
		 VALUES ('sub-1', 'session-1', 'dispatch', '{}', 'queued', 1)`,
	).run();
	// transcript data lives in a table the heal must never touch
	db.exec(`CREATE TABLE flue_conversation_streams (path TEXT PRIMARY KEY, next_offset INTEGER)`);
	db.prepare(`INSERT INTO flue_conversation_streams (path, next_offset) VALUES ('root', 7)`).run();
	db.prepare(`UPDATE flue_meta SET value = ? WHERE key = 'schema_version'`).run(version);
	return { ...fake, store };
}

function transcriptSurvives(db: DatabaseSync): boolean {
	if (!tableExists(db, 'flue_conversation_streams')) return false;
	const row = db.prepare(`SELECT next_offset FROM flue_conversation_streams WHERE path = 'root'`).get() as
		| { next_offset: number }
		| undefined;
	return row?.next_offset === 7;
}

describe('healIncompatibleAgentStore()', () => {
	it('heals a v4 store: drops the submission queue, preserves the transcript, and re-stamps to 5 so the store opens', () => {
		const { db, sql, transactionSync } = seedStoreStampedAt('4');
		// precondition: a v4 store cannot be opened by the v5 runtime
		expect(() => createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent')).toThrow(
			'unrecognized schema version ("4"',
		);

		healIncompatibleAgentStore(sql, transactionSync);

		expect(transcriptSurvives(db)).toBe(true);
		expect(storedVersion(db)).toBe('5');
		// the store now opens without throwing, with an empty submission queue
		expect(() =>
			createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent'),
		).not.toThrow();
		expect(
			db.prepare(`SELECT COUNT(*) AS count FROM flue_agent_submissions`).get(),
		).toEqual({ count: 0 });
	});

	it('leaves an unrecognized transition to fail loud: a v3 store is not healed and still rejects', () => {
		const { db, sql, transactionSync } = seedStoreStampedAt('3');

		healIncompatibleAgentStore(sql, transactionSync);

		expect(storedVersion(db)).toBe('3');
		expect(
			db.prepare(`SELECT COUNT(*) AS count FROM flue_agent_submissions`).get(),
		).toEqual({ count: 1 });
		expect(() => createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent')).toThrow(
			'unrecognized schema version ("3"',
		);
	});

	it('is a no-op on a current-version store', () => {
		const { db, sql, transactionSync } = seedStoreStampedAt('5');

		healIncompatibleAgentStore(sql, transactionSync);

		expect(storedVersion(db)).toBe('5');
		expect(
			db.prepare(`SELECT COUNT(*) AS count FROM flue_agent_submissions`).get(),
		).toEqual({ count: 1 });
	});

	it('is a no-op on a fresh database with no flue_meta table', () => {
		const { sql, transactionSync } = makeFakeSql();
		expect(() => healIncompatibleAgentStore(sql, transactionSync)).not.toThrow();
	});

	it('heals idempotently when run twice', () => {
		const { db, sql, transactionSync } = seedStoreStampedAt('4');

		healIncompatibleAgentStore(sql, transactionSync);
		healIncompatibleAgentStore(sql, transactionSync);

		expect(storedVersion(db)).toBe('5');
		expect(transcriptSurvives(db)).toBe(true);
	});
});

function makeRuntime() {
	return createCloudflareAgentRuntime({
		agents: [],
		createContext: () => {
			throw new Error('Unexpected context creation.');
		},
		runWithInstanceContext: (_instance, _agentName, callback) => callback(),
	});
}

describe('agent-store self-heal wiring', () => {
	it('Cloudflare prepare() boots a v4-stamped store instead of throwing', () => {
		const { db, sql, transactionSync } = makeFakeSql();
		const storage = { sql, transactionSync };
		const runtime = makeRuntime();
		runtime.prepare({ storage, className: 'FlueAssistantAgent', agentName: 'assistant' });
		db.prepare(
			`INSERT INTO flue_agent_submissions
			 (submission_id, session_key, kind, payload, status, accepted_at)
			 VALUES ('sub-1', 'session-1', 'dispatch', '{}', 'queued', 1)`,
		).run();
		db.prepare(`UPDATE flue_meta SET value = '4' WHERE key = 'schema_version'`).run();

		expect(() =>
			runtime.prepare({ storage, className: 'FlueAssistantAgent', agentName: 'assistant' }),
		).not.toThrow();
		expect(storedVersion(db)).toBe('5');
		expect(tableExists(db, 'flue_conversation_streams')).toBe(true);
		expect(db.prepare(`SELECT COUNT(*) AS count FROM flue_agent_submissions`).get()).toEqual({
			count: 0,
		});
	});

	it('node sqlite() adapter boots a v4-stamped database on migrate()', () => {
		const path = join(tmpdir(), `flue-self-heal-${process.pid}-${healDbCounter++}.db`);
		try {
			const seed = sqlite(path);
			seed.migrate?.();
			seed.close?.();
			const raw = new DatabaseSync(path);
			raw.prepare(`UPDATE flue_meta SET value = '4' WHERE key = 'schema_version'`).run();
			raw.close();

			const reopened = sqlite(path);
			expect(() => reopened.migrate?.()).not.toThrow();
			reopened.close?.();

			const verify = new DatabaseSync(path);
			expect(storedVersion(verify)).toBe('5');
			verify.close();
		} finally {
			rmSync(path, { force: true });
		}
	});
});

let healDbCounter = 0;
