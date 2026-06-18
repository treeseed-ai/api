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
		expect(deploy.jobs).toHaveProperty('deploy-api');
		expect(deploy.jobs).toHaveProperty('live-verify');
		expect(pkg.devDependencies?.['@treeseed/cli']).toMatch(/^github:treeseed-ai\/cli#/u);

		const deployRun = JSON.stringify(deploy.jobs['deploy-api']);
		expect(deployRun).toContain('npm ci --workspaces=false');
		expect(deployRun).not.toContain('npm install --no-save @treeseed/cli');
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
		expect(liveRun).toContain('node ./scripts/api-acceptance.mjs');
		expect(liveRun).toContain('reports/api-acceptance.json');
		expect(liveRun).toContain('reports/api-acceptance.xml');
		expect(liveRun).toContain('TREESEED_CLOUDFLARE_API_TOKEN');
		expect(liveRun).toContain('TREESEED_CLOUDFLARE_ACCOUNT_ID');
	});
});
