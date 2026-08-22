import { parse, stringify } from 'yaml';

export interface FrontmatterDocument {
	frontmatter: Record<string, unknown>;
	body: string;
}

export function parseFrontmatterDocument(source: string): FrontmatterDocument {
	const normalized = source.replace(/\r\n?/gu, '\n');
	if (!normalized.startsWith('---\n')) return { frontmatter: {}, body: normalized };
	const closing = normalized.indexOf('\n---\n', 4);
	if (closing < 0) throw new Error('Frontmatter is missing its closing delimiter.');
	const value = parse(normalized.slice(4, closing));
	if (value != null && (typeof value !== 'object' || Array.isArray(value))) {
		throw new Error('Frontmatter must be a YAML mapping.');
	}
	return { frontmatter: value as Record<string, unknown> ?? {}, body: normalized.slice(closing + 5) };
}

export function serializeFrontmatterDocument(frontmatter: Record<string, unknown>, body = '') {
	return `---\n${stringify(frontmatter).trimEnd()}\n---\n${body}`;
}
