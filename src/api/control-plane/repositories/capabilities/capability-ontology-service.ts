import { randomUUID } from 'node:crypto';
import { capabilityContractDigest, capabilityDefinitionDigest, capabilityDefinitionSchema, CORE_CAPABILITY_DEFINITIONS, CORE_CAPABILITY_ONTOLOGY_CREATED_AT, CORE_CAPABILITY_ONTOLOGY_GENERATION, type CapabilityDefinition } from '@treeseed/sdk/capacity-provider';
import type { CapacityGovernanceDatabase } from '../../../capacity/database.ts';
import { CapacityGovernanceError } from '../../../capacity/database.ts';

type ProviderAuth = { principal?: { capacityProviderId: string; teamId: string; membershipId: string } } | null | undefined;
function decode<T>(value: unknown): T { return JSON.parse(String(value)) as T; }

export function createCapabilityOntologyService(store: CapacityGovernanceDatabase) {
	let initialized: Promise<void> | null = null;
	const ensureSeed = () => initialized ??= (async () => {
		await store.ensureInitialized();
		const ontologyDigest = capabilityContractDigest({ generation: CORE_CAPABILITY_ONTOLOGY_GENERATION, definitions: CORE_CAPABILITY_DEFINITIONS });
		const existing = await store.first(`SELECT generation,ontology_digest FROM capability_ontology_generations WHERE status = 'active' ORDER BY generation DESC LIMIT 1`);
		if (Number(existing?.generation) === CORE_CAPABILITY_ONTOLOGY_GENERATION && String(existing?.ontology_digest) === ontologyDigest) return;
		await store.batch([
			{ query: `UPDATE capability_ontology_generations SET status='superseded' WHERE status='active' AND generation<>?`, params: [CORE_CAPABILITY_ONTOLOGY_GENERATION] },
			{ query: `INSERT INTO capability_ontology_generations (generation,ontology_digest,status,signature_json,created_at) VALUES (?,?,'active',?,?) ON CONFLICT (generation) DO UPDATE SET status='active'`, params: [CORE_CAPABILITY_ONTOLOGY_GENERATION, ontologyDigest, JSON.stringify({ keyId: 'sdk-release', algorithm: 'release-catalog', value: ontologyDigest }), CORE_CAPABILITY_ONTOLOGY_CREATED_AT] },
			...CORE_CAPABILITY_DEFINITIONS.map((definition) => ({ query: `INSERT INTO capability_definitions (capability_id,version,definition_digest,generation,namespace,family,status,definition_json,created_at) VALUES (?,?,?,?,'treeseed',?,?,?,?) ON CONFLICT DO NOTHING`, params: [definition.id, definition.version, definition.digest, CORE_CAPABILITY_ONTOLOGY_GENERATION, definition.family, definition.status, JSON.stringify(definition), definition.createdAt] })),
		]);
	})();
	return {
		ensureInitialized: ensureSeed,
		async list(query: Record<string, unknown>) {
			await ensureSeed(); const generation = await store.first(`SELECT * FROM capability_ontology_generations WHERE status='active' LIMIT 1`);
			const clauses = [`generation = ?`], params: unknown[] = [generation!.generation];
			if (query.family) { clauses.push('family = ?'); params.push(String(query.family)); }
			if (query.status) { clauses.push('status = ?'); params.push(String(query.status)); }
			if (query.namespace) { clauses.push('namespace = ?'); params.push(String(query.namespace)); }
			const limit = Math.min(500, Math.max(1, Number(query.limit ?? 100)));
			const coreRows = query.namespace && query.namespace !== 'treeseed' ? [] : await store.all(`SELECT definition_json FROM capability_definitions WHERE ${clauses.join(' AND ')} ORDER BY capability_id,version LIMIT ?`, [...params, limit]);
			const extensionClauses = [`status='active-namespaced'`], extensionParams: unknown[] = [];
			if (query.family) { extensionClauses.push(`definition_json LIKE ?`); extensionParams.push(`%\"family\":\"${String(query.family)}\"%`); }
			if (query.namespace && query.namespace !== 'treeseed') { extensionClauses.push(`capability_id LIKE ?`); extensionParams.push(`${String(query.namespace)}.%`); }
			const extensionRows = query.namespace === 'treeseed' ? [] : await store.all(`SELECT definition_json FROM provider_capability_proposals WHERE ${extensionClauses.join(' AND ')} ORDER BY capability_id,version LIMIT ?`, [...extensionParams, limit]);
			const rows = [...coreRows, ...extensionRows].slice(0, limit);
			return { generation: Number(generation!.generation), ontologyDigest: String(generation!.ontology_digest), items: rows.map((row) => decode<CapabilityDefinition>(row.definition_json)), nextCursor: null };
		},
		async show(capabilityId: string, version?: unknown) {
			await ensureSeed(); const row = await store.first(`SELECT definition_json FROM capability_definitions WHERE capability_id=? ${version ? 'AND version=?' : ''}
				UNION ALL SELECT definition_json FROM provider_capability_proposals WHERE capability_id=? AND status='active-namespaced' ${version ? 'AND version=?' : ''} LIMIT 1`, version ? [capabilityId, String(version), capabilityId, String(version)] : [capabilityId, capabilityId]);
			if (!row) throw new CapacityGovernanceError('capability_not_found', 'The requested capability is not present in the active ontology.', 404);
			return decode<CapabilityDefinition>(row.definition_json);
		},
		async active() {
			const page = await this.list({ limit: 500 }); const row = await store.first(`SELECT signature_json,created_at FROM capability_ontology_generations WHERE generation=?`, [page.generation]);
			return { schemaVersion: 'treeseed.capability-ontology/v1', generation: page.generation, digest: page.ontologyDigest, definitions: page.items.filter(({ id }) => id.startsWith('treeseed.')), createdAt: String(row!.created_at), signature: decode(row!.signature_json) };
		},
		async propose(auth: ProviderAuth, body: Record<string, unknown>) {
			await ensureSeed(); const principal = auth?.principal; if (!principal) throw new CapacityGovernanceError('provider_access_token_required','Provider authentication is required.',401);
			const provider = await store.first(`SELECT fingerprint FROM capacity_providers WHERE id=? AND status='active'`, [principal.capacityProviderId]);
			if (!provider) throw new CapacityGovernanceError('provider_not_found','The provider identity is unavailable.',404);
			const definition = capabilityDefinitionSchema.parse(body.definition);
			const expectedPrefix = `provider.${String(provider.fingerprint).replace(/^sha256:/u,'').slice(0,64)}.`;
			if (!definition.id.startsWith(expectedPrefix)) throw new CapacityGovernanceError('provider_capability_namespace_invalid',`Provider capabilities must use namespace ${expectedPrefix}`,403);
			const { digest: _digest, ...material } = definition; if (capabilityDefinitionDigest(material) !== definition.digest) throw new CapacityGovernanceError('provider_capability_digest_invalid','Capability definition digest is invalid.',400);
			const signature = body.signature; if (!signature || typeof signature !== 'object') throw new CapacityGovernanceError('provider_capability_signature_required','A provider-signed proposal is required.',400);
			const id = `capability-proposal-${randomUUID()}`, now = new Date().toISOString();
			await store.run(`INSERT INTO provider_capability_proposals (id,capacity_provider_id,capability_id,version,definition_digest,status,definition_json,signature_json,created_at,updated_at) VALUES (?,?,?,?,?,'active-namespaced',?,?,?,?)`, [id, principal.capacityProviderId, definition.id, definition.version, definition.digest, JSON.stringify(definition), JSON.stringify(signature), now, now]);
			return { id, status: 'active-namespaced', definition };
		},
		async proposal(auth: ProviderAuth, id: string) {
			const principal = auth?.principal; if (!principal) throw new CapacityGovernanceError('provider_access_token_required','Provider authentication is required.',401);
			const row = await store.first(`SELECT * FROM provider_capability_proposals WHERE id=? AND capacity_provider_id=?`, [id, principal.capacityProviderId]);
			if (!row) throw new CapacityGovernanceError('capability_proposal_not_found','Capability proposal not found.',404);
			return { id: row.id, status: row.status, definition: decode(row.definition_json), createdAt: row.created_at, updatedAt: row.updated_at };
		},
	};
}
