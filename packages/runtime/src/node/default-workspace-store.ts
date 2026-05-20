import { InMemoryFs } from 'just-bash';
import type {
	DefaultWorkspaceScope,
	DefaultWorkspaceStore,
} from '../runtime/default-workspace-store.ts';

export class InMemoryDefaultWorkspaceStore implements DefaultWorkspaceStore {
	private workspaces = new Map<string, InMemoryFs>();

	async get(scope: DefaultWorkspaceScope): Promise<InMemoryFs> {
		const key = createWorkspaceKey(scope);
		let workspace = this.workspaces.get(key);
		if (!workspace) {
			workspace = new InMemoryFs();
			this.workspaces.set(key, workspace);
		}
		return workspace;
	}
}

function createWorkspaceKey(scope: DefaultWorkspaceScope): string {
	return JSON.stringify([scope.agentName, scope.instanceId, scope.harnessName]);
}
