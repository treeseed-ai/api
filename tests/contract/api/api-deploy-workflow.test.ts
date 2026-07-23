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

describe('API hosted deployment suspension', () => {
	it('has no staging push workflow that can mutate hosting', () => {
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

	it('retains verification and manual guarantees without a deployment workflow', () => {
		const pkg = packageJson();
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
		expect(manifest.dockerImages.releaseWorkflow).toBeUndefined();
		expect(manifest.requiredSecrets).toEqual(expect.arrayContaining([
			'TREESEED_TREEDX_ADMIN_TOKEN',
			'TREESEED_TREEDX_SECRET_KEY_BASE',
			'TREESEED_TREEDX_JWT_HS256_SECRET',
		]));
		expect(workflowFiles()).not.toContain('deploy.yml');
		expect(JSON.stringify(releaseGate.on)).not.toContain('push');
		expect(JSON.stringify(verify.on)).toContain('push');
		expect(pkg.devDependencies).not.toHaveProperty('@treeseed/cli');
		expect(readFileSync('.github/workflows/release-gate.yml', 'utf8')).toContain("--owner-package '@treeseed/api,@treeseed/agent' --no-dependencies");
		expect(workflowFiles()).not.toContain('publish.yml');
	});
});
