import { validateContentRecord,type ContentModel,type ContentValidationResult } from '../content/content-validation.ts';

export class GovernanceContentValidationError extends Error {
	readonly status = 422;
	readonly code = 'governance_content_model_invalid';
	constructor(readonly model: ContentModel,readonly details: ReturnType<typeof validateContentRecord>['diagnostics']) {
		const explanation = details.map((diagnostic) => `${diagnostic.field}: ${diagnostic.message}`).join('; ');
		super(`Governance ${model} content failed model validation${explanation ? `: ${explanation}` : '.'}`);
		this.name = 'GovernanceContentValidationError';
	}
}

export function assertGovernanceContent(model: ContentModel,source: string): ContentValidationResult {
	const validation = validateContentRecord(model,source);
	if (!validation.ok) throw new GovernanceContentValidationError(model,validation.diagnostics);
	return validation;
}
