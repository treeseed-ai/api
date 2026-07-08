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

function expectTreeSeedCliDependency(spec: unknown) {
	expect(typeof spec).toBe('string');
	expect(spec).not.toContain('file:');
	expect(spec).not.toContain('workspace:');
	const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
	const stagingCommit = /^github:treeseed-ai\/cli#[0-9a-f]{40}$/u;
	expect(semver.test(spec as string) || stagingCommit.test(spec as string)).toBe(true);
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

	it('owns API reconciliation, live verification, runner smoke, and acceptance', () => {
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
			workflow: 'deploy.yml',
		});
		expect(deploy.name).toBe('TreeSeed API Deploy');
		expect(deploy.on.push.branches).toContain('staging');
		expect(JSON.stringify(releaseGate.on)).not.toContain('push');
		expect(JSON.stringify(verify.on)).not.toContain('push');
		expect(deploy.jobs).not.toHaveProperty('verify');
		expect(deploy.jobs).not.toHaveProperty('build-staging-images');
		expect(deploy.jobs).toHaveProperty('deploy-api');
		expect(deploy.jobs).not.toHaveProperty('live-verify');
		expectTreeSeedCliDependency(pkg.devDependencies?.['@treeseed/cli']);

		const deployRun = JSON.stringify(deploy.jobs['deploy-api']);
		expect(deploy.jobs['deploy-api'].needs).not.toContain('build-staging-images');
		expect(deploy.jobs['deploy-api'].needs).toBe('classify');
		expect(deployRun).toContain('npm ci --workspaces=false');
		expect(deployRun).toContain('dependency install failed; retrying');
		expect(deployRun).toContain('axllent/mailpit:v1.21');
		expect(deployRun).toContain('Wait for Mailpit');
		expect(deployRun).toContain('Verify API package');
		expect(deployRun).toContain('npm run verify:direct');
		expect(deployRun).not.toContain('npm ci --ignore-scripts --workspaces=false');
		expect(deployRun).not.toContain('npm rebuild @treeseed/sdk @treeseed/cli --workspaces=false');
		expect(deployRun).toContain('Resolve Treeseed CLI binary');
		expect(deployRun).toContain('node_modules/@treeseed/cli/package.json');
		expect(deployRun).toContain("bin.includes('/src/')");
		expect(deployRun).toContain('node \\"${cli_bin}\\" --help >/dev/null');
		expect(deployRun).toContain('node \\"${TREESEED_CLI_BIN}\\" secrets:unlock');
		expect(deployRun).not.toContain('./node_modules/.bin/trsd');
		expect(deployRun).not.toContain('@treeseed/cli/src/cli/main.ts');
		expect(deployRun).not.toContain('npm install --no-save @treeseed/cli');
		expect(deployRun).not.toContain('npx --no-install trsd');
		expect(deployRun).not.toContain('npx trsd');
		expect(deployRun).toContain('TREESEED_API_IMAGE_REF');
		expect(deployRun).toContain('TREESEED_OPERATIONS_RUNNER_IMAGE_REF');
		expect(deployRun).toContain("\"TREESEED_PUBLIC_TREEDX_IMAGE_REF\":\"${{ needs.classify.outputs.scope == 'prod'");
		expect(deployRun).toContain('Production API deploy requires TREESEED_PUBLIC_TREEDX_IMAGE_REF from the release graph.');
		expect(deployRun).not.toContain('registry.hub.docker.com/v2/repositories/treeseed/treedx/tags');
		expect(deployRun).not.toContain('Resolved TREESEED_PUBLIC_TREEDX_IMAGE_REF');
		expect(deployRun).not.toContain('treeseed/api:staging');
		expect(deployRun).not.toContain('treeseed/op-runner:staging');
		expect(deployRun).toContain('node \\"${TREESEED_CLI_BIN}\\" hosting plan');
		expect(deployRun).toContain('--environment');
		expect(deployRun).toContain('TREESEED_WORKFLOW_ENVIRONMENT');
		expect(deployRun).toContain('--app api --json');
		expect(deployRun).toContain('node \\"${TREESEED_CLI_BIN}\\" hosting apply');
		expect(deployRun).toContain('--app api --json');
		expect(deployRun).not.toContain('--app api --execute --json');
		expect(deployRun).toContain('TREESEED_RAILWAY_API_TOKEN');
		expect(deployRun).toContain('TREESEED_CLOUDFLARE_API_TOKEN');
		expect(deployRun).toContain('TREESEED_CLOUDFLARE_ACCOUNT_ID');
		expect(deployRun).toContain('TREESEED_WEB_SERVICE_ID');
		expect(deployRun).toContain('TREESEED_WEB_SERVICE_SECRET');

		expect(deployRun).toContain("needs.classify.outputs.workflow_action == 'verify_live'");
		expect(deployRun).toContain("needs.classify.outputs.workflow_action == 'acceptance'");
		expect(deployRun).toContain('node \\"${TREESEED_CLI_BIN}\\" hosting verify');
		expect(deployRun).toContain('--app api --live --json');
		expect(deployRun).toContain('Resolve live API service credentials');
		expect(deployRun).toContain('@treeseed/sdk/workflow-support');
		expect(deployRun).toContain('resolveTreeseedMachineEnvironmentValues');
		expect(deployRun).toContain('...configured, ...process.env');
		expect(deployRun).not.toContain('variable list --service treeseed-api --json');
		expect(deployRun).toContain('node \\"${TREESEED_CLI_BIN}\\" operations smoke');
		expect(deployRun).toContain('--service operationsRunner --json');
		expect(deployRun).toContain('tsx ./scripts/api-acceptance.ts');
		expect(deployRun).toContain('TREESEED_LIVE_API_BASE_URL');
		expect(deployRun).toContain('--base-url');
		expect(deployRun).toContain('${TREESEED_LIVE_API_BASE_URL}');
		expect(deployRun).not.toContain('${TREESEED_API_BASE_URL}');
		expect(deployRun).toContain('reports/api-acceptance.json');
		expect(deployRun).toContain('reports/api-acceptance.xml');
		expect(deployRun).not.toContain('TREESEED_ACCEPTANCE_SERVICE_SECRET: ${{ secrets.');
		expect(deployRun).not.toContain('TREESEED_ACCEPTANCE_SERVICE_ID: ${{ vars.');
		expect(deployRun).toContain('TREESEED_ACCEPTANCE_SERVICE_SECRET<<');
		expect(deployRun).not.toContain('secrets.TREESEED_ACCEPTANCE_SERVICE_SECRET || secrets.TREESEED_API_WEB_SERVICE_SECRET');
		expect(deployRun).not.toContain('secrets.TREESEED_ACCEPTANCE_SERVICE_SECRET || secrets.TREESEED_WEB_SERVICE_SECRET');
		expect(deployRun).toContain('https://api.preview.treeseed.dev');
		expect(deployRun).toContain('https://api.treeseed.dev');
		expect(deployRun).not.toContain('api-treeseed-market-staging-ca844c56.treeseed.ai');
		expect(deployRun).not.toContain('https://api.treeseed.ai');
	});
});
