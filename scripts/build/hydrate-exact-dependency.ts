import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Exact package object required');
	return value as Record<string, unknown>;
}

function run(command: string, args: string[]): string {
	const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	if (result.error || result.signal || result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
	return result.stdout;
}

function archives(root: string, prefix: string): string[] {
	if (!existsSync(root)) return [];
	if (lstatSync(root).isSymbolicLink()) throw new Error('Exact archive cannot use a symlink');
	return readdirSync(root, { withFileTypes: true }).flatMap(item => {
		const path = join(root, item.name);
		if (item.isSymbolicLink()) throw new Error('Exact archive cannot use a symlink');
		return item.isDirectory() ? archives(path, prefix) : item.isFile() && item.name.startsWith(prefix) && item.name.endsWith('.tgz') ? [path] : [];
	}).sort();
}

async function hydrate(): Promise<void> {
	const [root, mode = 'install', name = '@treeseed/sdk', ...extra] = process.argv.slice(2);
	if (!root || extra.length || !['install', 'download'].includes(mode) || !['@treeseed/sdk', '@treeseed/treedx'].includes(name)) throw new Error('Exact dependency archive, mode and supported package required');
	const declared = object(object(JSON.parse(readFileSync('package.json', 'utf8'))).dependencies)[name];
	if (typeof declared !== 'string') throw new Error('Exact declared dependency required');
	const sha = name === '@treeseed/sdk' ? /#([a-f0-9]{40})$/u.exec(declared)?.[1] : undefined;
	const target = resolve('node_modules', name);
	if (name === '@treeseed/sdk' && !sha) {
		if (mode === 'install' && object(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))).version !== declared) throw new Error('Exact package identity disagrees with declared SDK');
		return;
	}
	if (mode === 'download' && name !== '@treeseed/sdk') throw new Error('Native TreeDX archive must come from its verified checkout');
	const prefix = name === '@treeseed/sdk' ? 'treeseed-sdk-' : 'treeseed-treedx-';
	let selected = archives(root, prefix);
	if (selected.length > 1) throw new Error('Multiple exact dependency archives found');
	if (!selected.length && mode === 'download') {
		const artifactName = `sdk-${sha}`;
		let runId: number | undefined;
		for (let attempt = 0; attempt < 120 && runId === undefined; attempt++) {
			const response = object(JSON.parse(run('gh', ['api', `repos/treeseed-ai/sdk/actions/artifacts?name=${artifactName}&per_page=100`])));
			if (!Array.isArray(response.artifacts)) throw new Error('Exact SDK Actions artifact inventory required');
			for (const value of response.artifacts) {
				const artifact = object(value), workflow = object(artifact.workflow_run);
				if (artifact.expired !== false || artifact.name !== artifactName || workflow.head_sha !== sha || typeof workflow.id !== 'number') continue;
				const state = object(JSON.parse(run('gh', ['run', 'view', String(workflow.id), '--repo', 'treeseed-ai/sdk', '--json', 'headSha,status,conclusion'])));
				if (state.headSha === sha && state.status === 'completed' && state.conclusion === 'success') { runId = workflow.id; break; }
			}
			if (runId === undefined) await new Promise<void>(done => setTimeout(done, 10_000));
		}
		if (runId === undefined) throw new Error('No successful exact SDK artifact found');
		run('gh', ['run', 'download', String(runId), '--repo', 'treeseed-ai/sdk', '--name', artifactName, '--dir', root]);
		selected = archives(root, prefix);
	}
	if (selected.length !== 1) throw new Error('One exact dependency archive required');
	const archive = selected[0]!;
	// Validate all supplied paths and entry types before extracting or replacing
	// any candidate. Archive authority is the existing checked source artifact.
	const held = readFileSync(archive);
	const paths = run('tar', ['-tzf', archive]).trimEnd().split('\n');
	if (new Set(paths).size !== paths.length || !paths.includes('package/package.json') || paths.some(path => !path.startsWith('package/') || /[\r\t]/u.test(path) || path.split('/').some(part => ['..', '.', 'node_modules'].includes(part)))) throw new Error('Unsafe exact package archive path');
	if (run('tar', ['-tvzf', archive]).trimEnd().split('\n').some(line => !['-', 'd'].includes(line[0] ?? ''))) throw new Error('Exact archive must contain only ordinary files and directories');
	if (!lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink()) throw new Error('Exact installed package directory required');
	const stage = mkdtempSync(join(dirname(target), '.exact-dependency-'));
	try {
		run('tar', ['-xzf', archive, '--strip-components=1', '-C', stage]);
		const manifest = object(JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8')));
		const expected = sha ? object(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))).version : declared;
		if (manifest.name !== name || manifest.version !== expected || !existsSync(join(stage, 'dist')) || !lstatSync(join(stage, 'dist')).isDirectory()) throw new Error('Exact package identity or built payload disagrees with candidate');
		if (!held.equals(readFileSync(archive))) throw new Error('Exact archive moved during validation');
		if (mode === 'download') return;
		// npm ci owns the locked transitive tree. Preserve it and replace only the
		// declared payload, after all pruning; never reinstall a registry substitute.
		for (const item of readdirSync(target)) if (item !== 'node_modules') rmSync(join(target, item), { recursive: true, force: true });
		for (const item of readdirSync(stage)) renameSync(join(stage, item), join(target, item));
		run('npm', ['ls', '--all', '--omit=dev']);
	} finally { rmSync(stage, { recursive: true, force: true }); }
}

await hydrate();
