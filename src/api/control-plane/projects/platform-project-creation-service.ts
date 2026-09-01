import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { extract } from 'tar-stream';
import { applyPlatformProjectCreate, planPlatformProjectCreate, projectCreatePlanSchema, type ProjectCreateAuthority, type ProjectCreateObservation, type ProjectCreatePlan, type ProjectCreateTarget } from '@treeseed/sdk/platform';
import { ensureProjectKnowledgeBinding } from '../../../control-plane/seeds/apply-support/projects/projects-core/project-knowledge-binding.ts';
import { reconcileLibraryProvider } from '../../../control-plane/seeds/apply-support/projects/projects-core/library-provider-reconciliation.ts';

type Row = Record<string, any>;
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const sha256 = (value: Buffer | string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const libraryName = (target: ProjectCreateTarget) => `${target.repository.name}-library`;
const repositoryUrl = (owner: string, name: string) => `https://github.com/${owner}/${name}.git`;

async function github(fetchImpl: typeof fetch, token: string | undefined, path: string, init: RequestInit = {}) {
	const response = await fetchImpl(`https://api.github.com${path}`, { ...init, headers: {
		accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}),
		...(init.body ? { 'content-type': 'application/json' } : {}), 'user-agent': 'treeseed-platform-project-creator',
		'x-github-api-version': '2022-11-28', ...(init.headers ?? {}),
	} });
	if (response.status === 404) return null;
	if (!response.ok) throw Object.assign(new Error(`GitHub project reconciliation failed (HTTP ${response.status}).`), { status: response.status });
	return response.status === 204 ? {} : response.json() as Promise<Row>;
}

async function templateFiles(buffer: Buffer, slug: string) {
	if (buffer.byteLength > 8 * 1024 * 1024) throw new Error('The compressed project template exceeds the 8 MiB safety limit.');
	const archive = gunzipSync(buffer, { maxOutputLength: 64 * 1024 * 1024 });
	const unpack = extract();
	const files = new Map<string, Buffer>();
	const complete = new Promise<void>((resolve, reject) => { unpack.on('finish', resolve); unpack.on('error', reject); });
	unpack.on('entry', (header, stream, next) => {
		const path = header.name.replace(/^template\//u, '');
		const safe = path && !path.startsWith('/') && !path.split('/').some((part) => !part || part === '.' || part === '..');
		if (header.type !== 'file' || !safe || files.size >= 2_000) { stream.resume(); stream.once('end', () => header.type === 'directory' && safe ? next() : unpack.destroy(new Error('The project template contains an unsafe entry.'))); return; }
		const chunks: Buffer[] = []; let size = 0;
		stream.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 4 * 1024 * 1024) unpack.destroy(new Error(`Template file ${path} exceeds 4 MiB.`)); else chunks.push(chunk); });
		stream.once('end', () => { const source = Buffer.concat(chunks); const name = slug.split('-').map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join(' ');
			files.set(path, source.includes(0) ? source : Buffer.from(source.toString('utf8').replaceAll('__SITE_SLUG__', slug).replaceAll('__SITE_NAME__', name))); next(); });
	});
	unpack.end(archive); await complete;
	if (!files.size) throw new Error('The project template contains no files.');
	return files;
}

