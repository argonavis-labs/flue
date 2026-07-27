import { FLUE_SCHEMA_VERSION } from './schema-version.ts';
import type { SqlStorage } from './sql-storage.ts';

// Literal `<from>-><to>` pairs, added only after verifying the bump left every
// transcript, event-stream, attachment, and run table byte-identical. Never key
// off the current version: a future bump must review and add its own pair.
const OPERATIONAL_ONLY_TRANSITIONS: ReadonlySet<string> = new Set(['4->5']);

const OPERATIONAL_TABLES = [
	'flue_agent_submissions',
	'flue_agent_dispatch_receipts',
	'flue_agent_attempt_markers',
	'flue_image_chunks',
] as const;

export function healIncompatibleAgentStore(
	sql: SqlStorage | undefined,
	runInTransaction?: <T>(closure: () => T) => T,
): void {
	// A store without synchronous SQL and a transaction is not a valid persisted
	// boundary; touch nothing so the store's own gate rejects it unchanged.
	if (!sql || typeof sql.exec !== 'function' || !runInTransaction) return;

	const hasMeta =
		sql
			.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'flue_meta' LIMIT 1`)
			.toArray().length > 0;
	if (!hasMeta) return;

	const stored = sql.exec(`SELECT value FROM flue_meta WHERE key = 'schema_version'`).toArray()[0]
		?.value;
	if (stored === undefined || stored === null) return;
	if (String(stored) === String(FLUE_SCHEMA_VERSION)) return;

	const transition = `${stored}->${FLUE_SCHEMA_VERSION}`;
	if (!OPERATIONAL_ONLY_TRANSITIONS.has(transition)) return;

	runInTransaction(() => {
		for (const table of OPERATIONAL_TABLES) sql.exec(`DROP TABLE IF EXISTS ${table}`);
		sql.exec(
			`INSERT INTO flue_meta (key, value) VALUES ('schema_version', ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			String(FLUE_SCHEMA_VERSION),
		);
	});
	console.info(
		`[flue] schema-self-heal: cleared agent-execution stores for transition ${transition}; transcript preserved.`,
	);
}
