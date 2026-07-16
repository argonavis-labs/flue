/**
 * Out-of-turn conversation signals appended by the embedding application.
 *
 * A signal is machine-originated context the model must see but the user never
 * typed — a compaction summary, or an application-authored note about something
 * that happened outside the conversation. flue records it canonically as a
 * `signal` record, and the next submission's model context renders it as a
 * synthetic user message (`<tagName type="...">content</tagName>`).
 *
 * The application needs to append one without owning a turn, so this exposes the
 * coordinator attached to the agent's Durable Object instance.
 */
import type { DeliveredMessage } from '../types.ts';
import type { CloudflareAgentCoordinator } from './agent-coordinator.ts';

/** An out-of-turn conversation signal appended by the embedding application. */
export type AgentConversationSignalInput = Extract<DeliveredMessage, { kind: 'signal' }>;

/**
 * Attached by `createCloudflareAgentRuntime` as each agent instance is bound, so
 * an application holding only the Durable Object instance can reach its
 * coordinator.
 */
export const cloudflareAgentCoordinators = new WeakMap<
	object,
	CloudflareAgentCoordinator
>();

/**
 * Append a canonical `signal` record to the agent instance's root conversation,
 * outside any turn. Pass the Durable Object instance the generated agent runtime
 * attached to.
 *
 * Creates the root conversation when none exists yet, mirroring the root session
 * path, so a signal may precede the very first submission. Throws while an
 * assistant turn is in progress — the canonical reducer only accepts linear,
 * out-of-turn appends.
 */
export async function appendAgentConversationSignal(
	instance: object,
	signal: AgentConversationSignalInput,
): Promise<void> {
	const coordinator = cloudflareAgentCoordinators.get(instance);
	if (!coordinator) {
		throw new Error('[flue] Cloudflare agent coordinator is not attached to this instance.');
	}
	return coordinator.appendConversationSignal(signal);
}