export function createPlatformProjectCreationService(store: any, options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {}) {
	const env = options.env ?? process.env; const fetchImpl = options.fetchImpl ?? fetch;
	const token = () => text(env.TREESEED_GITHUB_TOKEN) || undefined;
	const resolveTarget = async (input: Partial<ProjectCreateTarget>): Promise<ProjectCreateTarget> => {
		const team = text(input.team); const slug = text(input.slug); const requested = record(input.repository); const template = record(input.template);
		const teamRecord = team ? await store.getTeam?.(team) : null; const teamMetadata = record(teamRecord?.metadata);
		let owner = text(requested.owner) || text(env.TREESEED_GITHUB_OWNER) || text(teamMetadata.githubOwner) || text(teamMetadata.repositoryOwner);
		if (!owner && team) owner = text((await store.first?.(`SELECT owner FROM project_remote_repository_bindings WHERE team_id=? AND owner IS NOT NULL AND owner<>'' ORDER BY updated_at DESC LIMIT 1`, [team]))?.owner);
		if (!team || !slug || !owner) throw new Error('Project creation requires an active team, a portable slug, and a configured GitHub repository owner.');
		return { team, slug, template: { id: text(template.id), version: text(template.version), digest: text(template.digest) },
			repository: { owner, name: text(requested.name) || slug, visibility: requested.visibility === 'public' ? 'public' : 'private' } };
	};
	const project = async (target: ProjectCreateTarget) => store.getProjectByTeamAndSlug(target.team, target.slug);
	const remote = (target: ProjectCreateTarget) => github(fetchImpl, token(), `/repos/${encodeURIComponent(target.repository.owner)}/${encodeURIComponent(target.repository.name)}`);
	const metadata = (value: unknown) => record(record(value).platformCreation);

	const authority: ProjectCreateAuthority = {
		async observe(target): Promise<ProjectCreateObservation> {
			const [current, repository] = await Promise.all([project(target), remote(target)]); const projectMetadata = metadata(current?.metadata);
			const repositories = current ? await store.listHubRepositories(current.id) : []; const primary = repositories.find((item: Row) => item.role === 'primary');
			const repositoryIdentity = repository && String(repository.owner?.login ?? '').toLowerCase() === target.repository.owner.toLowerCase() && repository.name === target.repository.name;
			const visibility = repository?.private === true ? 'private' : 'public'; const repositoryExact = repositoryIdentity && visibility === target.repository.visibility;
			const repositoryManaged = primary?.owner === target.repository.owner && primary?.name === target.repository.name;
			const library = current ? await store.getProjectTreeDxLibrary(current.id) : null; const desiredLibraryUrl = repositoryUrl(target.repository.owner, libraryName(target));
			const libraryExact = library?.contentRepositoryUrl === desiredLibraryUrl;
			const inventoryVersion = Number(projectMetadata.inventoryVersion ?? 0); const inventoryExact = repositories.some((item: Row) => item.role === 'primary' && item.url === repositoryUrl(target.repository.owner, target.repository.name))
				&& repositories.some((item: Row) => item.role === 'library' && item.url === desiredLibraryUrl) && inventoryVersion > 0;
			return {
				project: current ? { state: 'ready', id: String(current.id) } : { state: 'missing' },
				repository: !repository ? { state: 'missing' } : !repositoryExact || (!repositoryManaged && Number(repository.size ?? 0) > 0) ? { state: 'conflict' } : { state: repositoryManaged ? 'ready' : 'missing', url: String(repository.html_url ?? repositoryUrl(target.repository.owner, target.repository.name)) },
				template: projectMetadata.templateDigest === target.template.digest ? { state: 'ready', digest: target.template.digest }
					: projectMetadata.templateDigest ? { state: 'conflict', digest: text(projectMetadata.templateDigest) } : { state: 'missing' },
				library: libraryExact ? { state: 'ready', bindingId: String(library.id) } : library ? { state: 'conflict' } : { state: 'missing' },
				inventory: inventoryExact ? { state: 'ready', version: inventoryVersion } : { state: 'missing' },
			};
		},
		async reconcileProject(target) {
			if (await project(target)) return;
			await store.createProject(target.team, { slug: target.slug, name: target.slug.split('-').map((part: string) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join(' '),
				metadata: { platformCreation: { repository: target.repository, template: target.template } }, entitlementTier: 'free' });
		},
		async reconcileRepository(target) {
			const current = await project(target); if (!current) throw new Error('Project authority is missing before repository reconciliation.');
			let repository = await remote(target); const credential = token();
			if (!repository) {
				if (!credential) throw new Error('A configured repository-hosting authority is required to create the GitHub repository.');
				repository = await github(fetchImpl, credential, `/orgs/${encodeURIComponent(target.repository.owner)}/repos`, { method: 'POST', body: JSON.stringify({ name: target.repository.name, private: target.repository.visibility === 'private', has_issues: true, auto_init: false }) });
			}
			if (!repository) throw new Error('GitHub did not return the reconciled repository.');
			await store.upsertHubRepository(current.id, { teamId: target.team, role: 'primary', provider: 'github', owner: target.repository.owner,
				name: target.repository.name, url: repositoryUrl(target.repository.owner, target.repository.name), defaultBranch: 'main', currentBranch: 'staging', status: 'active' });
		},
		async applyTemplate(target) {
			const current = await project(target); if (!current) throw new Error('Project authority is missing before template application.');
			const tag = `template/${target.template.version}`; const artifactUrl = `https://github.com/treeseed-ai/template-${encodeURIComponent(target.template.id)}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(target.template.id)}-template.tgz`;
			const response = await fetchImpl(artifactUrl); if (!response.ok) throw new Error(`Template artifact download failed (HTTP ${response.status}).`);
			const artifact = Buffer.from(await response.arrayBuffer()); if (sha256(artifact) !== target.template.digest) throw new Error('Template artifact digest does not match the accepted release.');
			const files = await templateFiles(artifact, target.slug); const base = `/repos/${encodeURIComponent(target.repository.owner)}/${encodeURIComponent(target.repository.name)}`; const credential = token();
			if (!credential) throw new Error('Repository-hosting write authority is required to apply the project template.');
			const treeEntries = []; for (const [path, content] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
				const blob = await github(fetchImpl, credential, `${base}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }) });
				treeEntries.push({ path, mode: '100644', type: 'blob', sha: blob?.sha });
			}
			const tree = await github(fetchImpl, credential, `${base}/git/trees`, { method: 'POST', body: JSON.stringify({ tree: treeEntries }) });
			const main = await github(fetchImpl, credential, `${base}/git/ref/heads/main`);
			if (main) { const commit = await github(fetchImpl, credential, `${base}/git/commits/${main.object?.sha}`); if (commit?.tree?.sha !== tree?.sha) throw new Error('The adopted repository contains source that does not match the accepted template.'); }
			else { const commit = await github(fetchImpl, credential, `${base}/git/commits`, { method: 'POST', body: JSON.stringify({ message: `Initialize ${target.slug} from ${tag}`, tree: tree?.sha, parents: [] }) });
				await github(fetchImpl, credential, `${base}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: 'refs/heads/main', sha: commit?.sha }) }); }
			const acceptedMain = await github(fetchImpl, credential, `${base}/git/ref/heads/main`); const staging = await github(fetchImpl, credential, `${base}/git/ref/heads/staging`);
			if (staging && staging.object?.sha !== acceptedMain?.object?.sha) throw new Error('The adopted staging branch does not match the accepted template commit.');
			if (!staging) await github(fetchImpl, credential, `${base}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: 'refs/heads/staging', sha: acceptedMain?.object?.sha }) });
			await store.updateProject(current.id, { metadata: { ...record(current.metadata), platformCreation: { ...metadata(current.metadata), templateDigest: target.template.digest, templateVersion: target.template.version, templateCommit: acceptedMain?.object?.sha } } });
		},
		async reconcileLibrary(target) {
			const current = await project(target); if (!current) throw new Error('Project authority is missing before TreeDX binding.'); const name = libraryName(target);
			const provider = await reconcileLibraryProvider({ store, teamId: target.team, projectId: current.id, projectSlug: target.slug, owner: target.repository.owner, name,
				visibility: target.repository.visibility, lifecycle: 'create-or-adopt', env, fetchImpl, seedFiles: { 'README.md': `# ${target.slug} Library\n` } });
			await store.upsertHubRepository(current.id, { teamId: target.team, role: 'library', provider: 'github', owner: target.repository.owner, name,
				url: repositoryUrl(target.repository.owner, name), defaultBranch: 'main', currentBranch: 'staging', status: 'active' });
			await ensureProjectKnowledgeBinding({ store, projectId: current.id, teamId: target.team, projectSlug: target.slug, libraryRoot: '.', libraryRef: 'refs/remotes/origin/staging',
				libraryRepositoryUrl: repositoryUrl(target.repository.owner, name), libraryDefaultBranch: 'main', libraryCredentialId: provider.credentialId, expectedUpstreamHeads: provider.heads, env });
		},
		async publishInventory(target) {
			const current = await project(target); if (!current) throw new Error('Project authority is missing before inventory publication.'); const currentMetadata = metadata(current.metadata);
			await store.updateProject(current.id, { metadata: { ...record(current.metadata), platformCreation: { ...currentMetadata, inventoryVersion: Math.max(1, Number(currentMetadata.inventoryVersion ?? 0) + 1), inventoryStatus: 'active' } } });
		},
	};

	return {
		plan: async (target: Partial<ProjectCreateTarget>) => planPlatformProjectCreate(await resolveTarget(target), authority),
		async apply(plan: ProjectCreatePlan, idempotencyKey: string) {
			const accepted = projectCreatePlanSchema.parse(plan); const prior = await store.first(`SELECT response_json,request_digest FROM capacity_operation_receipts WHERE team_id=? AND operation='platform-project-create' AND idempotency_key=?`, [accepted.team, idempotencyKey]);
			if (prior) { if (prior.request_digest !== accepted.planDigest) throw new Error('The idempotency key was already used with a different project plan.'); return { ...record(typeof prior.response_json === 'string' ? JSON.parse(prior.response_json) : prior.response_json), replayed: true }; }
			const receipt = await applyPlatformProjectCreate(accepted, authority); const now = new Date().toISOString();
			await store.run(`INSERT INTO capacity_operation_receipts (id,team_id,operation,idempotency_key,request_digest,resource_type,resource_id,response_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
				[randomUUID(), accepted.team, 'platform-project-create', idempotencyKey, accepted.planDigest, 'project', receipt.projectId, JSON.stringify(receipt), now, now]);
			return { ...receipt, replayed: false };
		},
	};
}
