import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleController, ConsoleSnapshot } from '../src/lib/console-controller.ts';
import { createConsoleTranscript, reduceConsoleTranscript } from '../src/lib/console-transcript.ts';
import {
	ConsoleUi,
	submitConsoleMessage,
	transcriptViewport,
	wrapTranscriptRecords,
} from '../src/lib/console-ui.tsx';

afterEach(cleanup);

function controller(snapshot: ConsoleSnapshot): ConsoleController {
	return {
		subscribe: () => () => {},
		getSnapshot: () => snapshot,
		start: vi.fn(async () => {}),
		submit: vi.fn(async () => {}),
		recordServerOutput: vi.fn(),
		setLifecycleStatus: vi.fn(),
		close: vi.fn(async () => {}),
		forceCloseSync: vi.fn(),
	};
}

describe('wrapTranscriptRecords()', () => {
	it('wraps records into terminal rows while retaining a later result', () => {
		const records = wrapTranscriptRecords([
			{ id: 1, text: 'a'.repeat(25), tone: 'normal' },
			{ id: 2, text: 'result done', tone: 'success' },
		], 10);

		expect(records.map((record) => record.text)).toEqual(['aaaaaaaaaa', 'aaaaaaaaaa', 'aaaaa', 'result don', 'e']);
		expect(transcriptViewport(records, 2, 0).lines.map((record) => record.text)).toEqual(['result don', 'e']);
		expect(transcriptViewport(records, 2, 3).lines.map((record) => record.text)).toEqual(['aaaaaaaaaa', 'aaaaaaaaaa']);
	});
});

describe('ConsoleUi', () => {
	it('shows agent identity, runtime state, transcript, and composer', () => {
		const transcript = reduceConsoleTranscript(createConsoleTranscript(), { type: 'status', message: 'server ready' });
		const value = controller({ resource: { kind: 'agent', name: 'support' }, id: 'instance-1', target: 'node', server: 'http://localhost:3000', remote: false, status: 'completed', active: false, composerEnabled: true, transcript });
		const view = render(<ConsoleUi controller={value} />);

		expect(view.lastFrame()).toContain('agent support');
		expect(view.lastFrame()).toContain('id instance-1');
		expect(view.lastFrame()).toContain('server ready');
		expect(view.lastFrame()).toContain('Message agent');
	});

	it('assigns the conventional exit code before Ctrl+C cleanup', async () => {
		const previous = process.exitCode;
		let release: (() => void) | undefined;
		const value = controller({ resource: { kind: 'agent', name: 'support' }, id: 'instance-1', target: 'node', server: 'http://localhost:3000', remote: false, status: 'active', active: true, composerEnabled: false, transcript: createConsoleTranscript() });
		value.close = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
		const view = render(<ConsoleUi controller={value} />);

		view.stdin.write('\u0003');
		await Promise.resolve();
		expect(process.exitCode).toBe(130);
		expect(value.close).toHaveBeenCalledOnce();
		release?.();
		process.exitCode = previous;
	});

	it('absorbs rapid duplicate submission rejections', async () => {
		const value = controller({ resource: { kind: 'agent', name: 'support' }, id: 'instance-1', target: 'node', server: 'http://localhost:3000', remote: false, status: 'ready', active: false, composerEnabled: true, transcript: createConsoleTranscript() });
		value.submit = vi.fn().mockRejectedValue(new Error('A prompt is already active.'));

		submitConsoleMessage(value, 'first');
		submitConsoleMessage(value, 'second');
		await Promise.resolve();

		expect(value.submit).toHaveBeenCalledTimes(2);
	});

	it('omits the composer for workflows', () => {
		const value = controller({ resource: { kind: 'workflow', name: 'deploy' }, id: 'run-1', target: 'cloudflare', server: 'https://example.com', remote: true, status: 'completed', active: false, composerEnabled: false, transcript: createConsoleTranscript() });
		const view = render(<ConsoleUi controller={value} />);

		expect(view.lastFrame()).toContain('workflow deploy');
		expect(view.lastFrame()).not.toContain('Message agent');
	});
});
