import { FLUE_SCHEMA_VERSION } from './schema-version.ts';
import type { SqlStorage } from './sql-storage.ts';

// Append `<from>-><to>` only after verifying the bump left every transcript,
// event-stream, attachment, and run table byte-identical; other stored
// versions fall through to the store's version gate (fail loud).
const OPERATIONAL_ONLY_TRANSITIONS: ReadonlySet<string> = new Set([`4->${FLUE_SCHEMA_VERSION}`]);

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
	if (!sql || typeof sql.exec !== 'function') return;

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

	const run = runInTransaction ?? ((closure) => closure());
	run(() => {
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
