import type { SandboxFactory } from '../types.ts';
import { createLocalSessionEnv, type LocalSessionEnvOptions } from './local-env.ts';

export type LocalSandboxOptions = LocalSessionEnvOptions;

export function local(options: LocalSandboxOptions = {}): SandboxFactory {
	return {
		createSessionEnv: async ({ cwd }) =>
			createLocalSessionEnv({
				cwd: options.cwd ?? cwd,
				env: options.env,
			}),
	};
}
