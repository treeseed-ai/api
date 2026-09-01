import {
	compileDeclarativeContextQuery,
	type DeclarativeContextQuery,
} from '@treeseed/sdk/graph/context-query-contracts';

export type { DeclarativeContextQuery } from '@treeseed/sdk/graph/context-query-contracts';

export interface ContextQueryTestDefinition {
	queryRef?: { id: string; revision: number };
	querySetRef?: { id: string; revision: number };
	testRef: string;
	expectedIdentities: string[];
	expectedRelations: string[];
	expectedPaths?: string[];
	expectedSchemaVersions?: string[];
	resultBounds: { min: number; max: number };
	budget: { maxContextItems: number; maxTokens: number };
	maxLatencyMs?: number;
}

export interface ContextQuerySetDefinition {
	id: string; revision: number; queryRefs: Array<{ id: string; revision: number }>; mergePolicy: 'append' | 'replace';
}

type Assertion = { id: string; passed: boolean; gating?: boolean; expected: unknown; actual: unknown };
type DefinitionRef = { kind: 'query' | 'query-set'; id: string; revision: number; commit: string };

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function unpack(value: unknown) {
	const root = record(value); const payload = record(root.payload); const context = record(payload.context);
	if (Array.isArray(root.nodes)) return root; if (Array.isArray(payload.nodes)) return payload; if (Array.isArray(context.nodes)) return context;
	return payload;
}

function resultFacts(value: unknown) {
	const pack = unpack(value); const nodes = Array.isArray(pack.nodes) ? pack.nodes.map(record) : []; const edges = Array.isArray(pack.edges) ? pack.edges.map(record) : [];
	const directSources=Array.isArray(pack.sources)?pack.sources.map(record):[];
	const memberSources=Array.isArray(pack.memberResults)?pack.memberResults.flatMap((member)=>{const value=unpack(member);return Array.isArray(value.sources)?value.sources.map(record):[];}):[];
	const serialized = JSON.stringify({ nodes, edges });
	const identities = [...new Set(nodes.flatMap((node) => {
		const data = record(node.data); const frontmatter = record(data.frontmatter);
		return [node.id, node.entityId, node.canonicalId, node.slug, node.path, frontmatter.id].filter((entry): entry is string => typeof entry === 'string' && Boolean(entry));
	}))].sort();
	const relations = [...new Set(edges.map((edge) => String(edge.type ?? '').trim().toLowerCase().replaceAll('-', '_')).filter(Boolean))].sort();
	const paths = [...new Set(nodes.map((node) => node.path).filter((entry): entry is string => typeof entry === 'string'))].sort();
	const schemaVersions = [...new Set(nodes.map((node) => record(record(node.data).frontmatter).schemaVersion).filter((entry): entry is string => typeof entry === 'string'))].sort();
	const reportedTokens = typeof pack.totalTokenEstimate === 'number' ? pack.totalTokenEstimate : null;
	return { itemCount: nodes.length, bytes: new TextEncoder().encode(serialized).byteLength, estimatedTokens: reportedTokens ?? Math.ceil(serialized.length / 4), reportedTokens, identities, relations, paths, schemaVersions,
		sources:[...directSources,...memberSources].map((source)=>({projectId:String(source.projectId??''),source:String(source.source??''),ref:String(source.ref??''),paths:Array.isArray(source.paths)?source.paths.map(String):[]})).filter((source)=>source.projectId) };
}

function assertions(test: ContextQueryTestDefinition, stats: ReturnType<typeof resultFacts>, latencyMs: number): Assertion[] {
	const relationPresent = (expected: string) => { const normalized = expected.trim().toLowerCase().replaceAll('-', '_'); return stats.relations.includes(normalized) || stats.relations.includes(`${normalized}s`) || stats.relations.includes(normalized.replace(/s$/u, '')); };
	return [
		{ id: 'result-minimum', passed: stats.itemCount >= test.resultBounds.min, expected: test.resultBounds.min, actual: stats.itemCount },
		{ id: 'result-maximum', passed: stats.itemCount <= test.resultBounds.max, expected: test.resultBounds.max, actual: stats.itemCount },
		{ id: 'context-items', passed: stats.itemCount <= test.budget.maxContextItems, expected: test.budget.maxContextItems, actual: stats.itemCount },
		{ id: 'token-budget', passed: stats.estimatedTokens <= test.budget.maxTokens, expected: test.budget.maxTokens, actual: stats.estimatedTokens },
		{ id: 'latency-target', passed: test.maxLatencyMs === undefined || latencyMs <= test.maxLatencyMs, gating: false, expected: test.maxLatencyMs ?? null, actual: latencyMs },
		...(test.expectedIdentities ?? []).map((expected) => ({ id: `identity:${expected}`, passed: stats.identities.includes(expected), expected, actual: stats.identities })),
		...(test.expectedRelations ?? []).map((expected) => ({ id: `relation:${expected}`, passed: relationPresent(expected), expected, actual: stats.relations })),
		...(test.expectedPaths ?? []).map((expected) => ({ id: `path:${expected}`, passed: stats.paths.includes(expected), expected, actual: stats.paths })),
		...(test.expectedSchemaVersions ?? []).map((expected) => ({ id: `schema-version:${expected}`, passed: stats.schemaVersions.includes(expected), expected, actual: stats.schemaVersions })),
	];
}

