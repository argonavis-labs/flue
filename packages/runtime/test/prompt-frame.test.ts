import { describe, expect, it } from 'vitest';
import { defineAgentProfile, resolveAgentProfile } from '../src/agent-definition.ts';
import { discoverSessionContext } from '../src/context.ts';
import { defineAgent } from '../src/index.ts';
import { createFlueContext, resolveModel } from '../src/internal.ts';
import type { SessionEnv } from '../src/types.ts';

function createEnv({
	cwd = '/repo',
	files = {},
}: { cwd?: string; files?: Record<string, string> } = {}): SessionEnv {
	const normalize = (path: string) => {
		const segments: string[] = [];
		for (const segment of path.split('/')) {
			if (!segment || segment === '.') continue;
			if (segment === '..') segments.pop();
			else segments.push(segment);
		}
		return `/${segments.join('/')}`;
	};
	const resolvePath = (path: string) => normalize(path.startsWith('/') ? path : `${cwd}/${path}`);

	return {
		cwd,
		resolvePath,
		exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
		readFile: async (path) => {
			const content = files[resolvePath(path)];
			if (content === undefined) throw new Error(`missing file: ${path}`);
			return content;
		},
		readFileBuffer: async () => new Uint8Array(),
		writeFile: async () => {},
		stat: async (path) => {
			const resolved = resolvePath(path);
			return {
				isFile: Object.hasOwn(files, resolved),
				isDirectory: Object.keys(files).some((file) => file.startsWith(`${resolved}/`)),
				isSymbolicLink: false,
				size: 0,
				mtime: new Date(0),
			};
		},
		readdir: async (path) => {
			const resolved = resolvePath(path);
			const entries = new Set<string>();
			for (const file of Object.keys(files)) {
				if (!file.startsWith(`${resolved}/`)) continue;
				const entry = file.slice(resolved.length + 1).split('/')[0];
				if (entry) entries.add(entry);
			}
			return [...entries];
		},
		exists: async (path) => {
			const resolved = resolvePath(path);
			return (
				Object.hasOwn(files, resolved) ||
				Object.keys(files).some((file) => file.startsWith(`${resolved}/`))
			);
		},
		mkdir: async () => {},
		rm: async () => {},
	};
}

const workspaceFiles = {
	'/repo/AGENTS.md': 'Repository conventions live here.',
	'/repo/.agents/skills/review/SKILL.md':
		'---\nname: review\ndescription: Review workspace changes.\n---\nRead the workspace checklist.',
};

describe('promptFrame profile resolution', () => {
	it('accepts promptFrame: "none" in an agent profile', () => {
		expect(defineAgentProfile({ promptFrame: 'none' }).promptFrame).toBe('none');
	});

	it('rejects an unknown promptFrame value', () => {
		expect(() => defineAgentProfile({ promptFrame: 'minimal' as never })).toThrow(
			/requires a valid agent profile/,
		);
	});

	it('lets the runtime config promptFrame override the profile', () => {
		const resolved = resolveAgentProfile({
			promptFrame: 'none',
			profile: { promptFrame: 'full' },
		});

		expect(resolved.promptFrame).toBe('none');
	});

	it('inherits the profile promptFrame when the runtime config omits it', () => {
		const resolved = resolveAgentProfile({ profile: { promptFrame: 'none' } });

		expect(resolved.promptFrame).toBe('none');
	});

	it('leaves promptFrame unset when neither layer supplies it', () => {
		expect(resolveAgentProfile({}).promptFrame).toBeUndefined();
	});
});

describe('discoverSessionContext() promptFrame', () => {
	it('composes the full workspace frame by default', async () => {
		const env = createEnv({ files: workspaceFiles });

		const context = await discoverSessionContext(env, 'You are the app.');

		// The default frame carries framework contributions beyond the
		// instructions — this is the baseline 'none' must strip.
		expect(context.systemPrompt).toContain('You are the app.');
		expect(context.systemPrompt).toContain('Repository conventions live here.');
		expect(context.systemPrompt).toContain('Available Skills');
		expect(context.systemPrompt).not.toBe('You are the app.');
	});

	it("makes the instructions the entire system prompt under 'none' and skips workspace discovery", async () => {
		const env = createEnv({ files: workspaceFiles });
		const definitionSkill = { name: 'triage', description: 'Triage incoming reports.' };

		const context = await discoverSessionContext(
			env,
			'You are the app.',
			[definitionSkill],
			'none',
		);

		// Nothing framework-owned may leak in: no preamble, AGENTS.md, skills
		// catalog, date, cwd, or directory listing.
		expect(context.systemPrompt).toBe('You are the app.');
		// Definition skills still register (no I/O); workspace skills are not
		// discovered — the application owns the whole skill surface.
		expect(Object.keys(context.skills)).toEqual(['triage']);
	});

	it("never touches the session env when promptFrame is 'none'", async () => {
		const untouchable = () => {
			throw new Error('promptFrame none must not touch the session env');
		};
		const env: SessionEnv = {
			cwd: '/repo',
			resolvePath: untouchable,
			exec: untouchable,
			readFile: untouchable,
			readFileBuffer: untouchable,
			writeFile: untouchable,
			stat: untouchable,
			readdir: untouchable,
			exists: untouchable,
			mkdir: untouchable,
			rm: untouchable,
		};

		const context = await discoverSessionContext(env, 'You are the app.', [], 'none');

		expect(context.systemPrompt).toBe('You are the app.');
		expect(Object.keys(context.skills)).toEqual([]);
	});

	it("returns an empty system prompt under 'none' when the profile has no instructions", async () => {
		const env = createEnv({ files: workspaceFiles });

		const context = await discoverSessionContext(env, undefined, [], 'none');

		expect(context.systemPrompt).toBe('');
	});
});

describe('initializeRootHarness() promptFrame', () => {
	it("initializes the harness and session without touching the session env when promptFrame is 'none'", async () => {
		const untouchable = () => {
			throw new Error('promptFrame none must not touch the session env');
		};
		const env: SessionEnv = {
			cwd: '/repo',
			resolvePath: untouchable,
			exec: untouchable,
			readFile: untouchable,
			readFileBuffer: untouchable,
			writeFile: untouchable,
			stat: untouchable,
			readdir: untouchable,
			exists: untouchable,
			mkdir: untouchable,
			rm: untouchable,
		};
		const context = createFlueContext({
			id: 'agent-instance',
			env: {},
			agentConfig: {
				resolveModel: () => resolveModel('anthropic/claude-haiku-4-5'),
			},
			createDefaultEnv: async () => env,
		});

		const harness = await context.initializeRootHarness(
			defineAgent(() => ({
				model: 'anthropic/claude-haiku-4-5',
				instructions: 'You are the app.',
				promptFrame: 'none',
			})),
		);
		const session = await harness.session('workspace');

		expect(harness.name).toBe('default');
		expect(session).toBeDefined();
	});
});
