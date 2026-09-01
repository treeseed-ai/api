function normalizedRoot(contentRoot: string) {
	const root = contentRoot.replace(/\\/gu, '/').replace(/\/+$/u, '').replace(/^\.\//u, '');
	return root === '.' ? '' : root;
}

export function assignmentOperationalContentPaths(contentRoot: string, assignmentId: string) {
	const root = normalizedRoot(contentRoot);
	const prefix = root ? `${root}/` : '';
	return [
		`${prefix}assignment-plans/${assignmentId}.mdx`,
		`${prefix}assignment-statuses/${assignmentId}-status-*`,
		`${prefix}assignment-summaries/${assignmentId}.mdx`,
	];
}

export function assignmentBootstrapReadPaths(contentRoot: string, agentContentPath: unknown, subjectPath: unknown) {
	const root = normalizedRoot(contentRoot);
	const prefix = root ? `${root}/` : '';
	const identityAnchors = [`${prefix}README.md`];
	const editorialAnchors = typeof agentContentPath === 'string' && agentContentPath.includes('/agents/editorial/')
		? [
			`${prefix}README.md`,
			`${prefix}notes/editorial/core.mdx`,
			`${prefix}notes/editorial/core.md`,
			`${prefix}notes/editorial/books/treeseed-guide/core.mdx`,
			`${prefix}notes/editorial/books/treeseed-guide/core.md`,
		]
		: [];
	return [agentContentPath, subjectPath, ...identityAnchors, ...editorialAnchors]
		.filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
		.map((path) => path.trim());
}

export function assignmentContextQueryReadPaths(contentRoot: string, contextQueryRefs: unknown, contextQueryChecks: unknown) {
	const root = normalizedRoot(contentRoot);
	const references = Array.isArray(contextQueryRefs) ? contextQueryRefs : [];
	const checks = Array.isArray(contextQueryChecks) ? contextQueryChecks : [];
	const definitionPaths = references.flatMap((value) => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
		const reference = value as Record<string, unknown>;
		if (typeof reference.id !== 'string' || !reference.id.trim()) return [];
		if (reference.kind === 'query') return [`${root}/agent-context-queries/${reference.id.trim()}.mdx`];
		if (reference.kind === 'query-set') return [
			`${root}/agent-context-query-sets/${reference.id.trim()}.mdx`,
			`${root}/agent-context-queries/**`,
		];
		return [];
	});
	const resultPaths = checks.flatMap((value) => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
		const stats = (value as Record<string, unknown>).stats;
		if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return [];
		return Array.isArray((stats as Record<string, unknown>).paths)
			? ((stats as Record<string, unknown>).paths as unknown[]).filter((path): path is string => typeof path === 'string')
			: [];
	});
	return mergeAssignmentPathScopes(definitionPaths, resultPaths);
}

export function assignmentInstructionTemplateReadPaths(contentRoot: string, instructionTemplateRefs: unknown) {
	const root = normalizedRoot(contentRoot);
	return mergeAssignmentPathScopes((Array.isArray(instructionTemplateRefs) ? instructionTemplateRefs : []).flatMap((value) => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
		const id = typeof (value as Record<string,unknown>).id === 'string' ? String((value as Record<string,unknown>).id).trim() : '';
		return id ? [`${root}/agent-instruction-templates/${id}.mdx`,`${root}/agent-instruction-templates/${id}.md`] : [];
	}));
}

export function mergeAssignmentPathScopes(...scopes: string[][]) {
	return [...new Set(scopes.flat().map((path) => path.trim()).filter(Boolean))];
}

export function assignmentDiscussionMessageReadPaths(refs: unknown[]) {
	return mergeAssignmentPathScopes(refs.map(String).map((path) => path.replace(/\\/gu, '/').replace(/^\.\//u, ''))
		.filter((path) => path.startsWith('discussion-messages/') || path.includes('/discussion-messages/')));
}

export function assignmentTreeDxProxyHandle(input: {
	assignmentId: string; teamId: string; projectId: string; executionMode: 'simulation' | 'production';
	repositoryId: string; workspaceId: string; allowedPaths: string[]; allowedReadPaths: string[];
	allowedWritePaths: string[]; expiresAt: string; demandId: string; workdayRunId: string;
}) {
	return {
		id: `tdx_${input.assignmentId}`, teamId: input.teamId, projectId: input.projectId, assignmentId: input.assignmentId,
		executionMode: input.executionMode, repositoryId: input.repositoryId, workspaceId: input.workspaceId, status: 'provisioning',
		scopes: ['project:read', 'project:write', 'workspace:read', 'workspace:write', 'files:read', 'files:search', 'graph:query', 'files:write', 'git:commit'],
		allowedOperations: ['files:read', 'files:search', 'graph:query', 'files:write', 'git:commit', 'workspace:write'],
		allowedPaths: input.allowedPaths, allowedReadPaths: input.allowedReadPaths, allowedWritePaths: input.allowedWritePaths,
		expiresAt: input.expiresAt,
		metadata: { source: 'workday-demand', demandId: input.demandId, workdayRunId: input.workdayRunId,
			executionMode: input.executionMode, upstreamMutationPolicy: input.executionMode === 'production' ? 'checkpoint-only' : 'denied' },
	};
}
