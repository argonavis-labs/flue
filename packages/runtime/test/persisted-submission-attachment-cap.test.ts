import { describe, expect, it } from 'vitest';
import { SubmissionAttachmentsTooLargeError } from '../src/errors.ts';
import type { AgentSubmissionInput } from '../src/runtime/agent-submissions.ts';
import {
	assertImagesWithinLimit,
	extractSubmissionAttachments,
	MAX_IMAGE_DATA_LENGTH,
	MAX_SUBMISSION_IMAGE_DATA_LENGTH,
} from '../src/persisted-images.ts';
import type { PromptImage } from '../src/types.ts';

// One image just under the per-image cap; several sum past the per-message cap.
// A single shared string keeps the test's own memory small — only its `.length`
// drives the sum being checked.
const PER_IMAGE = 11 * 1024 * 1024;
const shared = 'a'.repeat(PER_IMAGE);
const image = (data: string): PromptImage => ({ type: 'image', data, mimeType: 'image/png' });

// 3 × 11 MiB = 33 MiB > 32 MiB cap, each image < the 14 MiB per-image cap.
const overTotal = [image(shared), image(shared), image(shared)];
// 2 × 11 MiB = 22 MiB < cap.
const underTotal = [image(shared), image(shared)];

function submission(attachments: PromptImage[]): AgentSubmissionInput {
	return {
		kind: 'direct',
		submissionId: 's1',
		agent: 'chat',
		id: 'sess_1',
		message: { kind: 'user', body: 'hi', attachments },
		acceptedAt: '2026-07-27T00:00:00.000Z',
	} as AgentSubmissionInput;
}

describe('per-message attachment total cap', () => {
	it('the total cap is above the per-image cap so a single max image is admissible', () => {
		expect(MAX_SUBMISSION_IMAGE_DATA_LENGTH).toBeGreaterThan(MAX_IMAGE_DATA_LENGTH);
	});

	it('assertImagesWithinLimit rejects a message whose images sum past the cap', () => {
		expect(() => assertImagesWithinLimit(overTotal)).toThrow(SubmissionAttachmentsTooLargeError);
	});

	it('assertImagesWithinLimit admits images that sum within the cap', () => {
		expect(() => assertImagesWithinLimit(underTotal)).not.toThrow();
	});

	it('extractSubmissionAttachments rejects an oversized total (the universal persist path)', () => {
		let thrown: unknown;
		try {
			extractSubmissionAttachments(submission(overTotal));
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(SubmissionAttachmentsTooLargeError);
		const error = thrown as SubmissionAttachmentsTooLargeError;
		expect(error.status).toBe(413);
		expect(error.meta).toMatchObject({ limitBytes: MAX_SUBMISSION_IMAGE_DATA_LENGTH });
	});

	it('extractSubmissionAttachments chunks a within-cap message', () => {
		const extracted = extractSubmissionAttachments(submission(underTotal));
		expect(extracted.chunks.length).toBeGreaterThan(0);
	});

	it('a non-user message is a no-op passthrough', () => {
		const input = {
			kind: 'direct',
			submissionId: 's2',
			agent: 'chat',
			id: 'sess_1',
			message: { kind: 'signal', body: 'note' },
			acceptedAt: '2026-07-27T00:00:00.000Z',
		} as AgentSubmissionInput;
		expect(extractSubmissionAttachments(input).chunks).toEqual([]);
	});
});
