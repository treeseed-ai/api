import { parseDocument } from 'yaml';
import { errorDiagnostic, hasSeedErrors } from './errors.ts';
import { parseSeedManifest } from './schema.ts';
import type { SeedDiagnostic } from './types.ts';

export type * from './types.ts';

export function validateSeedSource(source: string) {
	const diagnostics: SeedDiagnostic[] = [];
	const document = parseDocument(source, { prettyErrors: false });
	for (const issue of document.errors) diagnostics.push(errorDiagnostic('seed.yaml_parse_error', issue.message, 'manifest'));
	const manifest = diagnostics.length ? null : parseSeedManifest(document.toJSON(), diagnostics);
	return { ok: Boolean(manifest) && !hasSeedErrors(diagnostics), manifest: hasSeedErrors(diagnostics) ? null : manifest, diagnostics };
}
