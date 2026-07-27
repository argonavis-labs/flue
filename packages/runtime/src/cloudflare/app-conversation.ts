import { resolveAttachedCoordinator } from './app-signals.ts';

/** Ensures the instance's stream and root conversation exist outside any turn,
 * so a pre-minted session's history read answers empty instead of
 * `stream_not_found`. Idempotent and mid-turn safe; runs no turn configuration. */
export async function ensureAgentConversation(instance: object): Promise<void> {
	return resolveAttachedCoordinator(instance).ensureConversation();
}
