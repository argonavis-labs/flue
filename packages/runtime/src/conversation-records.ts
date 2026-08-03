import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';
import type { PromptUsage } from './types.ts';

interface ConversationRecordEnvelope {
	v: 1;
	id: string;
	type: string;
	conversationId: string;
	harness: string;
	session: string;
	timestamp: string;
	submissionId?: string;
	dispatchId?: string;
	operationId?: string;
	turnId?: string;
	attemptId?: string;
}

export interface AttachmentRef {
	id: string;
	mimeType: string;
	size: number;
	digest: string;
	/**
	 * Original filename, when the uploader provided one. Presentation metadata,
	 * not part of byte identity — excluded from attachment-store equality and not
	 * required by the attachment stores (it travels in the canonical record).
	 */
	filename?: string;
}

export type CanonicalUserContent =
	| { type: 'text'; text: string }
	| { type: 'attachment'; attachment: AttachmentRef };

export type CanonicalToolResultContent =
	| Extract<ToolResultMessage['content'][number], { type: 'text' }>
	| { type: 'attachment'; attachment: AttachmentRef };

interface ConversationCreatedRecordBase extends ConversationRecordEnvelope {
	type: 'conversation_created';
	affinityKey: string;
	createdAt: string;
}

export type ConversationCreatedRecord = ConversationCreatedRecordBase &
	(
		| {
				kind: 'root';
				parentConversationId?: never;
				taskId?: never;
				actionInvocationId?: never;
				agent?: never;
		  }
		| {
				kind: 'task';
				parentConversationId: string;
				taskId: string;
				actionInvocationId?: never;
				/**
				 * Subagent profile name this task ran, when a profile was selected.
				 * Absent for agent-less tasks. Presentation metadata for the task
				 * tree — never part of conversation identity.
				 */
				agent?: string;
		  }
		| {
				kind: 'action';
				parentConversationId: string;
				actionInvocationId: string;
				taskId?: never;
				agent?: never;
		  }
	);

interface UserMessageRecord extends ConversationRecordEnvelope {
	type: 'user_message';
	messageId: string;
	parentId: string | null;
	content: CanonicalUserContent[];
}

interface SignalRecord extends ConversationRecordEnvelope {
	type: 'signal';
	messageId: string;
	parentId: string | null;
	signalType: string;
	tagName?: string;
	content: string;
	attributes?: Record<string, string>;
}

type AssistantModelInfo = Omit<
	AssistantMessage,
	'role' | 'content' | 'stopReason' | 'errorMessage' | 'timestamp' | 'usage' | 'responseModel'
>;

export interface AssistantMessageStartedRecord extends ConversationRecordEnvelope {
	type: 'assistant_message_started';
	messageId: string;
	parentId: string | null;
	modelInfo: AssistantModelInfo;
}

interface AssistantTextStartedRecord extends ConversationRecordEnvelope {
	type: 'assistant_text_started';
	messageId: string;
	blockId: string;
	blockIndex: number;
}

interface AssistantTextDeltaRecord extends ConversationRecordEnvelope {
	type: 'assistant_text_delta';
	messageId: string;
	blockId: string;
	sequence: number;
	delta: string;
}

interface AssistantTextCompletedRecord extends ConversationRecordEnvelope {
	type: 'assistant_text_completed';
	messageId: string;
	blockId: string;
	deltaCount: number;
	/** Provider signature for the completed text block, captured at completion so
	 *  it round-trips back to the provider on the next turn. */
	textSignature?: string;
}

interface AssistantReasoningStartedRecord extends ConversationRecordEnvelope {
	type: 'assistant_reasoning_started';
	messageId: string;
	blockId: string;
	blockIndex: number;
}

interface AssistantReasoningDeltaRecord extends ConversationRecordEnvelope {
	type: 'assistant_reasoning_delta';
	messageId: string;
	blockId: string;
	sequence: number;
	delta: string;
}

interface AssistantReasoningCompletedRecord extends ConversationRecordEnvelope {
	type: 'assistant_reasoning_completed';
	messageId: string;
	blockId: string;
	deltaCount: number;
	encrypted?: string;
	redacted?: boolean;
}

