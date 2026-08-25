import { validateAgentDefinitionModel } from '@treeseed/sdk/agent-capacity';
import { parseFrontmatterDocument, serializeFrontmatterDocument } from '../../../content/frontmatter.ts';

type Row = Record<string, unknown>;
export const REPOSITORY_DEFINITION_EXTENSIONS = ['.md', '.mdx', '.yaml', '.yml'] as const;
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const text = (...values: unknown[]) => String(values.find((value) => typeof value === 'string' && value) ?? '');

export function repositoryDefinitionSource(file: unknown) {
	const value = object(file); const content = text(value.content);
	if (content.startsWith('---\n')) return content;
	const frontmatter = object(value.frontmatter);
	return Object.keys(frontmatter).length ? serializeFrontmatterDocument(frontmatter, content.replace(/^\r?\n/u, '')) : content;
}

export function validateAgentDefinitionSource(source: string) {
	let frontmatter: Row;
	try { frontmatter = parseFrontmatterDocument(source).frontmatter; }
	catch (error) { return { ok: false, diagnostics: [{ code: 'agent_frontmatter_invalid', path: 'frontmatter', message: error instanceof Error ? error.message : 'The MDX frontmatter is invalid.' }], references: [] as Array<{ id: string; kind: 'signal' }> }; }
	const diagnostics = validateAgentDefinitionModel(frontmatter).diagnostics;
	const references: Array<{ id: string; kind: 'signal' }> = [];
	for (const profile of Object.values(object(frontmatter.activityProfiles)).map(object)) {
		const signals = object(profile.signals);
		for (const entry of Array.isArray(signals.subscribesTo) ? signals.subscribesTo : []) {
			const id = text(object(entry).contract); if (id) references.push({ id, kind: 'signal' });
		}
		for (const id of Array.isArray(signals.publishes) ? signals.publishes : []) if (text(id)) references.push({ id: text(id), kind: 'signal' });
	}
	return { ok: diagnostics.length === 0, diagnostics, references: [...new Map(references.map((reference) => [`${reference.kind}:${reference.id}`, reference])).values()] };
}
