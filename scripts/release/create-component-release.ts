import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { componentReleaseSchema, deploymentDigest } from '@treeseed/sdk/deployment';

const release = process.env.TREESEED_RELEASE, sourceCommit = process.env.TREESEED_SOURCE_COMMIT;
const apiDigest = process.env.TREESEED_API_DIGEST, runnerDigest = process.env.TREESEED_RUNNER_DIGEST, databaseDigest = process.env.TREESEED_DATABASE_DIGEST;
if (!release || !sourceCommit || !apiDigest || !runnerDigest || !databaseDigest) throw new Error('Release, exact source commit, and every multi-architecture image digest are required.');
const digest = /^sha256:[a-f0-9]{64}$/u;
if (!/^[a-f0-9]{40}$/u.test(sourceCommit) || ![apiDigest, runnerDigest, databaseDigest].every((value) => digest.test(value))) throw new Error('Source or image digest is malformed.');
const track = release.includes('-rc.') ? 'development' : 'stable', revision = Number(process.env.TREESEED_COMPONENT_REVISION ?? '1');
if (!Number.isInteger(revision) || revision < 1) throw new Error('Component revision must be a positive integer.');
const debianRelease = `${release.replace(/-rc\.(\d+)$/u, '~rc$1')}-${revision}`;
const compose = readFileSync(resolve('deploy/compose.template.yml'), 'utf8').replaceAll('@API_IMAGE@', `treeseed/api@${apiDigest}`).replace('@RUNNER_IMAGE@', `treeseed/op-runner@${runnerDigest}`).replace('@DATABASE_IMAGE@', `treeseed/api-postgres@${databaseDigest}`);
if (/\bbuild\s*:/u.test(compose) || /@[A-Z_]+@/u.test(compose)) throw new Error('Production Compose bundle is not fully materialized.');
const composeDigest = `sha256:${createHash('sha256').update(compose).digest('hex')}`;
const runtime = {
	schemaVersion: 'treeseed.package-runtime/v1' as const, componentId: 'api', version: debianRelease,
	compose: { projectName: 'treeseed-api', files: [{ path: 'compose.yml', digest: composeDigest }] },
	services: [
		{ id: 'database', composeService: 'database', endpoints: [] }, { id: 'migration', composeService: 'migration', endpoints: [] }, { id: 'diagnostics-backfill', composeService: 'diagnostics-backfill', endpoints: [] },
		{ id: 'api', composeService: 'api', endpoints: [{ id: 'http', protocol: 'http' as const, port: 3000, visibility: 'host' as const, defaultAlias: 'api.treeseed.localhost', aliasOverride: true, tls: 'edge' as const, authentication: 'application' as const, healthGate: { protocol: 'http' as const, path: '/v1/health/ready', timeoutSeconds: 120 } }] },
		{ id: 'operations-runner', composeService: 'operations-runner', endpoints: [] },
	],
	stateVolumes: [{ id: 'postgres', volume: '/var/lib/treeseed/components/api/postgres', backup: 'required' as const }, { id: 'operations-runner', volume: '/var/lib/treeseed/components/api/operations-runner', backup: 'required' as const }],
	migrations: [{ id: 'control-plane-postgres', order: 0, backupRequired: true }], requiredCapabilities: ['docker-compose'], dependencies: [],
};
const tagUrl = (repository: string) => `https://hub.docker.com/r/${repository}/tags?name=${encodeURIComponent(release)}`;
const bundle = componentReleaseSchema.parse({
	schemaVersion: 'treeseed.component-release/v1', componentId: 'api', release: debianRelease, applicationVersion: release, revision, track,
	source: { repository: 'treeseed-ai/api', commit: sourceCommit },
	stableBase: track === 'development' ? { releaseRange: '>=0.1.0 <0.2.0', compatibilityId: 'treeseed-linux-amd64-v1', catalogDigest: null } : null,
	packages: [{ name: 'treeseed-component-api', version: debianRelease, architecture: 'all', origin: 'TreeSeed Deployment', order: 20 }],
	images: [
		{ role: 'api', repository: 'treeseed/api', digest: apiDigest, platforms: ['linux/amd64', 'linux/arm64'], consumers: ['api'] },
		{ role: 'operations-runner', repository: 'treeseed/op-runner', digest: runnerDigest, platforms: ['linux/amd64', 'linux/arm64'], consumers: ['api'] },
		{ role: 'postgres', repository: 'treeseed/api-postgres', digest: databaseDigest, platforms: ['linux/amd64', 'linux/arm64'], consumers: ['api'] },
	],
	runtime, runtimeDigest: deploymentDigest(runtime), rollback: { compatible: true, requiresBackup: true },
	evidence: { provenance: [tagUrl('treeseed/api'), tagUrl('treeseed/op-runner'), tagUrl('treeseed/api-postgres')], sboms: [tagUrl('treeseed/api'), tagUrl('treeseed/op-runner'), tagUrl('treeseed/api-postgres')], vulnerabilities: [] },
});
const output = resolve('release-assets'); mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, 'compose.yml'), compose); writeFileSync(resolve(output, 'component-release.json'), `${JSON.stringify(bundle, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, release, sourceCommit, apiDigest, runnerDigest, databaseDigest, runtimeDigest: bundle.runtimeDigest }));
