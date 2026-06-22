import { Box, render, Spacer, Text, useApp, useInput, usePaste, useWindowSize } from 'ink';
import TextInput from 'ink-text-input';
import { useMemo, useState, useSyncExternalStore } from 'react';
import type { ConsoleController } from './console-controller.ts';
import { boundedShutdown } from './console-shutdown.ts';
import { type TranscriptRecord, transcriptDisplayRecords } from './console-transcript.ts';

export function ConsoleUi({ controller }: { controller: ConsoleController }) {
	const { exit } = useApp();
	const { columns = 80, rows = 24 } = useWindowSize();
	const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
	const [draft, setDraft] = useState('');
	const [scrollOffset, setScrollOffset] = useState(0);
	const [closing, setClosing] = useState(false);
	const records = useMemo(() => transcriptDisplayRecords(snapshot.transcript), [snapshot.transcript]);
	const displayLines = useMemo(() => wrapTranscriptRecords(records, Math.max(1, columns - 6)), [columns, records]);
	const availableRows = Math.max(3, rows - (snapshot.resource?.kind === 'agent' ? 9 : 7));
	const viewport = transcriptViewport(displayLines, availableRows, scrollOffset);
	const maxOffset = viewport.maxOffset;
	const visible = viewport.lines;

	const close = (exitCode?: number) => {
		if (closing) return;
		if (exitCode !== undefined) process.exitCode = exitCode;
		setClosing(true);
		void boundedShutdown({
			close: () => controller.close(),
			forceCloseSync: () => controller.forceCloseSync(),
			exitCode: exitCode ?? 0,
			beforeTerminate: exit,
		}).then(
			() => exit(),
			() => setClosing(false),
		);
	};
	useInput((input, key) => {
		if (key.ctrl && input === 'c') {
			close(130);
			return;
		}
		if (key.escape) {
			close();
			return;
		}
		if (key.pageUp) setScrollOffset((value) => Math.min(maxOffset, value + availableRows));
		else if (key.pageDown) setScrollOffset((value) => Math.max(0, value - availableRows));
		else if (key.home) setScrollOffset(maxOffset);
		else if (key.end) setScrollOffset(0);
	});
	usePaste((text) => {
		if (!snapshot.composerEnabled || closing) return;
		setDraft((value) => `${value}${text.replace(/[\r\n]+/g, ' ')}`);
	});

	return (
		<Box flexDirection="column" height={rows} paddingX={1}>
			<Box>
				<Text bold color="blue">flue console</Text>
				<Spacer />
				<Text dimColor>PgUp/PgDn/Home/End scroll  Esc/Ctrl+C exit</Text>
			</Box>
			<Box flexDirection="column" marginTop={1}>
				<Text>{snapshot.resource ? `${snapshot.resource.kind} ${snapshot.resource.name}` : 'validating resource'}</Text>
				<Text dimColor>{snapshot.id ? `id ${snapshot.id}  ` : ''}{snapshot.target ? `target ${snapshot.target}  ` : ''}{snapshot.server ? `server ${snapshot.server}` : snapshot.remote ? 'remote server' : 'local server'}</Text>
				<Text color={snapshot.status === 'failed' ? 'red' : snapshot.status === 'completed' ? 'green' : undefined}>{snapshot.status}</Text>
			</Box>
			<Box flexDirection="column" flexGrow={1} marginTop={1} borderStyle="round" borderColor="gray" paddingX={1} overflowY="hidden">
				{visible.length === 0 ? <Text dimColor>Waiting for activity...</Text> : visible.map((record) => <TranscriptLine key={record.id} record={record} />)}
			</Box>
			{snapshot.resource?.kind === 'agent' ? (
				<Box marginTop={1} borderStyle="round" borderColor={snapshot.status === 'failed' ? 'red' : 'blue'} paddingX={1}>
					<Text color="blue">› </Text>
					{snapshot.composerEnabled && !closing ? (
						<TextInput
							value={draft}
							onChange={(value) => setDraft(value.replace(/[\r\n]+/g, ' '))}
							onSubmit={(value) => {
								const message = value.trim();
								if (!message) return;
								setDraft('');
								setScrollOffset(0);
								submitConsoleMessage(controller, message);
							}}
							placeholder={snapshot.active ? 'Prompt active' : 'Message agent'}
						/>
					) : <Text dimColor>{closing ? 'Closing' : snapshot.active ? 'Prompt active' : 'Starting'}</Text>}
				</Box>
			) : null}
		</Box>
	);
}

export function submitConsoleMessage(controller: ConsoleController, message: string): void {
	void controller.submit(message).catch(() => {});
}

export function transcriptViewport(
	lines: readonly TranscriptRecord[],
	availableRows: number,
	scrollOffset: number,
): { lines: readonly TranscriptRecord[]; maxOffset: number } {
	const maxOffset = Math.max(0, lines.length - availableRows);
	const offset = Math.min(Math.max(0, scrollOffset), maxOffset);
	const start = Math.max(0, lines.length - availableRows - offset);
	return { lines: lines.slice(start, start + availableRows), maxOffset };
}

export function wrapTranscriptRecords(
	records: readonly TranscriptRecord[],
	width: number,
): readonly TranscriptRecord[] {
	return records.flatMap((record) => {
		const characters = [...record.text];
		if (characters.length === 0) return [record];
		const lines: TranscriptRecord[] = [];
		for (let offset = 0; offset < characters.length; offset += width) {
			lines.push({ ...record, id: record.id * 1_000_000 + offset, text: characters.slice(offset, offset + width).join('') });
		}
		return lines;
	});
}

function TranscriptLine({ record }: { record: TranscriptRecord }) {
	return <Text dimColor={record.tone === 'dim'} color={record.tone === 'error' ? 'red' : record.tone === 'success' ? 'green' : record.tone === 'accent' ? 'blue' : undefined}>{record.text}</Text>;
}

export function openConsoleUi(controller: ConsoleController): { waitUntilExit(): Promise<void>; close(): void } {
	const instance = render(<ConsoleUi controller={controller} />, {
		stdin: process.stdin,
		stdout: process.stderr,
		stderr: process.stderr,
		alternateScreen: true,
		exitOnCtrlC: false,
		patchConsole: true,
	});
	return { waitUntilExit: async () => { await instance.waitUntilExit(); }, close: () => instance.unmount() };
}
