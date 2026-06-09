import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

function workflow(path: string) {
	return parse(readFileSync(path, 'utf8')) as any;
}

describe('API deploy workflow', () => {
	it('owns API reconciliation, live verification, runner smoke, and acceptance', () => {
		const deploy = workflow('.github/workflows/deploy.yml');
		expect(deploy.name).toBe('TreeSeed API Deploy');
		expect(deploy.jobs).toHaveProperty('verify');
		expect(deploy.jobs).toHaveProperty('deploy-api');
		expect(deploy.jobs).toHaveProperty('live-verify');

		const deployRun = JSON.stringify(deploy.jobs['deploy-api']);
		expect(deployRun).toContain('trsd hosting plan');
		expect(deployRun).toContain('--environment');
		expect(deployRun).toContain('TREESEED_WORKFLOW_ENVIRONMENT');
		expect(deployRun).toContain('--app api --json');
		expect(deployRun).toContain('trsd hosting apply');
		expect(deployRun).toContain('--app api --execute --json');
		expect(deployRun).toContain('RAILWAY_API_TOKEN');
		expect(deployRun).not.toContain('CLOUDFLARE_API_TOKEN');

		const liveRun = JSON.stringify(deploy.jobs['live-verify']);
		expect(liveRun).toContain('trsd hosting verify');
		expect(liveRun).toContain('--app api --live --json');
		expect(liveRun).toContain('trsd operations smoke');
		expect(liveRun).toContain('--service operationsRunner --json');
		expect(liveRun).toContain('node ./scripts/api-acceptance.mjs');
		expect(liveRun).toContain('reports/api-acceptance.json');
		expect(liveRun).toContain('reports/api-acceptance.xml');
	});
});