export async function executeContextQueryTest(input: { query: DeclarativeContextQuery; test: ContextQueryTestDefinition; execute(request: Record<string, unknown>): Promise<unknown>; now?: () => Date }): Promise<Record<string, unknown>> {
	if (!input.test.queryRef) return { ok: false, status: 'failing' as const, phase: 'identity' as const, errors: ['A single-query test requires queryRef.'], warnings: [] };
	const compiled = compileDeclarativeContextQuery(input.query);
	if (!compiled.ok || !compiled.compiled) return { ok: false, status: 'failing' as const, phase: 'compile' as const, errors: compiled.errors, warnings: compiled.warnings };
	if (input.query.id !== input.test.queryRef.id || input.query.revision !== input.test.queryRef.revision) return { ok: false, status: 'stale' as const, phase: 'identity' as const, errors: ['Query id and revision do not match the immutable test reference.'], warnings: compiled.warnings };
	const started = performance.now(); const checkedAt = (input.now ?? (() => new Date()))().toISOString(); const result = await input.execute(compiled.compiled.request as unknown as Record<string, unknown>);
	const latencyMs = Math.round(performance.now() - started); const stats = resultFacts(result); const checked = assertions(input.test, stats, latencyMs); const ok = checked.every((entry) => entry.gating === false || entry.passed);
	return { ok, status: ok ? 'passing' as const : 'failing' as const, phase: 'executed' as const, checkedAt, queryRef: input.test.queryRef, testRef: input.test.testRef, query: compiled.compiled.query, request: compiled.compiled.request, latencyMs, stats, assertions: checked, warnings: compiled.warnings, result };
}

export async function executeContextQuerySetTest(input: { querySet: ContextQuerySetDefinition; queries: DeclarativeContextQuery[]; test: ContextQueryTestDefinition; execute(query: DeclarativeContextQuery, request: Record<string, unknown>): Promise<unknown>; now?: () => Date }): Promise<Record<string, unknown>> {
	const expected = input.test.querySetRef;
	if (!expected || expected.id !== input.querySet.id || expected.revision !== input.querySet.revision) return { ok: false, status: 'stale' as const, phase: 'identity' as const, errors: ['Query-set id and revision do not match the immutable test reference.'], warnings: [] };
	const byRef = new Map(input.queries.map((query) => [`${query.id}@${query.revision}`, query])); const ordered = input.querySet.queryRefs.map((ref) => byRef.get(`${ref.id}@${ref.revision}`));
	if (ordered.some((query) => !query)) return { ok: false, status: 'stale' as const, phase: 'identity' as const, errors: ['One or more exact query-set member revisions are missing.'], warnings: [] };
	const started = performance.now(); const checkedAt = (input.now ?? (() => new Date()))().toISOString(); const memberResults: unknown[] = []; const requests: Record<string, unknown>[] = []; const warnings: string[] = [];
	for (const query of ordered as DeclarativeContextQuery[]) { const compiled = compileDeclarativeContextQuery(query); if (!compiled.ok || !compiled.compiled) return { ok: false, status: 'failing' as const, phase: 'compile' as const, errors: compiled.errors, warnings: [...warnings, ...compiled.warnings] }; warnings.push(...compiled.warnings); requests.push(compiled.compiled.request as unknown as Record<string, unknown>); memberResults.push(await input.execute(query, compiled.compiled.request as unknown as Record<string, unknown>)); }
	const result = { nodes: memberResults.flatMap((entry) => Array.isArray(unpack(entry).nodes) ? unpack(entry).nodes as unknown[] : []), edges: memberResults.flatMap((entry) => Array.isArray(unpack(entry).edges) ? unpack(entry).edges as unknown[] : []), memberResults };
	const latencyMs = Math.round(performance.now() - started); const stats = resultFacts(result); const checked = [{ id: 'member-count', passed: memberResults.length === input.querySet.queryRefs.length, expected: input.querySet.queryRefs.length, actual: memberResults.length }, ...assertions(input.test, stats, latencyMs)]; const ok = checked.every((entry) => entry.gating === false || entry.passed);
	return { ok, status: ok ? 'passing' as const : 'failing' as const, phase: 'executed' as const, checkedAt, querySetRef: expected, testRef: input.test.testRef, querySet: input.querySet, requests, latencyMs, stats, assertions: checked, warnings, result };
}

export function contextQueryReadiness(input: { check: ({ definition: DefinitionRef; status: 'passing' | 'failing' | 'stale'; expiresAt: string } & Record<string, unknown>) | null; definition: DefinitionRef; now?: Date }) {
	const check = input.check; if (!check) return { status: 'unchecked' as const, selectable: false, reason: 'never_checked' as const };
	const exact = check.definition.kind === input.definition.kind && check.definition.id === input.definition.id && check.definition.revision === input.definition.revision;
	if (!exact) return { status: 'stale' as const, selectable: false, reason: 'definition_changed' as const };
	if (Date.parse(check.expiresAt) <= (input.now ?? new Date()).getTime()) return { status: 'stale' as const, selectable: false, reason: 'check_expired' as const };
	if (check.status !== 'passing') return { status: check.status, selectable: false, reason: 'assertions_failed' as const };
	return { status: 'passing' as const, selectable: true, reason: 'fresh_passing_check' as const };
}
