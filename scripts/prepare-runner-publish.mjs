#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const [version, sha, mode] = process.argv.slice(2);

if (!/^1\.0\.0-beta\.9-runner\.[1-9]\d*$/.test(version ?? '')) {
	throw new Error('Expected version 1.0.0-beta.9-runner.N with N greater than zero.');
}
if (!/^[0-9a-f]{40}$/.test(sha ?? '')) {
	throw new Error('Expected a full lowercase Git commit SHA.');
}
if (mode !== undefined && mode !== '--finalize') {
	throw new Error(`Unknown mode ${mode}.`);
}

const packages = [
	['runtime', '@argonavis-labs/flue-runtime'],
	['sdk', '@argonavis-labs/flue-sdk'],
	['react', '@argonavis-labs/flue-react'],
	['cli', '@argonavis-labs/flue-cli'],
];

function finalizeAliases(manifest) {
	for (const section of [
		'dependencies',
		'devDependencies',
		'optionalDependencies',
		'peerDependencies',
	]) {
		for (const [alias, specifier] of Object.entries(manifest[section] ?? {})) {
			const match = /^workspace:(@argonavis-labs\/flue-(?:runtime|sdk|react|cli))@(?:\*|\^)$/.exec(
				specifier,
			);
			if (match) manifest[section][alias] = `npm:${match[1]}@${version}`;
		}
	}
}

for (const [directory, expectedName] of packages) {
	const path = join(repoRoot, 'packages', directory, 'package.json');
	const manifest = JSON.parse(await readFile(path, 'utf8'));
	if (manifest.name !== expectedName) {
		throw new Error(`Expected ${path} to name ${expectedName}, got ${manifest.name}.`);
	}
	manifest.version = version;
	manifest.flueForkSha = sha;
	if (mode === '--finalize') finalizeAliases(manifest);
	await writeFile(path, `${JSON.stringify(manifest, null, '\t')}\n`);
}

await writeFile(
	join(repoRoot, 'packages/runtime/src/fork.ts'),
	`/** Exact source commit embedded in an Argonavis Labs fork package. */\nexport const FLUE_FORK_SHA = '${sha}';\n`,
);

console.error(
	`[flue] Prepared ${version} from ${sha}${mode === '--finalize' ? ' for publish' : ''}`,
);
