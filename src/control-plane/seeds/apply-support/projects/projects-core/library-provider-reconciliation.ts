import { createHash } from 'node:crypto';
import { createRemoteGitCredentialDelivery } from '../../../../../security/remote-git-credential-delivery.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const identifier = (kind: string, value: string) => `${kind}:${sha(value).slice(0, 32)}`;

async function github(input: { fetchImpl: typeof fetch; token?: string; path: string; method?: string; body?: unknown }) {
	const response = await input.fetchImpl(`https://api.github.com${input.path}`, {
		method: input.method ?? 'GET', headers: { accept: 'application/vnd.github+json',
			...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
			...(input.body ? { 'content-type': 'application/json' } : {}),
			'user-agent': 'treeseed-seed-library-reconciler', 'x-github-api-version': '2022-11-28' },
		...(input.body ? { body: JSON.stringify(input.body) } : {}),
	});
	if (response.status === 404) return null;
	if (!response.ok) throw new Error(`GitHub library reconciliation failed (HTTP ${response.status}).`);
	return response.status === 204 ? {} : response.json() as Promise<Record<string, any>>;
}

async function repositoryHead(input: { fetchImpl: typeof fetch; token?: string; owner: string; name: string; branch: string; optional?: boolean }) {
	const ref = await github({ ...input, path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}/git/ref/heads/${encodeURIComponent(input.branch)}` });
	const head = String(ref?.object?.sha ?? '');
	if (!head && input.optional) return '';
	if (!/^[a-f0-9]{40}$/u.test(head)) throw new Error(`GitHub library ${input.owner}/${input.name} is missing exact ${input.branch} head evidence.`);
	return head;
}

async function seedRepositoryFiles(input:{fetchImpl:typeof fetch;token:string;owner:string;name:string;branch:string;files:Record<string,string>}) {
	for(const [path,content] of Object.entries(input.files).sort(([left],[right])=>left.localeCompare(right))) {
		const endpoint=`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
		const existing=await github({...input,path:`${endpoint}?ref=${encodeURIComponent(input.branch)}`});
		const decoded=typeof existing?.content==='string'?Buffer.from(existing.content.replace(/\s/gu,''),'base64').toString('utf8'):'';
		const generatedReadme=path==='README.md'&&decoded.trim().toLowerCase()===`# ${input.name}`.toLowerCase();
		if(existing&&!generatedReadme)continue;
		await github({...input,path:endpoint,method:'PUT',body:{message:`Seed managed Team Library ${path}`,content:Buffer.from(content,'utf8').toString('base64'),branch:input.branch,...(existing?.sha?{sha:existing.sha}:{})}});
	}
}

async function ensureProvidedAuthority(input: { store: any; teamId: string; projectId: string; owner: string; name: string;
	repository: Record<string, any>; heads: Record<string,string>; authority: RepositoryAuthority }) {
	const now = new Date().toISOString();
	const bindingId = identifier('repository-binding', `${input.projectId}:${input.owner}/${input.name}`);
	await input.store.run(`INSERT INTO project_remote_repository_bindings
		(id,project_id,team_id,service_connection_id,capability_binding_id,provider_id,provider_repository_id,owner,name,clone_url,
		default_ref,publication_ref,authority_id,expected_head,observed_head,grant_status,drift,version,created_at,updated_at)
		VALUES (?,?,?,?,?,'github',?,?,?,?, 'refs/heads/main','refs/heads/staging',?,?,?,'ready','none',1,?,?)
		ON CONFLICT(project_id) DO UPDATE SET service_connection_id=excluded.service_connection_id,capability_binding_id=excluded.capability_binding_id,
		provider_id='github',provider_repository_id=excluded.provider_repository_id,owner=excluded.owner,name=excluded.name,clone_url=excluded.clone_url,
		default_ref=excluded.default_ref,publication_ref=excluded.publication_ref,authority_id=excluded.authority_id,expected_head=excluded.expected_head,
		observed_head=excluded.observed_head,grant_status='ready',drift='none',version=project_remote_repository_bindings.version+1,updated_at=excluded.updated_at`, [
		bindingId,input.projectId,input.teamId,input.authority.serviceConnectionId,input.authority.capabilityBindingId,
		String(input.repository.id),input.owner,input.name,`https://github.com/${input.owner}/${input.name}.git`,input.authority.authorityId,
		input.heads.staging,input.heads.staging,now,now,
	]);
	return { bindingId, authorityId: input.authority.authorityId };
}

type RepositoryAuthority = { token: string; authorityId: string; serviceConnectionId: string; capabilityBindingId: string };

