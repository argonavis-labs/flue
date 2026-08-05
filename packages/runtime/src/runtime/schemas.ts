import * as v from 'valibot';
import { InvalidRequestError } from '../errors.ts';
import type { DeliveredMessage } from '../types.ts';

export const MAX_IMAGE_DATA_LENGTH = 14 * 1024 * 1024;

// Total across ALL of a single message's image attachments. `MAX_IMAGE_DATA_LENGTH`
// caps one image; this caps the sum, because a submission is persisted as chunks
// and reassembled WHOLE on every recovery wake (`hydratePersistedSubmissionAttachments`).
// That reassembly holds the rows plus the joined strings at once (~2× the total),
// so an unbounded sum lets one submission OOM the durable-object isolate on wake —
// a permanent OOM loop, not a one-time failure. 32 MiB keeps the peak well under a
// 128 MB isolate while still admitting a couple of full-size images.
export const MAX_SUBMISSION_IMAGE_DATA_LENGTH = 32 * 1024 * 1024;

/** Attachment shape for a `DeliveredMessage`'s `attachments`. */
const DeliveredAttachmentSchema = v.object({
	type: v.literal('image'),
	data: v.pipe(
		v.string(),
		v.maxLength(
			MAX_IMAGE_DATA_LENGTH,
			`Image data exceeds the ${MAX_IMAGE_DATA_LENGTH} character limit.`,
		),
	),
	mimeType: v.string(),
	filename: v.optional(v.string()),
});

const DeliveredUserMessageSchema = v.object({
	kind: v.literal('user'),
	body: v.string(),
	attachments: v.optional(v.array(DeliveredAttachmentSchema)),
});

const DeliveredSignalMessageSchema = v.object({
	kind: v.literal('signal'),
	type: v.pipe(v.string(), v.nonEmpty('Signal message "type" must not be empty.')),
	body: v.string(),
	attributes: v.optional(v.record(v.string(), v.string())),
	// The tag name is rendered unescaped as the signal's XML envelope in model
	// context, so it must be a valid XML name — anything looser would let a
	// caller-controlled value inject markup that the body/attribute escaping
	// exists to prevent.
	tagName: v.optional(
		v.pipe(
			v.string(),
			v.regex(
				/^[A-Za-z_][A-Za-z0-9_.-]*$/,
				'Signal message "tagName" must be a valid XML tag name ' +
					'(letters, digits, "_", "-", "."; must not start with a digit, "-", or ".").',
			),
		),
	),
});

/**
 * The single validated shape for a message delivered into an agent's
 * session, whether it arrives through `dispatch()` or a direct HTTP prompt
 * (whose wire body is this shape verbatim).
 */
export const DeliveredMessageSchema = v.variant('kind', [
	DeliveredUserMessageSchema,
	DeliveredSignalMessageSchema,
]);

const DirectSubmissionIdSchema = v.optional(v.pipe(v.string(), v.nonEmpty()));

const DirectAgentRequestSchema = v.variant('kind', [
	v.object({
		...DeliveredUserMessageSchema.entries,
		submissionId: DirectSubmissionIdSchema,
	}),
	v.object({
		...DeliveredSignalMessageSchema.entries,
		submissionId: DirectSubmissionIdSchema,
	}),
]);

/**
 * Validate a raw value as a {@link DeliveredMessage}. Shared by `dispatch()`
 * admission and the direct HTTP route so both transports produce the same
 * structured {@link InvalidRequestError} on bad input.
 */
export function parseDeliveredMessage(value: unknown): DeliveredMessage {
	const parsed = v.safeParse(DeliveredMessageSchema, value);
	if (parsed.success) return parsed.output;
	const specificIssue = parsed.issues.find(
		(issue) => issue.type === 'max_length' || issue.type === 'regex',
	);
	throw new InvalidRequestError({
		reason:
			specificIssue?.message ??
			'Delivered messages must be { kind: "user", body: string, attachments?: attachment[] } ' +
				'or { kind: "signal", type: string, body: string, attributes?: Record<string, string>, tagName?: string }.',
	});
}

/** Parse a direct HTTP admission and separate its transport id from the message. */
export function parseDirectAgentRequest(value: unknown): {
	readonly message: DeliveredMessage;
	readonly submissionId?: string;
} {
	const parsed = v.safeParse(DirectAgentRequestSchema, value);
	if (!parsed.success) {
		// Malformed message bodies take the shared parse's InvalidRequestError
		// (HTTP 400), exactly as before.
		const message = parseDeliveredMessage(value);
		// The message itself parsed, so the strict failure was the submissionId.
		// A body that names a submissionId must never fall through with the id
		// dropped: the server would mint a fresh id per retry, admitting the
		// duplicate turn the stable client-supplied id exists to prevent.
		if (typeof value === 'object' && value !== null && 'submissionId' in value) {
			throw new InvalidRequestError({
				reason: 'The "submissionId" field must be a non-empty string when present.',
			});
		}
		return { message };
	}
	const { submissionId, ...message } = parsed.output;
	return {
		message,
		...(submissionId === undefined ? {} : { submissionId }),
	};
}

export const WorkflowRouteParamSchema = v.object({ name: v.string() });
/** `?wait` query contract for the workflow invocation route. */
export const InvocationQuerySchema = v.object({
	wait: v.optional(v.literal('result')),
});
export const AgentRouteParamSchema = v.object({ name: v.string(), id: v.string() });
