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

		expect(stagingPushWorkflows).toEqual(['deploy.yml']);
		for (const entry of workflowEntries) {
			expect(entry.source).not.toMatch(/node_modules\/@treeseed\/[^/\s]+\/src\//u);
			expect(entry.source).not.toMatch(/@treeseed\/cli\/src\//u);
		}
	});

	it('verifies before source staging and image-backed production deployment', () => {
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
		expect(manifest.dockerImages.releaseWorkflow).toBe('deploy.yml');
		expect(manifest.requiredSecrets).toEqual(expect.arrayContaining([
			'TREESEED_TREEDX_ADMIN_TOKEN',
			'TREESEED_TREEDX_SECRET_KEY_BASE',
			'TREESEED_TREEDX_JWT_HS256_SECRET',
		]));
		expect(deploy.name).toBe('Deploy TreeSeed API');
		expect(deploy.on.workflow_dispatch).toBeNull();
		expect(deploy.on.push.branches).toEqual(['staging']);
		expect(deploy.on.push.tags).toEqual(['*.*.*']);
		expect(JSON.stringify(releaseGate.on)).not.toContain('push');
		expect(JSON.stringify(verify.on)).toContain('push');
		expect(pkg.devDependencies).not.toHaveProperty('@treeseed/cli');

		expect(deploy.jobs['deploy-staging'].needs).toBe('verify');
		expect(deploy.jobs['deploy-production'].needs).toEqual(['verify', 'publish-manifests']);
		const deploySource = readFileSync('.github/workflows/deploy.yml', 'utf8');
		expect(deploySource).toContain('git merge-base --is-ancestor "${GITHUB_SHA}" origin/main');
		expect(deploySource).toContain('target: api');
		expect(deploySource).toContain('target: operations-runner');
		expect(deploySource).toContain('TREESEED_API_IMAGE_REF: treeseed/api:${{ needs.verify.outputs.version }}');
		expect(deploySource).toContain('TREESEED_PUBLIC_TREEDX_IMAGE_REF: ${{ vars.TREESEED_PUBLIC_TREEDX_IMAGE_REF }}');
		expect(deploySource).toContain('test -n "${TREESEED_PUBLIC_TREEDX_IMAGE_REF}"');
		expect(deploySource).toContain('hosting verify --environment staging --app api --live --json');
		expect(deploySource).toContain('hosting verify --environment prod --app api --live --json');
		expect(deploySource).toContain('gh run download "${run_id}" --repo treeseed-ai/cli --name "cli-${TREESEED_CLI_SHA}"');
		expect(deploySource).toContain('refusing to wait for an impossible success');
		expect(deploySource).toContain('Timed out waiting for CLI verify.yml for exact SHA');
		expect(deploySource).not.toContain('--status success');
		expect(deploySource).not.toContain('guarantees run');
		expect(readFileSync('.github/workflows/release-gate.yml', 'utf8')).toContain("--owner-package '@treeseed/api,@treeseed/agent' --no-dependencies");
		expect(workflowFiles()).not.toContain('publish.yml');
	});
});
