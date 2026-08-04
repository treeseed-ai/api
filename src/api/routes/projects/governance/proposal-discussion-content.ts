import { createHash,randomUUID } from 'node:crypto';
import { serializeFrontmatterDocument } from '@treeseed/sdk/frontmatter';
import { resolveKnowledgeGatewayConnection } from '../../../knowledge/gateway-treedx-connection.ts';

type Row = Record<string, unknown>;

function object(value: unknown): Row {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row;
	if (typeof value === 'string') try { return object(JSON.parse(value)); } catch { return {}; }
	return {};
}

function text(...values: unknown[]) {
	return String(values.find((value) => typeof value === 'string' && value.trim()) ?? '').trim();
}

function list(value: unknown) {
	return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function slug(value: string) {
	return value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 72) || 'proposal';
}

function proposalReference(proposal: Row, metadata: Row) {
	const provenance = object(metadata.contentProvenance);
	const path = text(provenance.contentPath, metadata.contentPath);
	return path ? path.split('/').at(-1)?.replace(/\.(?:md|mdx)$/u, '') ?? '' : '';
}

export async function createProposalDiscussionContent(input: {
	store: any;
	proposal: Row;
	principal: Row;
	kind: 'question' | 'concern' | 'support' | 'response';
	message: string;
	idempotencyKey: string;
	contributorRef?: string | null;
}) {
	const projectId = text(input.proposal.projectId, input.proposal.project_id);
	const connection = await resolveKnowledgeGatewayConnection(input.store, { projectId, write: true, relationPaths: true });
	if (!connection) throw new Error('The project TreeDX repository is unavailable for proposal discussion.');
	const metadata = object(input.proposal.metadata); const reference = proposalReference(input.proposal, metadata); const pathReference = reference || text(input.proposal.id);
	const digest = createHash('sha256').update(`${input.proposal.id}:${input.principal.id}:${input.idempotencyKey}`).digest('hex');
	const identity = `${input.kind}-${digest.slice(0, 20)}`; const now = new Date().toISOString();
	const collection = input.kind === 'question' ? 'questions' : 'notes';
	const path = `${connection.contentPath}/${collection}/governance/proposals/${slug(pathReference)}/${identity}.mdx`;
	const relatedObjectives = list(metadata.relatedObjectives); const relatedBooks = list(metadata.relatedBooks);
	const title = input.kind === 'question' ? input.message.replace(/[?.!]+$/u, '').slice(0, 110) : `${input.kind.charAt(0).toUpperCase()}${input.kind.slice(1)}: ${text(input.proposal.title, 'proposal').slice(0, 88)}`;
	const shared = { title, description: input.message, date: now, status: 'in progress', tags: ['governance', 'proposal-discussion', input.kind], summary: input.message, draft: false };
	if (input.kind === 'question' && !text(input.contributorRef)) throw new Error('A content contributor reference is required to create a proposal question.');
	const frontmatter = input.kind === 'question' ? {
		...shared, questionType: 'evaluation', motivation: `Resolve a governance question before proposal ${text(input.proposal.id)} advances.`,
		primaryContributor: text(input.contributorRef), about: [`proposal:${text(input.proposal.id)}`], relatedObjectives, relatedProposals: reference ? [reference] : [], relatedBooks,
	} : {
		...shared, id: `note:${projectId}:proposal-discussion:${identity}`, author: text(input.principal.name, input.principal.email, input.principal.id, 'Team member'),
		feedbackKind: input.kind, about: [`proposal:${text(input.proposal.id)}`], relatedObjectives, relatedQuestions: [], relatedProposals: reference ? [reference] : [], relatedDecisions: [], relatedBooks,
	};
	const source = serializeFrontmatterDocument(frontmatter, `${input.message}\n`);
	const branchName = `refs/heads/${connection.authoringBranch.replace(/^refs\/heads\//u, '')}`;
	const workspace = await connection.client.createWorkspace({
		workspaceId: `proposal-discussion-${randomUUID()}`, repoId: connection.repositoryId, baseRef: branchName,
		branchName, mode: 'writable', allowedPaths: connection.allowedPaths, ttlSeconds: 600,
	});
	try {
		await connection.client.writeFile({ workspaceId: workspace.workspaceId, path, content: source, encoding: 'utf8' });
		const commit = await connection.client.commit({
			workspaceId: workspace.workspaceId, message: `governance: ${input.kind} on ${text(input.proposal.id)}`,
			author: { name: text(input.principal.name, input.principal.id, 'Team member'), email: text(input.principal.email, 'governance@users.treeseed.local') },
		});
		return { model: input.kind === 'question' ? 'question' : 'note', id: identity, path, commitSha: commit.commitSha, digest: createHash('sha256').update(source).digest('hex'), proposalReference: reference };
	} catch (error) {
		await connection.client.closeWorkspace(workspace.workspaceId).catch(() => undefined);
		throw error;
	}
}
