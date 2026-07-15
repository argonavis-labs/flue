#!/usr/bin/env node
/**
 * Publishes the four forked Flue packages to GitHub Packages under the
 * @argonavis-labs scope.
 *
 * Run after `pnpm install`, `build`, `test`, and `prepare-publish`.
 *
 * The script rewrites each package's `name` to `@argonavis-labs/flue-*`,
 * appends a fork prerelease suffix to the version, and rewrites internal
 * `workspace:*` references to npm aliases that keep the original `@flue/*`
 * import specifiers resolving inside consumers.
 */
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const registry = process.env.NPM_CONFIG_REGISTRY || 'https://npm.pkg.github.com';
const forkScope = '@argonavis-labs';
const forkPrefix = 'flue-';

const packages = [
	{ base: 'runtime', oldName: '@flue/runtime' },
	{ base: 'sdk', oldName: '@flue/sdk' },
	{ base: 'react', oldName: '@flue/react' },
	{ base: 'cli', oldName: '@flue/cli' },
];

const oldNameToBase = new Map(packages.map((p) => [p.oldName, p.base]));
const baseToNewName = new Map(packages.map((p) => [p.base, `${forkScope}/${forkPrefix}${p.base}`]));

async function gitShortSha() {
	const { stdout } = await execFileAsync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: repoRoot });
	return stdout.trim();
}

function forkVersion(baseVersion, sha) {
	// Strip any existing fork prerelease suffix so re-runs and manual bumps are
	// deterministic and do not accumulate `...-argonavis.sha-argonavis.sha`.
	const clean = baseVersion.replace(/-argonavis\.[a-f0-9]+$/i, '');
	return `${clean}-argonavis.${sha}`;
}

async function isPublished(name, version) {
	try {
		await execFileAsync('npm', ['view', `${name}@${version}`, 'version', '--registry', registry], {
			cwd: repoRoot,
			env: { ...process.env, npm_config_registry: registry },
		});
		return true;
	} catch {
		return false;
	}
}

async function publishPackage(pkg, sha) {
	const packageDir = join(repoRoot, 'packages', pkg.base);
	const manifestPath = join(packageDir, 'package.json');
	const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

	if (manifest.name !== pkg.oldName) {
		throw new Error(
			`Expected ${packageDir}/package.json name to be ${pkg.oldName}, got ${manifest.name}`,
		);
	}

	const newName = baseToNewName.get(pkg.base);
	const publishVersion = forkVersion(manifest.version, sha);

	// Rewrite internal dependency references. Keep the original @flue/* keys so
	// emitted dist files resolve inside consumers that install via npm aliases.
	for (const depType of ['dependencies', 'peerDependencies']) {
		const deps = manifest[depType];
		if (!deps) continue;
		for (const depName of Object.keys(deps)) {
			const depBase = oldNameToBase.get(depName);
			if (!depBase) continue;
			if (depType === 'peerDependencies') {
				// Preserve the original semver range; the fork prerelease version
				// (e.g. 1.0.0-beta.9-argonavis.abc1234) satisfies the existing
				// `>=1.0.0-beta.3 <1.0.0` range.
				continue;
			}
			const targetName = baseToNewName.get(depBase);
			deps[depName] = `npm:${targetName}@${publishVersion}`;
		}
	}

	// Dev dependencies are not installed for consumers and may carry
	// `workspace:*` references. Drop them to avoid leaking workspace state.
	delete manifest.devDependencies;

	manifest.name = newName;
	manifest.version = publishVersion;
	manifest.publishConfig = { registry, access: 'public' };
	manifest.repository = {
		type: 'git',
		url: 'git+https://github.com/argonavis-labs/flue.git',
		directory: `packages/${pkg.base}`,
	};

	await writeFile(manifestPath, `${JSON.stringify(manifest, null, '\t')}\n`);

	if (await isPublished(newName, publishVersion)) {
		console.error(`[publish-fork] ${newName}@${publishVersion} already published; skipping`);
		return;
	}

	console.error(`[publish-fork] Publishing ${newName}@${publishVersion} ...`);
	await execFileAsync('npm', ['publish', '--access', 'public', '--tag', 'latest'], {
		cwd: packageDir,
		env: { ...process.env, npm_config_registry: registry },
	});
	console.error(`[publish-fork] Published ${newName}@${publishVersion}`);
}

async function main() {
	const sha = await gitShortSha();
	console.error(`[publish-fork] Publishing fork build from ${sha}`);

	for (const pkg of packages) {
		// eslint-disable-next-line no-await-in-loop
		await publishPackage(pkg, sha);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
