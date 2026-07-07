import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

function workflow(path: string) {
	return parse(readFileSync(path, 'utf8')) as any;
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

describe('API deploy workflow', () => {
	it('owns API reconciliation, live verification, runner smoke, and acceptance', () => {
		const pkg = packageJson();
		const deploy = workflow('.github/workflows/deploy.yml');
		const manifest = workflow('treeseed.package.yaml');
		expect(manifest.deploymentSource).toEqual({
			staging: 'git',
			prod: 'image',
		});
		expect(deploy.name).toBe('TreeSeed API Deploy');
		expect(deploy.jobs).toHaveProperty('verify');
		expect(deploy.jobs).not.toHaveProperty('build-staging-images');
		expect(deploy.jobs).toHaveProperty('deploy-api');
		expect(deploy.jobs).toHaveProperty('live-verify');
		expectTreeSeedCliDependency(pkg.devDependencies?.['@treeseed/cli']);

		const deployRun = JSON.stringify(deploy.jobs['deploy-api']);
		expect(deploy.jobs['deploy-api'].needs).not.toContain('build-staging-images');
		expect(deployRun).toContain('npm ci --ignore-scripts --workspaces=false');
		expect(deployRun).toContain('dependency install failed; retrying');
		expect(deployRun).not.toContain('npm install --no-save @treeseed/cli');
		expect(deployRun).toContain('TREESEED_API_IMAGE_REF');
		expect(deployRun).toContain('TREESEED_OPERATIONS_RUNNER_IMAGE_REF');
		expect(deployRun).toContain("\"TREESEED_PUBLIC_TREEDX_IMAGE_REF\":\"${{ needs.classify.outputs.scope == 'prod'");
		expect(deployRun).toContain('Production API deploy requires TREESEED_PUBLIC_TREEDX_IMAGE_REF from the release graph.');
		expect(deployRun).not.toContain('registry.hub.docker.com/v2/repositories/treeseed/treedx/tags');
		expect(deployRun).not.toContain('Resolved TREESEED_PUBLIC_TREEDX_IMAGE_REF');
		expect(deployRun).not.toContain('treeseed/api:staging');
		expect(deployRun).not.toContain('treeseed/op-runner:staging');
		expect(deployRun).toContain('trsd hosting plan');
		expect(deployRun).toContain('--environment');
		expect(deployRun).toContain('TREESEED_WORKFLOW_ENVIRONMENT');
		expect(deployRun).toContain('--app api --json');
		expect(deployRun).toContain('trsd hosting apply');
		expect(deployRun).toContain('--app api --json');
		expect(deployRun).not.toContain('--app api --execute --json');
		expect(deployRun).toContain('TREESEED_RAILWAY_API_TOKEN');
		expect(deployRun).toContain('TREESEED_CLOUDFLARE_API_TOKEN');
		expect(deployRun).toContain('TREESEED_CLOUDFLARE_ACCOUNT_ID');
		expect(deployRun).toContain('TREESEED_WEB_SERVICE_ID');
		expect(deployRun).toContain('TREESEED_WEB_SERVICE_SECRET');

		const liveRun = JSON.stringify(deploy.jobs['live-verify']);
		expect(liveRun).toContain("\"TREESEED_PUBLIC_TREEDX_IMAGE_REF\":\"${{ needs.classify.outputs.scope == 'prod'");
		expect(liveRun).toContain('npm ci --ignore-scripts --workspaces=false');
		expect(liveRun).toContain('dependency install failed; retrying');
		expect(liveRun).not.toContain('npm install --no-save @treeseed/cli');
		expect(liveRun).toContain('trsd hosting verify');
		expect(liveRun).toContain('--app api --live --json');
		expect(liveRun).toContain('Resolve live API service credentials');
		expect(liveRun).toContain('@treeseed/sdk/workflow-support');
		expect(liveRun).toContain('resolveTreeseedMachineEnvironmentValues');
		expect(liveRun).toContain('...configured, ...process.env');
		expect(liveRun).not.toContain('variable list --service treeseed-api --json');
		expect(liveRun).toContain('trsd operations smoke');
		expect(liveRun).toContain('--service operationsRunner --json');
		expect(liveRun).toContain('tsx ./scripts/api-acceptance.ts');
		expect(liveRun).toContain('TREESEED_LIVE_API_BASE_URL');
		expect(liveRun).toContain('--base-url');
		expect(liveRun).toContain('${TREESEED_LIVE_API_BASE_URL}');
		expect(liveRun).not.toContain('${TREESEED_API_BASE_URL}');
		expect(liveRun).toContain('reports/api-acceptance.json');
		expect(liveRun).toContain('reports/api-acceptance.xml');
		expect(liveRun).toContain('TREESEED_CLOUDFLARE_API_TOKEN');
		expect(liveRun).toContain('TREESEED_CLOUDFLARE_ACCOUNT_ID');
		expect(liveRun).toContain('TREESEED_WEB_SERVICE_ID');
		expect(liveRun).toContain('TREESEED_WEB_SERVICE_SECRET');
		expect(liveRun).not.toContain('TREESEED_ACCEPTANCE_SERVICE_SECRET: ${{ secrets.');
		expect(liveRun).not.toContain('TREESEED_ACCEPTANCE_SERVICE_ID: ${{ vars.');
		expect(liveRun).toContain('TREESEED_ACCEPTANCE_SERVICE_SECRET<<');
		expect(liveRun).not.toContain('secrets.TREESEED_ACCEPTANCE_SERVICE_SECRET || secrets.TREESEED_API_WEB_SERVICE_SECRET');
		expect(liveRun).not.toContain('secrets.TREESEED_ACCEPTANCE_SERVICE_SECRET || secrets.TREESEED_WEB_SERVICE_SECRET');
		expect(liveRun).toContain('https://api.preview.treeseed.dev');
		expect(liveRun).toContain('https://api.treeseed.dev');
		expect(liveRun).not.toContain('api-treeseed-market-staging-ca844c56.treeseed.ai');
		expect(liveRun).not.toContain('https://api.treeseed.ai');
	});
});
