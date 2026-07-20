import { cloudflareAgentCoordinators } from './app-signals.ts';

/** Ensures the instance's stream and root conversation exist outside any turn,
 * so a pre-minted session's history read answers empty instead of
 * `stream_not_found`. Idempotent and mid-turn safe; runs no turn configuration. */
export async function ensureAgentConversation(instance: object): Promise<void> {
	const coordinator = cloudflareAgentCoordinators.get(instance);
	if (!coordinator) {
		throw new Error('[flue] Cloudflare agent coordinator is not attached to this instance.');
	}
	return coordinator.ensureConversation();
}