export async function reconcileLibraryProvider(input: {
	store: any; teamId: string; projectId: string; projectSlug: string; owner: string; name: string; visibility: 'public'|'private';
	lifecycle: 'create-or-adopt'|'adopt-only'; env: NodeJS.ProcessEnv; fetchImpl?: typeof fetch;seedFiles?:Record<string,string>;
	repositoryAuthority?: RepositoryAuthority;
}) {
	const fetchImpl = input.fetchImpl ?? fetch;
	const token = input.repositoryAuthority?.token;
	let repository = await github({ fetchImpl, token, path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}` });
	if (!repository && token && input.name.endsWith('-library')) {
		const legacyName = `${input.name.slice(0, -'-library'.length)}-content`;
		const legacy = await github({ fetchImpl, token, path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(legacyName)}` });
		if (legacy) repository = await github({ fetchImpl, token, path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(legacyName)}`,
			method: 'PATCH', body: { name: input.name } });
	}
	if (!repository) {
		if (input.lifecycle !== 'create-or-adopt') throw new Error(`Required GitHub library ${input.owner}/${input.name} does not exist.`);
		if (!token) throw new Error(`A managed team GitHub authority is required to create or access GitHub library ${input.owner}/${input.name}.`);
		repository = await github({ fetchImpl, token, path: `/orgs/${encodeURIComponent(input.owner)}/repos`, method: 'POST',
			body: { name: input.name, private: input.visibility === 'private', has_issues: true, auto_init: true } });
	}
	if (!repository || String(repository.owner?.login ?? '').toLowerCase() !== input.owner.toLowerCase() || String(repository.name) !== input.name) {
		throw new Error(`GitHub library identity does not match ${input.owner}/${input.name}.`);
	}
	const observedVisibility = repository.private === true ? 'private' : 'public';
	if (observedVisibility !== input.visibility) throw new Error(`GitHub library ${input.owner}/${input.name} visibility is ${observedVisibility}, expected ${input.visibility}.`);
	let main = await repositoryHead({ fetchImpl, token, owner:input.owner,name:input.name,branch:'main' });
	let staging = await repositoryHead({ fetchImpl, token, owner:input.owner,name:input.name,branch:'staging', optional:true });
	if (!staging) {
		if (!token || input.lifecycle !== 'create-or-adopt') throw new Error(`GitHub library ${input.owner}/${input.name} is missing its required staging branch.`);
		await github({ fetchImpl, token, path:`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}/git/refs`,
			method:'POST',body:{ref:'refs/heads/staging',sha:main} });
		staging = await repositoryHead({ fetchImpl, token, owner:input.owner,name:input.name,branch:'staging' });
	}
	if(input.seedFiles&&Object.keys(input.seedFiles).length) {
		if(!token)throw new Error(`A managed team GitHub authority is required to seed managed library ${input.owner}/${input.name}.`);
		await seedRepositoryFiles({fetchImpl,token,owner:input.owner,name:input.name,branch:'main',files:input.seedFiles});
		await seedRepositoryFiles({fetchImpl,token,owner:input.owner,name:input.name,branch:'staging',files:input.seedFiles});
		main=await repositoryHead({fetchImpl,token,owner:input.owner,name:input.name,branch:'main'});
		staging=await repositoryHead({fetchImpl,token,owner:input.owner,name:input.name,branch:'staging'});
	}
	const heads = { main, staging };
	if (!token) return { heads, credentialId: undefined };
	if (!input.repositoryAuthority) throw new Error('Managed repository authority is required.');
	const authority = await ensureProvidedAuthority({ ...input, repository, heads, authority: input.repositoryAuthority });
	if (input.visibility === 'public') return { heads, credentialId: undefined };
	const refspecs = ['+refs/heads/main:refs/remotes/origin/main','+refs/heads/staging:refs/remotes/origin/staging'];
	const delivery = await createRemoteGitCredentialDelivery({ store:input.store,
		operationId:`seed-library-fetch:${input.projectId}:${heads.main}:${heads.staging}`,actorId:'treeseed-seed-reconciler',teamId:input.teamId,
		projectId:input.projectId,repositoryBindingId:authority.bindingId,credentialAuthorityId:authority.authorityId,
		nodeId:String(input.env.TREESEED_TREEDX_NODE_ID ?? 'node_local'),sourceRef:'refs/heads/main',destinationRef:'refs/remotes/origin/main',
		reviewedCommit:heads.staging,expectedRemoteHead:heads.staging,purpose:'fetch',refspec:refspecs.join('\n') });
	return { heads, credentialId: delivery.deliveryId };
}
