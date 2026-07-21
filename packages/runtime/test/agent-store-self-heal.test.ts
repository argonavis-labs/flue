import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { healIncompatibleAgentStore } from '../src/agent-store-self-heal.ts';
import { createCloudflareAgentRuntime } from '../src/cloudflare/agent-coordinator.ts';
import {
	createSqlAgentExecutionStore,
	createSqlConversationStores,
} from '../src/cloudflare/agent-execution-store.ts';
import { PersistedSchemaVersionError } from '../src/errors.ts';
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

function captureThrow(fn: () => unknown): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	throw new Error('Expected the call to throw, but it returned normally.');
}

function expectSchemaVersionRejection(fn: () => unknown, storedVersion: string): void {
	const cause = (captureThrow(fn) as Error).cause;
	expect(cause).toBeInstanceOf(PersistedSchemaVersionError);
	expect((cause as PersistedSchemaVersionError).type).toBe('persisted_schema_version_unsupported');
	expect((cause as PersistedSchemaVersionError).meta).toMatchObject({ storedVersion });
}

function tableNames(db: DatabaseSync): Set<string> {
	return new Set(
		(
			db
				.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'flue_%'`)
				.all() as Array<{ name: string }>
		).map((row) => row.name),
	);
}

function storedVersion(db: DatabaseSync): string | undefined {
	const row = db.prepare(`SELECT value FROM flue_meta WHERE key = 'schema_version'`).get() as
		| { value: string }
		| undefined;
	return row?.value;
}

function submissionCount(db: DatabaseSync): number {
	return (db.prepare(`SELECT COUNT(*) AS count FROM flue_agent_submissions`).get() as {
		count: number;
	}).count;
}

const OPERATIONAL_TABLES = new Set([
	'flue_agent_submissions',
	'flue_agent_dispatch_receipts',
	'flue_agent_attempt_markers',
	'flue_image_chunks',
]);

function nonOperationalTables(db: DatabaseSync): Set<string> {
	return new Set([...tableNames(db)].filter((name) => !OPERATIONAL_TABLES.has(name)));
}

function seedStoreStampedAt(version: string) {
	const fake = makeFakeSql();
	const { db, sql, transactionSync } = fake;
	const storage = { sql, transactionSync };
	// Build the real operational + transcript schema, then re-stamp so the store
	// looks like one persisted by an older/other schema version.
	createSqlAgentExecutionStore(storage, 'FlueAssistantAgent');
	createSqlConversationStores(storage);
	db.prepare(
		`INSERT INTO flue_agent_submissions
		 (submission_id, session_key, kind, payload, status, accepted_at)
		 VALUES ('sub-1', 'session-1', 'dispatch', '{}', 'queued', 1)`,
	).run();
	db.prepare(
		`INSERT INTO flue_conversation_streams
		 (path, identity_json, next_offset, producer_epoch, next_producer_sequence, incarnation)
		 VALUES ('root', '{}', 7, 0, 0, 'inc-1')`,
	).run();
	db.prepare(
		`INSERT INTO flue_attachments
		 (stream_path, attachment_id, mime_type, byte_size, digest, conversation_id, chunk_count, created_at)
		 VALUES ('root', 'att-1', 'image/png', 42, 'sha-1', 'conv-1', 1, 1)`,
	).run();
	db.prepare(`UPDATE flue_meta SET value = ? WHERE key = 'schema_version'`).run(version);
	return fake;
}

function transcriptRowsSurvive(db: DatabaseSync): boolean {
	const stream = db
		.prepare(`SELECT next_offset FROM flue_conversation_streams WHERE path = 'root'`)
		.get() as { next_offset: number } | undefined;
	const attachment = db
		.prepare(`SELECT byte_size FROM flue_attachments WHERE attachment_id = 'att-1'`)
		.get() as { byte_size: number } | undefined;
	return stream?.next_offset === 7 && attachment?.byte_size === 42;
}

describe('healIncompatibleAgentStore()', () => {
	it('clears the submission queue and preserves every transcript store when the stored version is an operational-only prior version', () => {
		const { db, sql, transactionSync } = seedStoreStampedAt('4');
		const preservedBefore = nonOperationalTables(db);
		expectSchemaVersionRejection(
			() => createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent'),
			'4',
		);

		healIncompatibleAgentStore(sql, transactionSync);

		expect(storedVersion(db)).toBe('5');
		expect(nonOperationalTables(db)).toEqual(preservedBefore);
		expect(transcriptRowsSurvive(db)).toBe(true);
		expect(() =>
			createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent'),
		).not.toThrow();
		expect(submissionCount(db)).toBe(0);
	});

	it('leaves the store unchanged and surfaces a schema-version rejection when the transition is not operational-only', () => {
		const { db, sql, transactionSync } = seedStoreStampedAt('3');

		healIncompatibleAgentStore(sql, transactionSync);

		expect(storedVersion(db)).toBe('3');
		expect(submissionCount(db)).toBe(1);
		expectSchemaVersionRejection(
			() => createSqlAgentExecutionStore({ sql, transactionSync }, 'FlueAssistantAgent'),
			'3',
		);
	});

	it('makes no change when the store is already at the current version', () => {
		const { db, sql, transactionSync } = seedStoreStampedAt('5');

		healIncompatibleAgentStore(sql, transactionSync);

		expect(storedVersion(db)).toBe('5');
		expect(submissionCount(db)).toBe(1);
	});

	it('makes no change when the database has no flue_meta table', () => {
		const { sql, transactionSync } = makeFakeSql();
		expect(() => healIncompatibleAgentStore(sql, transactionSync)).not.toThrow();
	});

	it('leaves the store unmutated when no transaction wrapper is provided', () => {
		const { db, sql } = seedStoreStampedAt('4');

		healIncompatibleAgentStore(sql, undefined);

		expect(storedVersion(db)).toBe('4');
		expect(submissionCount(db)).toBe(1);
	});

	it('converges to the current version when run twice', () => {
		const { db, sql, transactionSync } = seedStoreStampedAt('4');

		healIncompatibleAgentStore(sql, transactionSync);
		healIncompatibleAgentStore(sql, transactionSync);

		expect(storedVersion(db)).toBe('5');
		expect(transcriptRowsSurvive(db)).toBe(true);
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
	it('boots a v4-stamped store instead of throwing when Cloudflare prepare() opens it', () => {
		const { db, sql, transactionSync } = seedStoreStampedAt('4');
		const runtime = makeRuntime();

		expect(() =>
			runtime.prepare({
				storage: { sql, transactionSync },
				className: 'FlueAssistantAgent',
				agentName: 'assistant',
			}),
		).not.toThrow();
		expect(storedVersion(db)).toBe('5');
		expect(transcriptRowsSurvive(db)).toBe(true);
		expect(submissionCount(db)).toBe(0);
	});

	it('boots a v4-stamped database instead of throwing when the node sqlite() adapter opens it', () => {
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
