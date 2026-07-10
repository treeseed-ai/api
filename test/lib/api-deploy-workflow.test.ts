import { readdirSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

function workflow(path: string) {
	return parse(readFileSync(path, 'utf8')) as any;
}

function workflowFiles() {
	return readdirSync('.github/workflows')
		.filter((entry) => entry.endsWith('.yml') || entry.endsWith('.yaml'))
		.sort();
}

function packageJson() {
	return JSON.parse(readFileSync('package.json', 'utf8')) as any;
}

function pushBranches(spec: any) {
	const push = spec?.on?.push;
	if (!push) return [];
	if (push === true) return ['*'];
	if (Array.isArray(push?.branches)) return push.branches.map(String);
	if (typeof push?.branches === 'string') return [push.branches];
	return [];
}

describe('API deploy workflow', () => {
	it('keeps hosted workflows on packaged entrypoints and avoids duplicate staging push fan-out', () => {
		const files = workflowFiles();
		const workflowEntries = files.map((file) => ({
			file,
			source: readFileSync(`.github/workflows/${file}`, 'utf8'),
			parsed: workflow(`.github/workflows/${file}`),
		}));
		const stagingPushWorkflows = workflowEntries
			.filter((entry) => pushBranches(entry.parsed).some((branch) => branch === '*' || branch === 'staging'))
			.map((entry) => entry.file);

		expect(stagingPushWorkflows).toEqual([]);
		for (const entry of workflowEntries) {
			expect(entry.source).not.toMatch(/node_modules\/@treeseed\/[^/\s]+\/src\//u);
			expect(entry.source).not.toMatch(/@treeseed\/cli\/src\//u);
		}
	});

	it('keeps package verification local and redirects deployment to root-owned workflows', () => {
		const pkg = packageJson();
		const deploy = workflow('.github/workflows/deploy.yml');
		const releaseGate = workflow('.github/workflows/release-gate.yml');
		const verify = workflow('.github/workflows/verify.yml');
		const manifest = workflow('treeseed.package.yaml');
		expect(manifest.deploymentSource).toEqual({
			staging: 'git',
			prod: 'image',
		});
		expect(manifest.releaseGate).toEqual({
			workflow: 'verify.yml',
			timeoutSeconds: 1800,
		});
		expect(deploy.name).toBe('TreeSeed API Deployment Redirect');
		expect(deploy.on.push).toBeUndefined();
		expect(JSON.stringify(releaseGate.on)).not.toContain('push');
		expect(JSON.stringify(verify.on)).toContain('push');
		expect(pkg.devDependencies).not.toHaveProperty('@treeseed/cli');

		const deployRun = JSON.stringify(deploy.jobs.redirect);
		expect(deployRun).toContain('root Treeseed Staging Candidate workflow');
		expect(deployRun).toContain('root Treeseed Production Release workflow');
		expect(deployRun).toContain('npx trsd stage --json');
		expect(deployRun).toContain('npx trsd release --patch --json');
		expect(deployRun).not.toContain('npm ci');
		expect(deployRun).not.toContain('treeseed-install-deps-chunk');
		expect(deployRun).not.toContain('Install dependencies chunk');
	});
});
