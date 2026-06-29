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
	expect(spec).toMatch(/^(github:treeseed-ai\/cli#|file:treeseed-release-tarballs\/treeseed-cli-.*\.tgz$)/u);
}

describe('API deploy workflow', () => {
	it('owns API reconciliation, live verification, runner smoke, and acceptance', () => {
		const pkg = packageJson();
		const deploy = workflow('.github/workflows/deploy.yml');
		expect(deploy.name).toBe('TreeSeed API Deploy');
		expect(deploy.jobs).toHaveProperty('verify');
		expect(deploy.jobs).not.toHaveProperty('build-staging-images');
		expect(deploy.jobs).toHaveProperty('deploy-api');
		expect(deploy.jobs).toHaveProperty('live-verify');
		expectTreeSeedCliDependency(pkg.devDependencies?.['@treeseed/cli']);

		const deployRun = JSON.stringify(deploy.jobs['deploy-api']);
		expect(deploy.jobs['deploy-api'].needs).not.toContain('build-staging-images');
		expect(deployRun).toContain('npm ci --workspaces=false');
		expect(deployRun).not.toContain('npm install --no-save @treeseed/cli');
		expect(deployRun).toContain('TREESEED_API_IMAGE_REF');
		expect(deployRun).toContain('TREESEED_OPERATIONS_RUNNER_IMAGE_REF');
		expect(deployRun).not.toContain('treeseed/api:staging');
		expect(deployRun).not.toContain('treeseed/op-runner:staging');
		expect(deployRun).toContain('trsd hosting plan');
		expect(deployRun).toContain('--environment');
		expect(deployRun).toContain('TREESEED_WORKFLOW_ENVIRONMENT');
		expect(deployRun).toContain('--app api --json');
		expect(deployRun).toContain('trsd hosting apply');
		expect(deployRun).toContain('--app api --execute --json');
		expect(deployRun).toContain('TREESEED_RAILWAY_API_TOKEN');
		expect(deployRun).toContain('TREESEED_CLOUDFLARE_API_TOKEN');
		expect(deployRun).toContain('TREESEED_CLOUDFLARE_ACCOUNT_ID');

		const liveRun = JSON.stringify(deploy.jobs['live-verify']);
		expect(liveRun).toContain('npm ci --workspaces=false');
		expect(liveRun).not.toContain('npm install --no-save @treeseed/cli');
		expect(liveRun).toContain('trsd hosting verify');
		expect(liveRun).toContain('--app api --live --json');
		expect(liveRun).toContain('trsd operations smoke');
		expect(liveRun).toContain('--service operationsRunner --json');
		expect(liveRun).toContain('tsx ./scripts/api-acceptance.ts');
		expect(liveRun).toContain('reports/api-acceptance.json');
		expect(liveRun).toContain('reports/api-acceptance.xml');
		expect(liveRun).toContain('TREESEED_CLOUDFLARE_API_TOKEN');
		expect(liveRun).toContain('TREESEED_CLOUDFLARE_ACCOUNT_ID');
	});
});
