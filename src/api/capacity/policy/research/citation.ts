import type { ResearchCitation } from '@treeseed/sdk/agent-capacity';

export const RESEARCH_CITATION_MAX_EXCERPT_CHARACTERS = 2_000;

export interface ResearchCitationDiagnostic {
	code: string;
	path: string;
	message: string;
}

function present(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function timestamp(value: unknown) {
	return present(value) && Number.isFinite(Date.parse(value));
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

export function validateResearchCitation(value: unknown, path = 'citation') {
	const citation = record(value);
	const diagnostics: ResearchCitationDiagnostic[] = [];
	const add = (code: string, field: string, message: string) => diagnostics.push({ code, path: `${path}.${field}`, message });
	try {
		const url = new URL(String(citation.sourceUrl ?? ''));
		if (url.protocol !== 'https:' && url.protocol !== 'http:') add('research_citation_url_protocol_invalid', 'sourceUrl', 'sourceUrl must use HTTP or HTTPS.');
	} catch {
		add('research_citation_url_invalid', 'sourceUrl', 'sourceUrl must be an absolute URL.');
	}
	if (!present(citation.title)) add('research_citation_title_required', 'title', 'title is required.');
	if (!timestamp(citation.retrievedAt)) add('research_citation_retrieved_at_invalid', 'retrievedAt', 'retrievedAt must be an ISO timestamp.');
	if (citation.publishedAt !== undefined && !timestamp(citation.publishedAt)) add('research_citation_published_at_invalid', 'publishedAt', 'publishedAt must be an ISO timestamp when provided.');
	if (!present(citation.contentHash)) add('research_citation_content_hash_required', 'contentHash', 'contentHash is required.');
	if (!Array.isArray(citation.claimIds) || citation.claimIds.length === 0 || citation.claimIds.some((id) => !present(id))) add('research_citation_claim_ids_invalid', 'claimIds', 'claimIds must contain at least one non-empty claim identifier.');
	if (!['low', 'medium', 'high'].includes(String(citation.confidence ?? ''))) add('research_citation_confidence_invalid', 'confidence', 'confidence must be low, medium, or high.');
	if (citation.excerpt !== undefined && (!present(citation.excerpt) || String(citation.excerpt).length > RESEARCH_CITATION_MAX_EXCERPT_CHARACTERS)) add('research_citation_excerpt_invalid', 'excerpt', `excerpt must be a non-empty string of at most ${RESEARCH_CITATION_MAX_EXCERPT_CHARACTERS} characters.`);
	return { ok: diagnostics.length === 0, diagnostics };
}

export function validateResearchCitations(citations: unknown, path = 'citations') {
	const diagnostics = Array.isArray(citations)
		? citations.flatMap((citation, index) => validateResearchCitation(citation, `${path}[${index}]`).diagnostics)
		: [{ code: 'research_citations_array_required', path, message: 'citations must be an array.' }];
	return { ok: diagnostics.length === 0, diagnostics };
}

export function assertResearchCitations(citations: unknown, path = 'citations'): ResearchCitation[] {
	const result = validateResearchCitations(citations, path);
	if (!result.ok) {
		const details = result.diagnostics.map((diagnostic) => `${diagnostic.code} at ${diagnostic.path}`).join(', ');
		throw new Error(`Invalid research citations: ${details}`);
	}
	return citations as ResearchCitation[];
}
