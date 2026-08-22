import {
	isPortableContentModel,
	validateContentFrontmatter,
	type PortableContentModel,
} from '@treeseed/sdk/content-validation';
import { parseFrontmatterDocument } from './frontmatter.ts';

export type ContentModel = PortableContentModel;

export interface ContentValidationResult {
	ok: boolean;
	data: unknown;
	diagnostics: Array<{ severity: 'error'; code: string; field: string; message: string }>;
}

export function validateContentRecord(model: ContentModel, source: string): ContentValidationResult {
	try {
		if (!isPortableContentModel(model)) {
			return {
				ok: false,
				data: null,
				diagnostics: [{
					severity: 'error' as const,
					code: 'content_model_unsupported',
					field: 'model',
					message: `Unsupported portable content model: ${String(model)}`,
				}],
			};
		}
		return validateContentFrontmatter(model, parseFrontmatterDocument(source).frontmatter);
	} catch (error) {
		return {
			ok: false,
			data: null,
			diagnostics: [{
				severity: 'error' as const,
				code: 'content_frontmatter_invalid',
				field: 'frontmatter',
				message: error instanceof Error ? error.message : String(error),
			}],
		};
	}
}
