import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

const hash = (marker: string) => `sha256:${marker.repeat(64)}`;
afterEach(() => rmSync('release-assets', { recursive: true, force: true }));

describe('managed API release publication', () => {
	it('publishes API, runner, and database RC architecture manifests', () => {
		const workflow = parse(readFileSync('.github/workflows/publish.yml', 'utf8')) as { jobs: Record<string, { needs?: string | string[]; strategy?: { matrix?: { include?: Array<{ image: string }> } } }> };
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
		const bundle = JSON.parse(readFileSync('release-assets/component-release.json', 'utf8')) as { track: string; stableBase: { catalogDigest: unknown }; images: unknown[] };
		expect(compose).not.toMatch(/\bbuild\s*:/u);
		expect(compose).not.toMatch(/^\s+ports:/mu);
		expect(compose).toContain(`treeseed/api@${hash('b')}`);
		expect(compose).toContain(`treeseed/op-runner@${hash('c')}`);
		expect(compose).toContain(`treeseed/api-postgres@${hash('d')}`);
		expect(bundle.images).toHaveLength(3);
		expect(bundle.track).toBe('development');
		expect(bundle.stableBase.catalogDigest).toBeNull();
	});
});
