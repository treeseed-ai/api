import { resolveKnowledgeGatewayConnection } from '../../../../knowledge/gateway-treedx-connection.ts';
import type { WorkdayRouteDependencies } from '../operator-workdays.ts';
import { parseValidatedQuestionContent } from './question-content.ts';

type Row = Record<string, unknown>;
function object(value: unknown): Row { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
function text(...values: unknown[]) { return String(values.find((value) => typeof value === 'string' && value.trim()) ?? '').trim(); }

export async function agentLabInboxQuestions(dependencies: WorkdayRouteDependencies,projects: Row[]) {
	const groups = await Promise.all(projects.map(async (project) => {
		const projectId = text(project.id); if (!projectId) return [];
		const connection = await resolveKnowledgeGatewayConnection(dependencies.store,{ projectId,write:false,relationPaths:true }).catch(() => null); if (!connection) return [];
		const listed = await connection.client.listRepositoryPaths({ repoId:connection.repositoryId,ref:connection.baseRef,paths:[`${connection.contentPath}/questions/**`],kinds:['blob'],extensions:['.md','.mdx'],limit:200 }).catch(() => ({ entries:[] }));
		const paths = (listed.entries ?? []).map((entry: unknown) => text(object(entry).path)).filter(Boolean); if (!paths.length) return [];
		const read = await connection.client.readRepositoryFiles({ repoId:connection.repositoryId,ref:text(listed.resolvedRef,connection.baseRef),paths,encoding:'utf8',parseFrontmatter:false }).catch(() => ({ files:[] }));
		return (read.files ?? []).flatMap((candidate: unknown) => { const file = object(candidate); const path = text(file.path); const parsed = parseValidatedQuestionContent(path,text(file.content));
			if (!parsed.ok) return [{ id:`treedx:${projectId}:questions:invalid:${path}`,kind:'error' as const,title:'Invalid question content',description:'Correct the question fields before Agent Lab can schedule or answer it.',status:'blocked',projectId,projectName:text(project.name,project.slug),occurredAt:null,actionable:true,tags:['question','validation'],data:{ projectId,path,ref:text(read.resolvedRef,listed.resolvedRef,connection.baseRef),source:'treedx',model:'question',diagnostics:parsed.diagnostics } }];
			const frontmatter = object(parsed.frontmatter); const status = text(frontmatter.status,'open').toLowerCase(); if (['answered','resolved','closed','complete','completed'].includes(status)) return [];
			const id = text(frontmatter.id,frontmatter.slug,path); const title = text(frontmatter.title,frontmatter.question,parsed.body.split('\n').find(Boolean),'Untitled question'); const description = text(frontmatter.summary,frontmatter.description,parsed.body).slice(0,600);
			return [{ id:`treedx:${projectId}:questions:${id}`,kind:'question' as const,title,description,status,projectId,projectName:text(project.name,project.slug),occurredAt:text(frontmatter.date,frontmatter.createdAt) || null,actionable:true,tags:[...new Set(['question',...(Array.isArray(frontmatter.tags) ? frontmatter.tags.map(text) : [])])],data:{ projectId,path,ref:text(read.resolvedRef,listed.resolvedRef,connection.baseRef),source:'treedx',frontmatter } }]; });
	}));
	return groups.flat();
}
