/**
 * Node agent execution store and built-in SQLite persistence adapter.
 *
 * Uses the same SQL store implementation as Cloudflare (DO SQLite) but runs
 * against `node:sqlite`'s `DatabaseSync`. Pass `:memory:` (default) for
 * process-lifetime storage, or a file path for persistent storage.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentExecutionStore, PersistenceAdapter, SqlStorage } from '../agent-execution-store.ts';
import { createSqlAgentExecutionStoreFromSql } from '../cloudflare/agent-execution-store.ts';

/**
 * Adapt `node:sqlite` {@link DatabaseSync} to the Cloudflare {@link SqlStorage}
 * shape expected by the shared SQL store implementation.
 *
 * `node:sqlite`'s `.all()` only works for statements that return rows (SELECT,
 * INSERT/UPDATE...RETURNING). Write-only statements (CREATE, INSERT, UPDATE
 * without RETURNING) must use `.run()` instead. We distinguish by checking
 * whether the query expects result rows.
 */
function createNodeSqlStorage(db: DatabaseSync): SqlStorage {
	return {
		exec(query: string, ...bindings: unknown[]) {
			const stmt = db.prepare(query);
			const expectsRows = queryExpectsRows(query);
			let rows: Record<string, unknown>[];
			if (expectsRows) {
				rows = stmt.all(...(bindings as never[])) as Record<string, unknown>[];
			} else {
				stmt.run(...(bindings as never[]));
				rows = [];
			}
			return {
				toArray() {
					return rows;
				},
			};
		},
	};
}

/** Check whether a SQL query is expected to return result rows. */
function queryExpectsRows(query: string): boolean {
	const trimmed = query.trimStart().toUpperCase();
	if (trimmed.startsWith('SELECT')) return true;
	if (/\bRETURNING\b/i.test(query)) return true;
	return false;
}

/**
 * Create an in-memory transaction wrapper for `node:sqlite`.
 */
function createNodeTransactionSync(db: DatabaseSync): <T>(closure: () => T) => T {
	return <T>(closure: () => T): T => {
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
}

/** Open a `node:sqlite` database and return the handle + execution store. */
function openDatabase(path: string): { db: DatabaseSync; store: AgentExecutionStore } {
	if (path !== ':memory:') {
		mkdirSync(dirname(path), { recursive: true });
	}
	const db = new DatabaseSync(path);
	if (path !== ':memory:') {
		db.exec('PRAGMA journal_mode=WAL');
	}
	const sql = createNodeSqlStorage(db);
	const runTransaction = createNodeTransactionSync(db);
	return { db, store: createSqlAgentExecutionStoreFromSql(sql, runTransaction) };
}

/**
 * Create a process-local {@link AgentExecutionStore} backed by `node:sqlite`.
 *
 * Uses `:memory:` by default — data is lost on process exit. Pass a file path
 * for local development persistence.
 */
export function createNodeAgentExecutionStore(
	path: string = ':memory:',
): AgentExecutionStore {
	return openDatabase(path).store;
}

/**
 * Built-in SQLite persistence adapter for Node.js.
 *
 * @param path - SQLite database file path. Omit or pass `':memory:'` for an
 *   in-memory database (data lost on process exit). Pass a file path for
 *   persistent storage across restarts.
 *
 * @example
 * ```ts
 * // src/db.ts
 * import { sqlite } from '@flue/runtime/node';
 * export default sqlite('./data/flue.db');
 * ```
 */
export function sqlite(path?: string): PersistenceAdapter {
	if (path !== undefined && path !== ':memory:' && path.trim() === '') {
		throw new Error('[flue] sqlite() requires a non-empty file path, or omit the argument for an in-memory database.');
	}
	const resolvedPath = path ?? ':memory:';
	let db: DatabaseSync | undefined;
	return {
		createStore() {
			const opened = openDatabase(resolvedPath);
			db = opened.db;
			return opened.store;
		},
		close() {
			db?.close();
			db = undefined;
		},
	};
}
