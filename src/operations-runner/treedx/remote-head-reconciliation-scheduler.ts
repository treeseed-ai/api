import { createHash } from 'node:crypto';
import { githubRepositoryHead } from '../../providers/github/repository-client.ts';
import { resolveGitHubCredentialAuthority } from '../../security/provider-credential-authority.ts';

function object(value: unknown): Record<string, any> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	return value as Record<string, any>;
}

function parse(value: unknown) {
	if (typeof value !== 'string') return object(value);
	try { return object(JSON.parse(value)); } catch { return {}; }
}

function operationKey(projectId: string, publicationRef: string, remoteHead: string) {
	const digest = createHash('sha256').update(`${projectId}:${publicationRef}:${remoteHead}`).digest('hex');
	return `treedx-remote-head:${digest}`;
}

export class TreeDxRemoteHeadReconciliationScheduler {
	private lastAttemptAt = 0;

	constructor(private readonly store: any, private readonly intervalMs = 30_000,
		private readonly fetchImpl: typeof fetch = store.config?.fetchImpl ?? fetch) {}

	async runIfDue(time = Date.now()) {
		if (time - this.lastAttemptAt < this.intervalMs) return { scheduled: false };
		this.lastAttemptAt = time;
		const bindings: any[] = await this.store.all(`SELECT b.*,l.repository_id,l.content_repository_ref,l.metadata_json
			FROM project_remote_repository_bindings b JOIN treedx_project_libraries l ON l.project_id=b.project_id
			WHERE b.provider_id='github' AND b.grant_status='ready' AND l.repository_id IS NOT NULL
			ORDER BY b.project_id`);
		let observed = 0, queued = 0, failed = 0;
		for (const binding of bindings) {
			try {
				const credential = await resolveGitHubCredentialAuthority({ store: this.store,
					authorityId: binding.authority_id, repositoryBindingId: binding.id,
					capability: 'repository-hosting', fetchImpl: this.fetchImpl });
				const publicationRef = String(binding.publication_ref ?? '');
				const remoteHead = await githubRepositoryHead(this.fetchImpl, credential.token,
					String(binding.owner), String(binding.name), publicationRef);
				if (!remoteHead) continue;
				observed += 1;
				const metadata = parse(binding.metadata_json);
				const currentResolvedRef = String(metadata.resolvedRef ?? '');
				const canonicalRef = String(binding.content_repository_ref ?? '');
				if (binding.expected_head === remoteHead && binding.observed_head === remoteHead
					&& currentResolvedRef === remoteHead && canonicalRef === publicationRef) continue;
				const idempotencyKey = operationKey(String(binding.project_id), publicationRef, remoteHead);
				await this.store.createPlatformOperation({ namespace: 'treedx', operation: 'reconcile_remote_head',
					target: 'control_plane_operations_runner', idempotencyKey,
					input: { teamId: binding.team_id, projectId: binding.project_id, publicationRef, remoteHead },
					requestedByType: 'service', requestedById: 'treedx-remote-head-reconciliation-scheduler' });
				queued += 1;
			} catch {
				// A broken provider binding must not block reconciliation for other projects.
				failed += 1;
			}
		}
		return { scheduled: true, observed, queued, failed };
	}
}
