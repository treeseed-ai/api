import type { SeedDiagnostic } from './types.js';

export function errorDiagnostic(code: string, message: string, path?: string): SeedDiagnostic {
	return { severity: 'error', code, message, path };
}

export function warningDiagnostic(code: string, message: string, path?: string): SeedDiagnostic {
	return { severity: 'warning', code, message, path };
}

export function hasSeedErrors(diagnostics: SeedDiagnostic[]) {
	return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

export function formatSeedDiagnostics(diagnostics: SeedDiagnostic[]) {
	return diagnostics.map((diagnostic) => {
		const prefix = diagnostic.severity === 'error' ? 'ERROR' : 'WARN';
		const location = diagnostic.path ? ` ${diagnostic.path}` : '';
		return `${prefix} ${diagnostic.code}${location}: ${diagnostic.message}`;
	});
}
