import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleController, ConsoleSnapshot } from '../src/lib/console-controller.ts';
import { createConsoleTranscript, reduceConsoleTranscript } from '../src/lib/console-transcript.ts';
import { ConsoleUi, submitConsoleMessage } from '../src/lib/console-ui.tsx';

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

describe('ConsoleUi', () => {
	it('renders user and agent messages inline with compact labels', () => {
		let transcript = createConsoleTranscript();
		transcript = reduceConsoleTranscript(transcript, { type: 'prompt', message: 'Hello' });
		transcript = reduceConsoleTranscript(transcript, {
			type: 'event',
			event: {
				v: 1,
				eventIndex: 1,
				timestamp: '2026-06-22T00:00:00.000Z',
				type: 'message_end',
				turnId: 'turn-1',
				message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] },
			},
		});
		const value = controller({ resource: { kind: 'agent', name: 'support' }, id: 'instance-1', target: 'node', server: 'http://localhost:3000', remote: false, status: 'completed', active: false, composerEnabled: true, transcript });
		const view = render(<ConsoleUi controller={value} />);
		const output = view.lastFrame() ?? '';

		expect(output).toMatch(/you\s+Hello/);
		expect(output).toMatch(/agent\s+Hi there/);
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

});
