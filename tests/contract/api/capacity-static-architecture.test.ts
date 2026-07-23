import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const packageRoot = process.cwd();
const capacityRoot = resolve(packageRoot, 'src/api/capacity');
const productionFiles = [...walk(capacityRoot), resolve(packageRoot, 'src/api/market-postgres.ts')].sort();
const compilerSuppression = /@ts-(?:nocheck|ignore|expect-error)|eslint-disable|biome-ignore/gu;
const explicitAny = /\bany\b/gu;
const forbiddenBoundaryImport = /from\s+['"]@treeseed\/(?:admin|agent|cli|core|ui)(?:\/[^'"]*)?['"]/gu;
const maximumLines = 500;
const maximumCyclomaticComplexity = 65;
const cloneWindowLines = 18;

function walk(root: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = resolve(root, entry.name);
		if (entry.isDirectory()) files.push(...walk(path));
		else if (path.endsWith('.ts')) files.push(path);
	}
	return files;
}

function label(path: string): string {
	return relative(packageRoot, path);
}

function lineCount(source: string): number {
	return source.split(/\r?\n/u).length;
}

const branchKinds = new Set<ts.SyntaxKind>([
	ts.SyntaxKind.IfStatement,
	ts.SyntaxKind.ConditionalExpression,
	ts.SyntaxKind.ForStatement,
	ts.SyntaxKind.ForInStatement,
	ts.SyntaxKind.ForOfStatement,
	ts.SyntaxKind.WhileStatement,
	ts.SyntaxKind.DoStatement,
	ts.SyntaxKind.CaseClause,
	ts.SyntaxKind.CatchClause,
	ts.SyntaxKind.AmpersandAmpersandToken,
	ts.SyntaxKind.BarBarToken,
	ts.SyntaxKind.QuestionQuestionToken,
]);

function complexFunctions(path: string, source: string): Array<{ file: string; line: number; complexity: number }> {
	const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
	const failures: Array<{ file: string; line: number; complexity: number }> = [];
	const visit = (node: ts.Node): void => {
		if (ts.isFunctionLike(node) && 'body' in node && node.body) {
			let complexity = 1;
			const count = (child: ts.Node): void => {
				if (branchKinds.has(child.kind)) complexity += 1;
				ts.forEachChild(child, count);
			};
			count(node.body);
			if (complexity > maximumCyclomaticComplexity) {
				failures.push({
					file: label(path),
					line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
					complexity,
				});
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return failures;
}

function meaningfulLines(source: string): string[] {
	return source.split(/\r?\n/u)
		.map((line) => line.trim().replace(/\s+/gu, ' '))
		.filter((line) => line.length > 0 && !line.startsWith('//') && !line.startsWith('import ') && line !== '{' && line !== '}');
}

describe('capacity static architecture', () => {
	it('keeps focused production modules bounded and free of compiler suppressions', () => {
		const oversized: Array<{ file: string; lines: number }> = [];
		const suppressed: string[] = [];
		const untyped: string[] = [];
		const boundaryViolations: string[] = [];
		const complexityViolations: Array<{ file: string; line: number; complexity: number }> = [];
		for (const path of productionFiles) {
			const source = readFileSync(path, 'utf8');
			const lines = lineCount(source);
			if (lines > maximumLines) oversized.push({ file: label(path), lines });
			if (compilerSuppression.test(source)) suppressed.push(label(path));
			compilerSuppression.lastIndex = 0;
			if (explicitAny.test(source)) untyped.push(label(path));
			explicitAny.lastIndex = 0;
			if (forbiddenBoundaryImport.test(source)) boundaryViolations.push(label(path));
			forbiddenBoundaryImport.lastIndex = 0;
			complexityViolations.push(...complexFunctions(path, source));
		}
		expect({ oversized, suppressed, untyped, boundaryViolations, complexityViolations }).toEqual({
			oversized: [], suppressed: [], untyped: [], boundaryViolations: [], complexityViolations: [],
		});
	});

	it('contains no exact cross-module implementation clones', () => {
		const windows = new Map<string, { file: string; start: number; sample: string }>();
		const clones: Array<{ first: string; second: string; sample: string }> = [];
		for (const path of productionFiles) {
			const lines = meaningfulLines(readFileSync(path, 'utf8'));
			for (let start = 0; start <= lines.length - cloneWindowLines; start += 1) {
				const sample = lines.slice(start, start + cloneWindowLines).join('\n');
				const digest = createHash('sha256').update(sample).digest('hex');
				const prior = windows.get(digest);
				if (prior && prior.file !== label(path)) clones.push({ first: `${prior.file}:${prior.start}`, second: `${label(path)}:${start + 1}`, sample });
				else windows.set(digest, { file: label(path), start: start + 1, sample });
			}
		}
		expect(clones).toEqual([]);
	});

	it('keeps the suppressed legacy composition store outside the capacity implementation boundary', () => {
		const store = readFileSync(resolve(packageRoot, 'src/api/store.ts'), 'utf8');
		const app = readFileSync(resolve(packageRoot, 'src/api/app.ts'), 'utf8');
		const controlPlane = readFileSync(resolve(packageRoot, 'src/api/capacity/control-plane.ts'), 'utf8');
		const providerControlPlane = readFileSync(resolve(packageRoot, 'src/api/capacity/provider-control-plane.ts'), 'utf8');
		expect(store).not.toMatch(/from ['"].*\/capacity\/(?:repositories|services|routes)\//u);
		expect(store).not.toMatch(/^\s*(?:async\s+)?(?:getCapacityProvider|listProviderAssignmentsPage|createProviderAvailabilitySession|createWorkdayCapacityEnvelope|createCapacityWorkdayRun|createAgentModeRun|upsertDecisionPlanningStatus)\s*\(/mu);
		expect(app).not.toMatch(/store\.(?:getCapacityProvider|listProviderAssignmentsPage|createWorkdayCapacityEnvelope|createCapacityWorkdayRun|createAgentModeRun|upsertDecisionPlanningStatus)\s*\(/u);
		expect(providerControlPlane).toMatch(/admitSynthesizedProviderAssignment\s*\(/u);
		expect(controlPlane).not.toMatch(/new\s+\w+(?:Service|Repository)\(this\)/u);
		expect(`${controlPlane}\n${providerControlPlane}`).not.toMatch(/\bany\b/u);
	});
});