interface AssistantToolCallRecord extends ConversationRecordEnvelope {
	type: 'assistant_tool_call';
	messageId: string;
	blockId: string;
	blockIndex: number;
	toolCallId: string;
	name: string;
	arguments: Record<string, unknown>;
	thoughtSignature?: string;
}

interface AssistantMessageCompletedRecord extends ConversationRecordEnvelope {
	type: 'assistant_message_completed';
	messageId: string;
	stopReason: AssistantMessage['stopReason'];
	usage: AssistantMessage['usage'];
	/** Provider-reported model that served a routed request, when available. */
	responseModel?: string;
	error?: string;
}

interface ToolOutcomeRecord extends ConversationRecordEnvelope {
	type: 'tool_outcome';
	assistantMessageId: string;
	toolCallId: string;
	toolName: string;
	isError: boolean;
	/**
	 * Model-facing result content (text/attachment blocks) sent back to the LLM.
	 */
	content: CanonicalToolResultContent[];
	/**
	 * Validated structured application output, when the tool declared one. Kept
	 * distinct from `content` so the UI can render the typed value instead of the
	 * serialized model-facing text. Absent for tools without structured output.
	 */
	output?: unknown;
	/**
	 * Tool-handler execution time in milliseconds, measured from execution start
	 * to end. Durably records the same duration otherwise only carried on the
	 * ephemeral `tool` event. Absent on records written before this field
	 * existed.
	 */
	durationMs?: number;
}

interface ToolResultsCommittedRecord extends ConversationRecordEnvelope {
	type: 'tool_results_committed';
	assistantMessageId: string;
	parentId: string;
	outcomeIds: string[];
}

export interface CompactionRecord extends ConversationRecordEnvelope {
	type: 'compaction';
	entryId: string;
	parentId: string | null;
	summary: string;
	firstKeptEntryId: string;
	sourceLeafId: string;
	tokensBefore: number;
	details?: { readFiles: string[]; modifiedFiles: string[] };
	usage?: PromptUsage;
}

interface CanonicalChildSessionRefBase {
	conversationId: string;
	harness: string;
	session: string;
}

export type CanonicalChildSessionRef =
	| (CanonicalChildSessionRefBase & {
			type: 'task';
			taskId: string;
			invocationId?: never;
			/**
			 * The parent `task` tool call that spawned this child, and the assistant
			 * entry holding it. Present when the task was invoked by the model as a
			 * tool call; absent for a programmatic `session.task()` (which has no
			 * parent tool call). Durable join key used by recovery to resolve the
			 * parent's tool call from the child — never inferred.
			 */
			parentToolCallId?: string;
			parentAssistantEntryId?: string;
	  })
	| (CanonicalChildSessionRefBase & {
			type: 'action';
			invocationId: string;
			taskId?: never;
			parentToolCallId?: never;
			parentAssistantEntryId?: never;
	  });

interface ChildSessionRetainedRecord extends ConversationRecordEnvelope {
	type: 'child_session_retained';
	child: CanonicalChildSessionRef;
}

export interface SubmissionSettledRecord extends ConversationRecordEnvelope {
	type: 'submission_settled';
	outcome: 'completed' | 'failed' | 'aborted';
	error?: unknown;
}

export type ConversationRecord =
	| ConversationCreatedRecord
	| UserMessageRecord
	| SignalRecord
	| AssistantMessageStartedRecord
	| AssistantTextStartedRecord
	| AssistantTextDeltaRecord
	| AssistantTextCompletedRecord
	| AssistantReasoningStartedRecord
	| AssistantReasoningDeltaRecord
	| AssistantReasoningCompletedRecord
	| AssistantToolCallRecord
	| AssistantMessageCompletedRecord
	| ToolOutcomeRecord
	| ToolResultsCommittedRecord
	| CompactionRecord
	| ChildSessionRetainedRecord
	| SubmissionSettledRecord;


export function generateConversationRecordId(): string {
	return `record_${crypto.randomUUID()}`;
}

export function generateConversationEntryId(): string {
	return `entry_${crypto.randomUUID()}`;
}
