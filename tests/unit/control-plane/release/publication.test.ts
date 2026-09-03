import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

const hash = (marker: string) => `sha256:${marker.repeat(64)}`;
afterEach(() => rmSync('release-assets', { recursive: true, force: true }));

describe('managed API release publication', () => {
	it('accepts the exact package RC tag and rejects aliases or build metadata', () => {
		const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
		execFileSync(process.execPath, ['--import', 'tsx', 'scripts/packages/assert-release-tag-version.ts'], { env: { ...process.env, GITHUB_REF_NAME: version } });
		for (const tag of [`v${version}`, `${version}+rebuilt`]) {
			const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/packages/assert-release-tag-version.ts'], { env: { ...process.env, GITHUB_REF_NAME: tag } });
			expect(result.status).not.toBe(0);
		}
	});

	it('builds API, runner, and database staging candidates once and promotes without rebuilding', () => {
		const workflowSource = readFileSync('.github/workflows/publish.yml', 'utf8');
		const workflow = parse(workflowSource) as { on?: { push?: { branches?: string[]; tags?: string[] } }; jobs: Record<string, { needs?: string | string[]; strategy?: { matrix?: { include?: Array<{ image: string }> } }; steps?: Array<{ uses?: string; name?: string }> }> };
		expect(workflow.on?.push?.tags).toContain('!*-runtime.*');
		expect(workflow.on?.push?.branches).toContain('staging');
		const images = workflow.jobs['candidate-build']?.strategy?.matrix?.include?.map((entry) => entry.image) ?? [];
		expect(images.filter((image) => image === 'treeseed/api')).toHaveLength(2);
		expect(images.filter((image) => image === 'treeseed/op-runner')).toHaveLength(2);
		expect(images.filter((image) => image === 'treeseed/api-postgres')).toHaveLength(2);
		expect(workflow.jobs['candidate-seal']?.needs).toBe('candidate-build');
		expect(workflow.jobs.promote?.steps?.some(({ uses }) => uses?.includes('docker/build-push-action'))).toBe(false);
		expect(workflowSource).toContain('release-evidence-v1.json');
		expect(workflowSource).toContain('imagetools create -t');
		expect(workflowSource).toContain('sourcePackages');
		expect(workflowSource).toContain('install -m 0644 "${sourcePackages[0]}" release-assets/');
		expect(workflowSource).toContain('install -m 0644 release-assets/source-assets/sbom.cdx.json release-assets/');
	});

	it('materializes exact production images without a source build or host port', () => {
		execFileSync(process.execPath, ['--import', 'tsx', 'scripts/release/create-component-release.ts'], { env: { ...process.env, TREESEED_RELEASE: '0.8.0-rc.8', TREESEED_SOURCE_COMMIT: 'a'.repeat(40), TREESEED_API_DIGEST: hash('b'), TREESEED_RUNNER_DIGEST: hash('c'), TREESEED_DATABASE_DIGEST: hash('d') } });
		const compose = readFileSync('release-assets/compose.yml', 'utf8');
		const bundle = JSON.parse(readFileSync('release-assets/component-release.json', 'utf8')) as { release: string; revision: number; runtime: { compose: { files: Array<{ path: string; digest: string }> }; configuration: { environment: Array<{ name: string }>; secretEnvironment: Array<{ name: string }> } }; track: string; stableBase: { catalogDigest: unknown }; images: unknown[] };
		expect(compose).not.toMatch(/\bbuild\s*:/u);
		expect(compose).not.toMatch(/^\s+ports:/mu);
		expect(compose).toContain(`treeseed/api@${hash('b')}`);
		expect(compose).toContain(`treeseed/op-runner@${hash('c')}`);
		expect(compose).toContain(`treeseed/api-postgres@${hash('d')}`);
		expect(compose).toContain("fetch('http://127.0.0.1:3000/v1/health/ready')");
		expect(compose).toContain('test: ["CMD-SHELL", "kill -0 1"]');
		expect(compose).not.toContain('/healthz');
		expect(bundle.images).toHaveLength(3);
		expect(bundle.track).toBe('development');
		expect(bundle.stableBase.catalogDigest).toBeNull();
		expect(bundle.release).toBe('0.8.0~rc8-1');
		expect(bundle.revision).toBe(1);
		expect(bundle.runtime.compose.files).toEqual([{ path: 'compose.yml', digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) }]);
		expect(bundle.runtime.configuration.environment.map(({ name }) => name)).toEqual(expect.arrayContaining(['NODE_ENV', 'TREESEED_API_BASE_URL', 'TREESEED_LIBRARY_BRANCH', 'TREESEED_TREEDX_URL']));
		expect(bundle.runtime.configuration.secretEnvironment.map(({ name }) => name)).toEqual(expect.arrayContaining(['TREESEED_DATABASE_URL', 'TREESEED_GITHUB_TOKEN', 'TREESEED_R2_SECRET_ACCESS_KEY', 'TREESEED_TREEDX_DELEGATION_PRIVATE_KEY']));
	});

	it('keeps live source inside private managed networks with loopback-only ingress', () => {
		const compose = readFileSync('compose.development.yml', 'utf8');
		const cleanup = readFileSync('scripts/development/api-runtime.sh', 'utf8');
		const manifest = parse(readFileSync('treeseed.package.yaml', 'utf8')) as { development: { targets: Array<{ id: string; operations: { start?: { command: string; args: string[]; environment: Record<string, string> }; cleanup?: { command: string; args: string[] } }; secretRefs: Record<string, string> }> } };
		const service = manifest.development.targets.find((target) => target.id === 'service');
		expect(compose).toContain('127.0.0.1:3000:3000');
		expect(compose).toContain('working_dir: ${TREESEED_DEVELOPMENT_WORKTREE:');
		expect(compose).toContain('${TREESEED_DEVELOPMENT_WORKSPACE_ROOT:');
		expect(compose).toContain('name: treeseed-api_private');
		expect(compose).toContain('name: treeseed-edge');
		expect(compose).toContain('name: treeseed-platform');
		expect(compose).not.toMatch(/network_mode:\s*host/u);
		expect(compose).not.toMatch(/5432:5432/u);
		expect(service?.operations.start).toMatchObject({ command: 'docker', args: expect.arrayContaining(['compose', 'compose.development.yml', 'treeseed-api-development']) });
		expect(service?.operations.start?.environment).toEqual({ TREESEED_DEVELOPMENT_EDGE_HOST: 'api-live' });
		expect(service?.operations.cleanup).toMatchObject({ command: 'bash', args: ['scripts/development/api-runtime.sh', 'cleanup'] });
		expect(cleanup).toContain('TREESEED_DEVELOPMENT_CLEANUP_SCOPE:-runtime');
		expect(cleanup).toContain('down --remove-orphans');
		expect(cleanup).toContain('rm --force api-live');
		expect(service?.secretRefs).toMatchObject({ TREESEED_DATABASE_URL: 'api-database-url', SESSION_SECRET: 'api-session-secret' });
	});

	it('publishes Compose-only runtime revisions without rebuilding images', () => {
		const workflow = parse(readFileSync('.github/workflows/publish-runtime.yml', 'utf8')) as { on?: { workflow_dispatch?: unknown }; jobs: Record<string, { environment?: string; permissions?: Record<string, string> }> };
		expect(workflow.on?.workflow_dispatch).toBeDefined();
		expect(workflow.jobs.publish?.environment).toBe('staging');
		expect(workflow.jobs.publish?.permissions).toMatchObject({ contents: 'write', 'id-token': 'write', attestations: 'write' });
		execFileSync(process.execPath, ['--import', 'tsx', 'scripts/release/create-component-release.ts'], { env: { ...process.env, TREESEED_RELEASE: '0.8.0-rc.12', TREESEED_COMPONENT_REVISION: '2', TREESEED_SOURCE_COMMIT: 'e'.repeat(40), TREESEED_API_DIGEST: hash('b'), TREESEED_RUNNER_DIGEST: hash('c'), TREESEED_DATABASE_DIGEST: hash('d') } });
		const bundle = JSON.parse(readFileSync('release-assets/component-release.json', 'utf8')) as { applicationVersion: string; release: string; revision: number };
		expect(bundle).toMatchObject({ applicationVersion: '0.8.0-rc.12', release: '0.8.0~rc12-2', revision: 2 });
	});
});
