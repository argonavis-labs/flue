import * as v from 'valibot';
import { InvalidRequestError } from '../errors.ts';
import type { DeliveredMessage } from '../types.ts';

export const MAX_IMAGE_DATA_LENGTH = 14 * 1024 * 1024;

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

const DirectAgentRequestSchema = v.variant('kind', [
	v.object({
		kind: v.literal('user'),
		body: v.string(),
		attachments: v.optional(v.array(DeliveredAttachmentSchema)),
		submissionId: v.optional(v.pipe(v.string(), v.nonEmpty())),
	}),
	v.object({
		kind: v.literal('signal'),
		type: v.pipe(v.string(), v.nonEmpty('Signal message "type" must not be empty.')),
		body: v.string(),
		attributes: v.optional(v.record(v.string(), v.string())),
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
		submissionId: v.optional(v.pipe(v.string(), v.nonEmpty())),
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
	if (!parsed.success) return { message: parseDeliveredMessage(value) };
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
