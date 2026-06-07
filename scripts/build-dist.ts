import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';
import { packageRoot } from './package-tools.ts';

const srcRoot = resolve(packageRoot, 'src');
const scriptsRoot = resolve(packageRoot, 'scripts');
const distRoot = resolve(packageRoot, 'dist');

const JS_SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.ts']);
const COPY_EXTENSIONS = new Set(['.d.ts', '.json', '.jsonc', '.md', '.yaml', '.yml']);
const EXECUTABLE_OUTPUTS = new Set([
	'api/server.js',
	'market-operations-runner/entrypoint.js',
	'scripts/migrate-market-db.js',
]);
const REQUIRED_OUTPUTS = [
	'index.js',
	'index.d.ts',
	'api/app.js',
	'api/server.js',
	'api/store.js',
	'api/market-postgres.js',
	'api/project-deployment-routes.js',
	'api/route-descriptors.js',
	'api/hub-launch-application.js',
	'market-operations-runner/entrypoint.js',
	'market-operations-runner/project-web-deployment-executor.js',
	'scripts/migrate-market-db.js',
];

function walkFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.name.startsWith('.ts-run-')) continue;
		const fullPath = join(root, entry.name);
		if (entry.isDirectory()) files.push(...walkFiles(fullPath));
		else files.push(fullPath);
	}
	return files;
}

function ensureDir(filePath: string) {
	mkdirSync(dirname(filePath), { recursive: true });
}

function rewriteRuntimeSpecifiers(contents: string) {
	return contents
		.replace(/(['"`])(\.[^'"`\n]+)\.(mjs|ts)\1/g, '$1$2.js$1')
		.replace(/(['"`])\.\.\/src\//g, '$1../');
}

function outputPathForSource(filePath: string, sourceRoot: string, outputRoot: string) {
	const relativePath = relative(sourceRoot, filePath);
	return resolve(outputRoot, relativePath.replace(/\.(mjs|ts)$/u, '.js'));
}

async function compileModule(filePath: string, sourceRoot: string, outputRoot: string) {
	const outputFile = outputPathForSource(filePath, sourceRoot, outputRoot);
	ensureDir(outputFile);
	await build({
		entryPoints: [filePath],
		outfile: outputFile,
		platform: 'node',
		format: 'esm',
		bundle: false,
		logLevel: 'silent',
	});
	writeFileSync(outputFile, rewriteRuntimeSpecifiers(readFileSync(outputFile, 'utf8')), 'utf8');
	const relativeOutput = relative(outputRoot, outputFile);
	if (EXECUTABLE_OUTPUTS.has(relativeOutput)) chmodSync(outputFile, 0o755);
}

function copyAsset(filePath: string, sourceRoot: string, outputRoot: string) {
	const outputFile = resolve(outputRoot, relative(sourceRoot, filePath));
	ensureDir(outputFile);
	copyFileSync(filePath, outputFile);
	if (outputFile.endsWith('.d.ts')) {
		writeFileSync(outputFile, rewriteRuntimeSpecifiers(readFileSync(outputFile, 'utf8')), 'utf8');
	}
}

function transpileScript(filePath: string) {
	const relativePath = relative(scriptsRoot, filePath);
	const outputFile = resolve(distRoot, 'scripts', relativePath.replace(/\.(mjs|ts)$/u, '.js'));
	const source = readFileSync(filePath, 'utf8');
	const transformed = extname(filePath) === '.ts'
		? ts.transpileModule(source, {
				compilerOptions: {
					module: ts.ModuleKind.ESNext,
					target: ts.ScriptTarget.ES2022,
				},
			}).outputText
		: source;
	ensureDir(outputFile);
	writeFileSync(outputFile, rewriteRuntimeSpecifiers(transformed), 'utf8');
	const relativeOutput = relative(distRoot, outputFile);
	if (EXECUTABLE_OUTPUTS.has(relativeOutput)) chmodSync(outputFile, 0o755);
}

function emitDeclarations() {
	const configPath = ts.findConfigFile(packageRoot, ts.sys.fileExists, 'tsconfig.dist.json')
		?? ts.findConfigFile(packageRoot, ts.sys.fileExists, 'tsconfig.json');
	if (!configPath) throw new Error('Unable to locate a tsconfig for declaration build.');
	const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
	const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, packageRoot);
	const program = ts.createProgram({
		rootNames: parsed.fileNames,
		options: {
			...parsed.options,
			declaration: true,
			emitDeclarationOnly: true,
			declarationDir: distRoot,
			noEmit: false,
		},
	});
	const result = program.emit();
	if (result.emitSkipped) {
		const diagnostics = ts.formatDiagnosticsWithColorAndContext(result.diagnostics, {
			getCanonicalFileName: (fileName) => fileName,
			getCurrentDirectory: () => process.cwd(),
			getNewLine: () => '\n',
		});
		throw new Error(`Declaration build failed.\n${diagnostics}`);
	}
}

function assertRequiredOutputs() {
	for (const relativeOutput of REQUIRED_OUTPUTS) {
		if (!existsSync(resolve(distRoot, relativeOutput))) {
			throw new Error(`Missing required build output: dist/${relativeOutput}`);
		}
	}
	if (existsSync(resolve(distRoot, 'src'))) {
		throw new Error('Build output must not contain dist/src.');
	}
	for (const filePath of walkFiles(distRoot)) {
		if (filePath.includes('.ts-run-')) throw new Error(`Build output contains temporary ts runner artifact: ${filePath}`);
		if (filePath.endsWith('.d.js')) throw new Error(`Build output contains invalid declaration artifact: ${filePath}`);
	}
}

function copySdkRuntimeArtifacts() {
	const sdkRoot = resolve(packageRoot, 'node_modules', '@treeseed', 'sdk');
	const sdkVendorRoot = resolve(distRoot, 'node_modules', '@treeseed', 'sdk');
	const sdkPackageJson = resolve(sdkRoot, 'package.json');
	if (!existsSync(sdkPackageJson)) return;
	const requiredSdkOutputs = [
		resolve(sdkRoot, 'dist', 'index.js'),
		resolve(sdkRoot, 'dist', 'api', 'index.js'),
		resolve(sdkRoot, 'drizzle', 'market'),
	];
	for (const requiredOutput of requiredSdkOutputs) {
		if (!existsSync(requiredOutput)) {
			throw new Error(`Installed @treeseed/sdk is missing required runtime artifact: ${relative(sdkRoot, requiredOutput)}`);
		}
	}
	mkdirSync(sdkVendorRoot, { recursive: true });
	copyFileSync(sdkPackageJson, resolve(sdkVendorRoot, 'package.json'));
	cpSync(resolve(sdkRoot, 'dist'), resolve(sdkVendorRoot, 'dist'), { recursive: true });
	cpSync(resolve(sdkRoot, 'drizzle'), resolve(sdkVendorRoot, 'drizzle'), { recursive: true });
}

rmSync(distRoot, { recursive: true, force: true });

for (const filePath of walkFiles(srcRoot)) {
	const extension = extname(filePath);
	if (filePath.endsWith('.d.ts')) copyAsset(filePath, srcRoot, distRoot);
	else if (JS_SOURCE_EXTENSIONS.has(extension)) await compileModule(filePath, srcRoot, distRoot);
	else if (COPY_EXTENSIONS.has(extension)) copyAsset(filePath, srcRoot, distRoot);
}

for (const filePath of walkFiles(scriptsRoot)) {
	if (filePath.endsWith('.ts') || filePath.endsWith('.mjs')) transpileScript(filePath);
}

emitDeclarations();
copySdkRuntimeArtifacts();
assertRequiredOutputs();
