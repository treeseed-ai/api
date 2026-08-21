import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { chmodSync,copyFileSync,cpSync,existsSync,mkdirSync,readdirSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { dirname,extname,join,relative,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { packageRoot } from '../packages/package-tools.ts';

const srcRoot = resolve(packageRoot, 'src');
const scriptsRoot = resolve(packageRoot, 'scripts');
const distRoot = resolve(packageRoot, 'dist');

const JS_SOURCE_EXTENSIONS = new Set(['.ts']);
const COPY_EXTENSIONS = new Set(['.d.ts', '.json', '.jsonc', '.md', '.yaml', '.yml']);
const EXECUTABLE_OUTPUTS = new Set([
	'api/support/server.js',
	'operations-runner/entrypoint.js',
	'scripts/support/migrate-db.js',
]);
const REQUIRED_OUTPUTS = [
	'index.js',
	'index.d.ts',
	'api/support/app.js',
	'api/support/server.js',
	'api/persistence/store.js',
	'api/support/control-plane-postgres.js',
	'api/support/route-descriptors.js',
	'admin-api-descriptor.json',
	'operations-runner/entrypoint.js',
	'scripts/support/migrate-db.js',
];

function walkFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
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
	return resolve(outputRoot, relativePath.replace(/\.ts$/u, '.js'));
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
	const outputFile = resolve(distRoot, 'scripts', relativePath.replace(/\.ts$/u, '.js'));
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
		if (filePath.endsWith('.d.js')) throw new Error(`Build output contains invalid declaration artifact: ${filePath}`);
	}
}

async function assertCapacityRouteDescriptorCoverage() {
	const routeRoot = resolve(distRoot, 'api', 'capacity', 'routes');
	const routeFiles = walkFiles(routeRoot).filter((filePath) => filePath.endsWith('.js') && !filePath.endsWith('.d.js'));
	const declarations: Array<{ method: string; path: string; filePath: string }> = [];
	for (const filePath of routeFiles) {
		const source = readFileSync(filePath, 'utf8');
		if (/app\.(get|post|put|patch|delete)\(\s*`/u.test(source)) {
			throw new Error(`Capacity route registrations must use literal quoted paths so descriptor discovery is complete: ${relative(distRoot, filePath)}`);
		}
		for (const match of source.matchAll(/app\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/gu)) {
			if (match[2].startsWith('/v1')) declarations.push({ method: match[1].toUpperCase(), path: match[2], filePath });
		}
	}
	const descriptorModuleUrl = `${pathToFileURL(resolve(distRoot, 'api', 'support', 'route-descriptors.js')).href}?build=${Date.now()}`;
	const descriptorModule = await import(descriptorModuleUrl) as { API_ROUTE_DESCRIPTORS: Array<{ method: string; path: string }> };
	const descriptorKeys = new Set(descriptorModule.API_ROUTE_DESCRIPTORS.map((entry) => `${entry.method} ${entry.path}`));
	for (const declaration of declarations) {
		if (!descriptorKeys.has(`${declaration.method} ${declaration.path}`)) {
			throw new Error(`Built route descriptor inventory omitted ${declaration.method} ${declaration.path} from ${relative(distRoot, declaration.filePath)}.`);
		}
	}
}

async function writeAdminApiDescriptorArtifact() {
	const descriptorModuleUrl = `${pathToFileURL(resolve(distRoot, 'api', 'support', 'route-descriptors.js')).href}?artifact=${Date.now()}`;
	const descriptorModule = await import(descriptorModuleUrl) as { API_ROUTE_DESCRIPTORS: Array<Record<string, unknown>> };
	const routes = [...descriptorModule.API_ROUTE_DESCRIPTORS].sort((left, right) => String(left.id).localeCompare(String(right.id)));
	const adminRoutes = routes.filter((route) => route.runtimePlane === 'admin');
	const routesJson = JSON.stringify(routes);
	const digest = createHash('sha256').update(routesJson).digest('hex');
	const packageMetadata = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as { version: string };
	writeFileSync(resolve(distRoot, 'admin-api-descriptor.json'), `${JSON.stringify({
		schemaVersion: 'treeseed.admin-api-descriptor/v1',
		package: '@treeseed/api',
		version: packageMetadata.version,
		sourceRef: process.env.TREESEED_SOURCE_REF?.trim() || null,
		digest: `sha256:${digest}`,
		routeCount: routes.length,
		adminRouteCount: adminRoutes.length,
		migrationReady: true,
		routes,
	}, null, 2)}\n`, 'utf8');
}

function preparedSdkPackageRoot(installedSdkRoot: string) {
	if (existsSync(resolve(installedSdkRoot, 'dist', 'index.js'))) {
		return { root: installedSdkRoot, cleanup: () => {} };
	}
	throw new Error('@treeseed/api requires the installed semantic @treeseed/sdk package to contain its published runtime artifacts.');
}

function copySdkRuntimeArtifacts() {
	const sdkRoot = resolve(packageRoot, 'node_modules', '@treeseed', 'sdk');
	const sdkVendorRoot = resolve(distRoot, 'node_modules', '@treeseed', 'sdk');
	const sdkPackage = preparedSdkPackageRoot(sdkRoot);
	const copyRuntimeArtifact = (source: string, destination: string) => {
		cpSync(source, destination, {
			recursive: true,
			filter: (entry) => !entry.endsWith('.d.js'),
		});
	};
	try {
		const sdkPackageJson = resolve(sdkPackage.root, 'package.json');
		if (!existsSync(sdkPackageJson)) return;
		const requiredSdkOutputs = [
			resolve(sdkPackage.root, 'dist', 'index.js'),
		];
		for (const requiredOutput of requiredSdkOutputs) {
			if (!existsSync(requiredOutput)) {
				throw new Error(`@treeseed/sdk is missing required runtime artifact: ${relative(sdkPackage.root, requiredOutput)}`);
			}
		}
		mkdirSync(sdkVendorRoot, { recursive: true });
		copyFileSync(sdkPackageJson, resolve(sdkVendorRoot, 'package.json'));
		copyRuntimeArtifact(resolve(sdkPackage.root, 'dist'), resolve(sdkVendorRoot, 'dist'));
	} finally {
		sdkPackage.cleanup();
	}
}

rmSync(distRoot, { recursive: true, force: true });

for (const filePath of walkFiles(srcRoot)) {
	const extension = extname(filePath);
	if (filePath.endsWith('.d.ts')) copyAsset(filePath, srcRoot, distRoot);
	else if (JS_SOURCE_EXTENSIONS.has(extension)) await compileModule(filePath, srcRoot, distRoot);
	else if (COPY_EXTENSIONS.has(extension)) copyAsset(filePath, srcRoot, distRoot);
}

for (const filePath of walkFiles(scriptsRoot)) {
	if (filePath.endsWith('.ts')) transpileScript(filePath);
}

emitDeclarations();
copySdkRuntimeArtifacts();
await assertCapacityRouteDescriptorCoverage();
await writeAdminApiDescriptorArtifact();
assertRequiredOutputs();
