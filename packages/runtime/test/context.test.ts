import { describe, expect, it } from 'vitest';
import { composeSystemPrompt, mergeSkillCatalog } from '../src/context.ts';

describe('composeSystemPrompt', () => {
	it('places agent instructions before discovered workspace context', () => {
		const prompt = composeSystemPrompt(
			'Workspace guidance.',
			{},
			{ cwd: '/workspace' },
			'Agent instructions.',
		);

		expect(prompt.indexOf('Agent instructions.')).toBeLessThan(prompt.indexOf('Workspace guidance.'));
		expect(prompt).toContain('Working directory: /workspace');
	});

	it('discloses skill catalog metadata without skill bodies', () => {
		const prompt = composeSystemPrompt('', {
			review: {
				name: 'review',
				description: 'Review work.',
				body: 'Hidden instructions.',
				source: { kind: 'local', path: '/skills/review/SKILL.md' },
			},
		});

		expect(prompt).toContain('## Available Skills');
		expect(prompt).toContain('**review** — Review work.');
		expect(prompt).not.toContain('Hidden instructions.');
	});

	it('rejects collisions between definition and discovered skills', () => {
		expect(() =>
			mergeSkillCatalog([{ name: 'review', description: 'Review work.' }], {
				review: { name: 'review', description: 'Workspace review.' },
			}),
		).toThrow('appears in both agent definition and workspace discovery');
	});

	it('treats prototype-looking skill names as ordinary catalog entries', () => {
		const skills = mergeSkillCatalog([{ name: 'toString', description: 'Definition skill.' }], {
			constructor: { name: 'constructor', description: 'Workspace skill.' },
		});

		expect(skills.toString).toMatchObject({ name: 'toString' });
		expect(skills.constructor).toMatchObject({ name: 'constructor' });
	});
});
