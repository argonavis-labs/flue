import type { IFileSystem } from 'just-bash';

export interface DefaultWorkspaceScope {
	agentName: string;
	instanceId: string;
	harnessName: string;
}

export interface DefaultWorkspaceStore {
	get(scope: DefaultWorkspaceScope): Promise<IFileSystem>;
}
