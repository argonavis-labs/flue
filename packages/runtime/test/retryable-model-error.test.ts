import type { AssistantMessage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { isRetryableModelError } from '../src/submission-state.ts';

function assistantError(
	errorMessage: string,
	stopReason: AssistantMessage['stopReason'] = 'error',
): AssistantMessage {
	return {
		role: 'assistant',
		content: [{ type: 'text', text: 'partial output' }],
		api: 'test' as any,
		provider: 'test',
		model: 'test-model',
		usage: {
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

describe('isRetryableModelError()', () => {
	it('treats a bare "Provider finish_reason: error" as retryable', () => {
		expect(isRetryableModelError(assistantError('Provider finish_reason: error'))).toBe(true);
	});

	it('treats punctuation or a parenthetical after the bare reason as retryable', () => {
		expect(isRetryableModelError(assistantError('Provider finish_reason: error.'))).toBe(true);
		expect(
			isRetryableModelError(assistantError('Provider finish_reason: error (upstream died)')),
		).toBe(true);
	});

	it('matches the bare reason case-insensitively', () => {
		expect(isRetryableModelError(assistantError('PROVIDER FINISH_REASON: ERROR'))).toBe(true);
	});

	it('keeps qualified finish reasons terminal', () => {
		expect(isRetryableModelError(assistantError('Provider finish_reason: error_quota'))).toBe(
			false,
		);
		expect(
			isRetryableModelError(assistantError('Provider finish_reason: error-content-filter')),
		).toBe(false);
		expect(isRetryableModelError(assistantError('Provider finish_reason: errored'))).toBe(false);
	});

	it('never retries a message whose stopReason is not error', () => {
		expect(
			isRetryableModelError(assistantError('Provider finish_reason: error', 'stop')),
		).toBe(false);
	});
});
