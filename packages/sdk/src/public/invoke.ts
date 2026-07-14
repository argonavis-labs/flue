import type { HttpClient } from '../http.ts';

/** One image attachment on a `kind: 'user'` delivered message. */
export interface DeliveredAttachment {
	type: 'image';
	data: string;
	mimeType: string;
	/** Optional original filename, surfaced on the projected `file` part. */
	filename?: string;
}

/**
 * The message delivered into an agent's session — the same unified shape the
 * server accepts from `dispatch()`. `kind: 'user'` is a direct user chat turn;
 * `kind: 'signal'` is a structured event (webhooks, schedules, multi-user
 * surfaces the agent participates in).
 */
export type DeliveredMessage =
	| { kind: 'user'; body: string; attachments?: DeliveredAttachment[] }
	| {
			kind: 'signal';
			type: string;
			body: string;
			attributes?: Record<string, string>;
			tagName?: string;
	  };

/** Options for one direct-agent prompt. */
export interface AgentPromptOptions {
	message: DeliveredMessage;
	/**
	 * Client-supplied submission id. Supplying one makes the send idempotent:
	 * a retry that reuses the id resolves to the same submission rather than
	 * admitting a duplicate turn. Omit it and the server mints one.
	 */
	submissionId?: string;
	signal?: AbortSignal;
}

/** Result of admitting one agent prompt. All fields are server-provided. */
export interface AgentSendResult {
	/** Fully resolved DS-compatible stream URL for observing the agent instance's events. */
	streamUrl: string;
	/**
	 * Opaque DS stream offset captured at admission. Reading `streamUrl` from
	 * this offset yields exactly this prompt's events.
	 */
	offset: string;
	/** Correlates the admitted prompt with its attached agent events. */
	submissionId: string;
}

export async function sendAgent(
	http: HttpClient,
	name: string,
	id: string,
	options: AgentPromptOptions,
): Promise<AgentSendResult> {
	return http.json<AgentSendResult>({
		method: 'POST',
		path: `/agents/${encodeURIComponent(name)}/${encodeURIComponent(id)}`,
		body: {
			...options.message,
			...(options.submissionId === undefined ? {} : { submissionId: options.submissionId }),
		},
		signal: options.signal,
	});
}
