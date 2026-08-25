import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

const hash = (marker: string) => `sha256:${marker.repeat(64)}`;
afterEach(() => rmSync('release-assets', { recursive: true, force: true }));

describe('managed API release publication', () => {
	it('accepts the exact package RC tag and rejects aliases or build metadata', () => {
		execFileSync(process.execPath, ['--import', 'tsx', 'scripts/packages/assert-release-tag-version.ts'], { env: { ...process.env, GITHUB_REF_NAME: '0.8.0-rc.12' } });
		for (const tag of ['v0.8.0-rc.12', '0.8.0-rc.12+rebuilt']) {
			const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/packages/assert-release-tag-version.ts'], { env: { ...process.env, GITHUB_REF_NAME: tag } });
			expect(result.status).not.toBe(0);
		}
	});

	it('publishes API, runner, and database RC architecture manifests', () => {
		const workflow = parse(readFileSync('.github/workflows/publish.yml', 'utf8')) as { on?: { push?: { tags?: string[] } }; jobs: Record<string, { needs?: string | string[]; strategy?: { matrix?: { include?: Array<{ image: string }> } } }> };
		expect(workflow.on?.push?.tags).toContain('!*-runtime.*');
		const images = workflow.jobs.build?.strategy?.matrix?.include?.map((entry) => entry.image) ?? [];
		expect(images.filter((image) => image === 'treeseed/api')).toHaveLength(2);
		expect(images.filter((image) => image === 'treeseed/op-runner')).toHaveLength(2);
		expect(images.filter((image) => image === 'treeseed/api-postgres')).toHaveLength(2);
		expect(workflow.jobs['component-release']?.needs).toBe('manifest');
		expect(workflow.jobs.prerelease?.needs).toEqual(['verify', 'manifest', 'component-release']);
	});

	it('materializes exact production images without a source build or host port', () => {
		execFileSync(process.execPath, ['--import', 'tsx', 'scripts/release/create-component-release.ts'], { env: { ...process.env, TREESEED_RELEASE: '0.8.0-rc.8', TREESEED_SOURCE_COMMIT: 'a'.repeat(40), TREESEED_API_DIGEST: hash('b'), TREESEED_RUNNER_DIGEST: hash('c'), TREESEED_DATABASE_DIGEST: hash('d') } });
		const compose = readFileSync('release-assets/compose.yml', 'utf8');
		const bundle = JSON.parse(readFileSync('release-assets/component-release.json', 'utf8')) as { release: string; revision: number; runtime: { compose: { files: Array<{ path: string; digest: string }> } }; track: string; stableBase: { catalogDigest: unknown }; images: unknown[] };
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
	});

	it('publishes Compose-only runtime revisions without rebuilding images', () => {
		const workflow = parse(readFileSync('.github/workflows/publish-runtime.yml', 'utf8')) as { on?: { workflow_dispatch?: unknown }; jobs: Record<string, { environment?: string; permissions?: Record<string, string> }> };
		expect(workflow.on?.workflow_dispatch).toBeDefined();
		expect(workflow.jobs.publish?.environment).toBe('development');
		expect(workflow.jobs.publish?.permissions).toMatchObject({ contents: 'write', 'id-token': 'write', attestations: 'write' });
		execFileSync(process.execPath, ['--import', 'tsx', 'scripts/release/create-component-release.ts'], { env: { ...process.env, TREESEED_RELEASE: '0.8.0-rc.12', TREESEED_COMPONENT_REVISION: '2', TREESEED_SOURCE_COMMIT: 'e'.repeat(40), TREESEED_API_DIGEST: hash('b'), TREESEED_RUNNER_DIGEST: hash('c'), TREESEED_DATABASE_DIGEST: hash('d') } });
		const bundle = JSON.parse(readFileSync('release-assets/component-release.json', 'utf8')) as { applicationVersion: string; release: string; revision: number };
		expect(bundle).toMatchObject({ applicationVersion: '0.8.0-rc.12', release: '0.8.0~rc12-2', revision: 2 });
	});
});
