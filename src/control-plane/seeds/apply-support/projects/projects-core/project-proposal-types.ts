import type { TreeDxClient } from '@treeseed/treedx/treedx/client';
import { validateProposalTypeContract, type ProposalTypeContract } from '@treeseed/sdk/agent-capacity';
import { parse } from 'yaml';

type Row = Record<string, unknown>;
function row(value: unknown): Row { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
function result(value: unknown): Row { const outer = row(value); return outer.query ? row(outer.query) : outer; }

/** Freeze repository-owned proposal contracts at the same commit as the agent definitions. */
export async function readProjectProposalTypes(client: Pick<TreeDxClient, 'query'>, repositoryId: string, ref: string): Promise<Record<string, ProposalTypeContract>> {
	if (!/^[a-f0-9]{40}$/u.test(ref)) throw new Error('Proposal type reconciliation requires an immutable library commit.');
	const listing = result(await client.query.listPaths(repositoryId, { ref, paths: ['.treeseed/governance/proposal-types/**'], kinds: ['blob'], limit: 500, allowProtected: true }));
	if (listing.resolvedRef !== ref || !Array.isArray(listing.entries) || row(listing.page).hasMore === true) throw new Error('Proposal type catalog is incomplete or its immutable ref changed.');
	const paths = listing.entries.map((value) => String(row(value).path ?? '')).sort();
	if (paths.some((path) => !/^\.treeseed\/governance\/proposal-types\/[a-z0-9][a-z0-9-]*\.yaml$/u.test(path)) || new Set(paths).size !== paths.length) throw new Error('Proposal type catalog contains a noncanonical or duplicate path.');
	if (!paths.length) return {};
	const read = result(await client.query.readFile(repositoryId, { ref, paths, encoding: 'utf8', parseFrontmatter: false, allowProtected: true }));
	if (read.resolvedRef !== ref || !Array.isArray(read.files) || read.files.length !== paths.length) throw new Error('Proposal type source read-back is incomplete or moved.');
	const contracts: Record<string, ProposalTypeContract> = {};
	const seen = new Set<string>();
	for (const value of read.files) {
		const file = row(value), path = String(file.path ?? '');
		if (!paths.includes(path) || seen.has(path) || typeof file.content !== 'string') throw new Error('Proposal type read-back has duplicate, unexpected, or missing content.');
		seen.add(path);
		const validation = validateProposalTypeContract(parse(file.content));
		if (!validation.ok || !validation.value || path !== `.treeseed/governance/proposal-types/${validation.value.id}.yaml`) throw new Error(`Invalid proposal type contract at ${path}.`);
		contracts[validation.value.id] = validation.value;
	}
	return contracts;
}
