import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { componentReleaseSchema, deploymentDigest } from '@treeseed/sdk/deployment';
import { parse, stringify } from 'yaml';
import { managedOpenBaoServices, managedOpenBaoClient, MANAGED_OPENBAO_IMAGE } from '@treeseed/deployment/security/custody';

const release = process.env.TREESEED_RELEASE, sourceCommit = process.env.TREESEED_SOURCE_COMMIT;
const apiDigest = process.env.TREESEED_API_DIGEST, runnerDigest = process.env.TREESEED_RUNNER_DIGEST, databaseDigest = process.env.TREESEED_DATABASE_DIGEST;
if (!release || !sourceCommit || !apiDigest || !runnerDigest || !databaseDigest) throw new Error('Release, exact source commit, and every multi-architecture image digest are required.');
const digest = /^sha256:[a-f0-9]{64}$/u;
if (!/^[a-f0-9]{40}$/u.test(sourceCommit) || ![apiDigest, runnerDigest, databaseDigest].every((value) => digest.test(value))) throw new Error('Source or image digest is malformed.');
const track = release.includes('-rc.') ? 'development' : 'stable', revision = Number(process.env.TREESEED_COMPONENT_REVISION ?? '1');
if (!Number.isInteger(revision) || revision < 1) throw new Error('Component revision must be a positive integer.');
const debianRelease = `${release.replace(/-rc\.(\d+)$/u, '~rc$1')}-${revision}`;
const definition = parse(readFileSync(resolve('deploy/compose.template.yml'), 'utf8').replaceAll('@API_IMAGE@', `treeseed/api@${apiDigest}`).replace('@RUNNER_IMAGE@', `treeseed/op-runner@${runnerDigest}`).replace('@DATABASE_IMAGE@', `treeseed/api-postgres@${databaseDigest}`));
Object.assign(definition.services, managedOpenBaoServices(`treeseed/api@${apiDigest}`));
for (const name of ['api','operations-runner']) {
  const service = definition.services[name];
  service.environment = {...service.environment,...managedOpenBaoClient.environment};
  service.volumes = [...(service.volumes ?? []),managedOpenBaoClient.volume];
  service.depends_on = {...service.depends_on,'openbao-initialize':{condition:'service_completed_successfully'}};
}
const compose = stringify(definition);
if (/\bbuild\s*:/u.test(compose) || /@[A-Z_]+@/u.test(compose)) throw new Error('Production Compose bundle is not fully materialized.');
const composeDigest = `sha256:${createHash('sha256').update(compose).digest('hex')}`;
const runtime = {
	schemaVersion: 'treeseed.package-runtime/v1' as const, componentId: 'api', version: debianRelease,
	compose: { projectName: 'treeseed-api', files: [{ path: 'compose.yml', digest: composeDigest }] },
	services: [
		{ id: 'openbao', composeService: 'openbao', endpoints: [] }, { id: 'openbao-initialize', composeService: 'openbao-initialize', endpoints: [] },
		{ id: 'database', composeService: 'database', endpoints: [] }, { id: 'migration', composeService: 'migration', endpoints: [] },
		{ id: 'api', composeService: 'api', endpoints: [{ id: 'http', protocol: 'http' as const, port: 3000, visibility: 'host' as const, defaultAlias: 'api.treeseed.localhost', aliasOverride: true, tls: 'edge' as const, authentication: 'application' as const, healthGate: { protocol: 'http' as const, path: '/v1/health/ready', timeoutSeconds: 120 } }] },
		{ id: 'operations-runner', composeService: 'operations-runner', endpoints: [] },
	],
	configuration: {
		environment: [
			'NODE_ENV', 'POSTGRES_DB', 'POSTGRES_USER', 'TREESEED_API_AUTH_APPROVAL_BASE_URL', 'TREESEED_API_BASE_URL',
			'TREESEED_API_BOOTSTRAP_ADMIN_ALLOWLIST', 'TREESEED_ENVIRONMENT', 'TREESEED_LIBRARY_BRANCH', 'TREESEED_LOCAL_DEV_MODE',
			'TREESEED_MAILPIT_SMTP_HOST', 'TREESEED_MAILPIT_SMTP_PORT', 'TREESEED_SITE_URL', 'TREESEED_TREEDX_JWT_AUDIENCE',
			'TREESEED_TREEDX_JWT_ISSUER', 'TREESEED_TREEDX_URL',
		].map((name) => ({ name, required: false, source: 'configuration' as const })),
		secretEnvironment: [
			'POSTGRES_PASSWORD', 'SESSION_SECRET', 'TREESEED_CLOUDFLARE_ACCOUNT_ID', 'TREESEED_CLOUDFLARE_API_TOKEN',
			'TREESEED_CONTENT_BUCKET_NAME', 'TREESEED_DATABASE_URL', 'TREESEED_GITHUB_TOKEN', 'TREESEED_R2_ACCESS_KEY_ID',
			'TREESEED_R2_SECRET_ACCESS_KEY', 'TREESEED_TREEDX_CREDENTIAL_BROKER_ASSERTION', 'TREESEED_TREEDX_DELEGATION_PRIVATE_KEY',
		].map((name) => ({ name, required: false })),
		secretFiles: [], files: [],
	},
	stateVolumes: ['postgres','operations-runner','openbao','openbao-custody','openbao-os'].map(id=>({id,volume:`/var/lib/treeseed/components/api/${id}`,backup:'required' as const})),
	migrations: [{ id: 'control-plane-postgres', order: 0, backupRequired: true }], requiredCapabilities: ['docker-compose'], dependencies: [],
};
const tagUrl = (repository: string) => `https://hub.docker.com/r/${repository}/tags?name=${encodeURIComponent(release)}`;
const bundle = componentReleaseSchema.parse({
	schemaVersion: 'treeseed.component-release/v1', componentId: 'api', release: debianRelease, applicationVersion: release, revision, track,
	source: { repository: 'treeseed-ai/api', commit: sourceCommit },
	stableBase: track === 'development' ? { releaseRange: '>=0.1.0 <0.2.0', compatibilityId: 'treeseed-linux-amd64-v1', catalogDigest: null } : null,
	packages: [{ name: 'treeseed-component-api', version: debianRelease, architecture: 'all', origin: 'TreeSeed Deployment', order: 20 }],
	images: [
		{ role: 'openbao', repository: MANAGED_OPENBAO_IMAGE.repository, digest: MANAGED_OPENBAO_IMAGE.digest, platforms: ['linux/amd64', 'linux/arm64'], consumers: ['api'] },
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
