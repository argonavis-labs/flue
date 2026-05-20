import { InMemoryFs } from 'just-bash';
import type {
	DefaultWorkspaceScope,
	DefaultWorkspaceStore,
} from '../runtime/default-workspace-store.ts';

interface SqlResult {
	toArray(): SqlRow[];
}

type SqlRow = Record<string, unknown>;

export interface SqlStorage {
	exec(query: string, ...bindings: unknown[]): SqlResult;
}

export function createDurableDefaultWorkspaceStore(sql: SqlStorage): DefaultWorkspaceStore {
	ensureWorkspaceTable(sql);
	return new DurableDefaultWorkspaceStore(sql);
}

class DurableDefaultWorkspaceStore implements DefaultWorkspaceStore {
	constructor(private sql: SqlStorage) {}

	async get(scope: DefaultWorkspaceScope): Promise<PersistedWorkspaceFs> {
		return PersistedWorkspaceFs.load(this.sql, scope);
	}
}

class PersistedWorkspaceFs extends InMemoryFs {
	private hydrating = false;

	private constructor(
		private sql: SqlStorage,
		private scope: DefaultWorkspaceScope,
	) {
		super();
	}

	static async load(sql: SqlStorage, scope: DefaultWorkspaceScope): Promise<PersistedWorkspaceFs> {
		const fs = new PersistedWorkspaceFs(sql, scope);
		const rows = sql
			.exec(
				`SELECT path, kind, content, encoding, target, mode, mtime
				 FROM flue_default_workspace_entries
				 WHERE agent_name = ? AND instance_id = ? AND harness_name = ?
				 ORDER BY LENGTH(path) ASC, path ASC`,
				scope.agentName,
				scope.instanceId,
				scope.harnessName,
			)
			.toArray();
		await fs.hydrate(rows);
		return fs;
	}

	override async writeFile(path: string, content: string | Uint8Array, options?: unknown): Promise<void> {
		await super.writeFile(path, content, options as never);
		await this.persist();
	}

	override async appendFile(path: string, content: string | Uint8Array, options?: unknown): Promise<void> {
		await super.appendFile(path, content, options as never);
		await this.persist();
	}

	override async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		await super.mkdir(path, options);
		await this.persist();
	}

	override async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		await super.rm(path, options);
		await this.persist();
	}

	override async cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void> {
		await super.cp(src, dest, options);
		await this.persist();
	}

	override async mv(src: string, dest: string): Promise<void> {
		await super.mv(src, dest);
		await this.persist();
	}

	override async chmod(path: string, mode: number): Promise<void> {
		await super.chmod(path, mode);
		await this.persist();
	}

	override async symlink(target: string, linkPath: string): Promise<void> {
		await super.symlink(target, linkPath);
		await this.persist();
	}

	override async link(existingPath: string, newPath: string): Promise<void> {
		await super.link(existingPath, newPath);
		await this.persist();
	}

	override async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
		await super.utimes(path, atime, mtime);
		await this.persist();
	}

	private async hydrate(rows: SqlRow[]): Promise<void> {
		this.hydrating = true;
		try {
			for (const row of rows) {
				const path = String(row.path);
				const kind = String(row.kind);
				if (kind === 'directory') {
					await super.mkdir(path, { recursive: true });
				} else if (kind === 'symlink') {
					await ensureParentDirectory(this, path);
					await super.symlink(String(row.target ?? ''), path);
				} else {
					await ensureParentDirectory(this, path);
					const content = typeof row.content === 'string' ? row.content : '';
					await super.writeFile(path, row.encoding === 'base64' ? decodeBase64(content) : content);
				}
				if (typeof row.mode === 'number') await super.chmod(path, row.mode);
				if (typeof row.mtime === 'number') {
					const mtime = new Date(row.mtime);
					await super.utimes(path, mtime, mtime);
				}
			}
		} finally {
			this.hydrating = false;
		}
	}

	private async persist(): Promise<void> {
		if (this.hydrating) return;
		this.sql.exec(
			`DELETE FROM flue_default_workspace_entries
			 WHERE agent_name = ? AND instance_id = ? AND harness_name = ?`,
			this.scope.agentName,
			this.scope.instanceId,
			this.scope.harnessName,
		);
		for (const path of this.getAllPaths()) {
			try {
				const stat = await this.lstat(path);
				const kind = stat.isDirectory ? 'directory' : stat.isSymbolicLink ? 'symlink' : 'file';
				const bytes = kind === 'file' ? await this.readFileBuffer(path) : undefined;
				const target = kind === 'symlink' ? await this.readlink(path) : undefined;
				this.sql.exec(
					`INSERT OR REPLACE INTO flue_default_workspace_entries
					 (agent_name, instance_id, harness_name, path, kind, content, encoding, target, mode, mtime)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					this.scope.agentName,
					this.scope.instanceId,
					this.scope.harnessName,
					path,
					kind,
					bytes ? encodeBase64(bytes) : '',
					bytes ? 'base64' : 'none',
					target ?? '',
					stat.mode,
					stat.mtime.getTime(),
				);
			} catch {
			}
		}
	}
}

async function ensureParentDirectory(fs: InMemoryFs, path: string): Promise<void> {
	const slash = path.lastIndexOf('/');
	const parent = slash <= 0 ? '/' : path.slice(0, slash);
	await fs.mkdir(parent, { recursive: true }).catch(() => {});
}

function ensureWorkspaceTable(sql: SqlStorage): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_default_workspace_entries (
		 agent_name TEXT NOT NULL,
		 instance_id TEXT NOT NULL,
		 harness_name TEXT NOT NULL,
		 path TEXT NOT NULL,
		 kind TEXT NOT NULL,
		 content TEXT NOT NULL,
		 encoding TEXT NOT NULL,
		 target TEXT NOT NULL,
		 mode INTEGER NOT NULL,
		 mtime INTEGER NOT NULL,
		 PRIMARY KEY (agent_name, instance_id, harness_name, path)
		)`,
	);
}

function encodeBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
	const binary = atob(value);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
