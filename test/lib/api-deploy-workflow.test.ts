import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

function workflow(path: string) {
	return parse(readFileSync(path, 'utf8')) as any;
}

function packageJson() {
	return JSON.parse(readFileSync('package.json', 'utf8')) as any;
}

describe('API deploy workflow', () => {
	it('owns API reconciliation, live verification, runner smoke, and acceptance', () => {
		const pkg = packageJson();
		const deploy = workflow('.github/workflows/deploy.yml');
		expect(deploy.name).toBe('TreeSeed API Deploy');
		expect(deploy.jobs).toHaveProperty('verify');
		expect(deploy.jobs).toHaveProperty('build-staging-images');
		expect(deploy.jobs).toHaveProperty('deploy-api');
		expect(deploy.jobs).toHaveProperty('live-verify');
		expect(pkg.devDependencies?.['@treeseed/cli']).toMatch(/^github:treeseed-ai\/cli#/u);

		const imageBuild = JSON.stringify(deploy.jobs['build-staging-images']);
		expect(imageBuild).toContain('docker/setup-buildx-action');
		expect(imageBuild).toContain('docker/login-action');
		expect(imageBuild).toContain('tag=\\"staging-${GITHUB_SHA}\\"');
		expect(imageBuild).toContain('api_image_ref=treeseed/api:${tag}');
		expect(imageBuild).toContain('runner_image_ref=treeseed/op-runner:${tag}');
		expect(imageBuild).toContain('"target":"api"');
		expect(imageBuild).toContain('"target":"operations-runner"');
		expect(imageBuild).toContain('treeseed/api:staging');
		expect(imageBuild).toContain('treeseed/op-runner:staging');

		const deployRun = JSON.stringify(deploy.jobs['deploy-api']);
		expect(deploy.jobs['deploy-api'].needs).toContain('build-staging-images');
		expect(deployRun).toContain('npm ci --workspaces=false');
		expect(deployRun).not.toContain('npm install --no-save @treeseed/cli');
		expect(deployRun).toContain('TREESEED_API_IMAGE_REF');
		expect(deployRun).toContain('needs.build-staging-images.outputs.api_image_ref');
		expect(deployRun).toContain('TREESEED_OPERATIONS_RUNNER_IMAGE_REF');
		expect(deployRun).toContain('needs.build-staging-images.outputs.runner_image_ref');
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
