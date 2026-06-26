import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import ts from 'typescript';
import { packageRoot } from './package-tools.ts';

const srcRoot = resolve(packageRoot, 'src');
const scriptsRoot = resolve(packageRoot, 'scripts');
const distRoot = resolve(packageRoot, 'dist');

const JS_SOURCE_EXTENSIONS = new Set(['.ts']);
const COPY_EXTENSIONS = new Set(['.d.ts', '.json', '.jsonc', '.md', '.yaml', '.yml']);
const EXECUTABLE_OUTPUTS = new Set([
	'api/server.js',
	'operations-runner/entrypoint.js',
	'scripts/migrate-db.js',
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
	'operations-runner/entrypoint.js',
	'operations-runner/project-web-deployment-executor.js',
	'scripts/migrate-db.js',
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

function packageJson() {
	return JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
		dependencies?: Record<string, string>;
	};
}

function sdkGitRef(spec: string) {
	const match = spec.match(/#(.+)$/u);
	return match?.[1]?.trim() || 'staging';
}

function preparedSdkPackageRoot(installedSdkRoot: string) {
	if (existsSync(resolve(installedSdkRoot, 'dist', 'index.js')) && existsSync(resolve(installedSdkRoot, 'dist', 'api', 'index.js'))) {
		return { root: installedSdkRoot, cleanup: () => {} };
	}
	const workspaceSdkRoot = resolve(packageRoot, '..', 'sdk');
	if (existsSync(resolve(workspaceSdkRoot, 'package.json')) && existsSync(resolve(workspaceSdkRoot, 'dist', 'index.js')) && existsSync(resolve(workspaceSdkRoot, 'dist', 'api', 'index.js'))) {
		return { root: workspaceSdkRoot, cleanup: () => {} };
	}
	const sdkSpec = packageJson().dependencies?.['@treeseed/sdk'];
	if (!sdkSpec) throw new Error('@treeseed/api requires @treeseed/sdk to vendor runtime artifacts.');
	const tempRoot = mkdtempSync(resolve(tmpdir(), 'treeseed-api-sdk-pack-'));
	const sourceRoot = resolve(tempRoot, 'sdk');
	const clone = spawnSync('git', ['clone', '--filter=blob:none', 'https://github.com/treeseed-ai/sdk.git', sourceRoot], {
		cwd: packageRoot,
		encoding: 'utf8',
		shell: process.platform === 'win32',
	});
	if (clone.status !== 0) {
		rmSync(tempRoot, { recursive: true, force: true });
		throw new Error(`Unable to clone @treeseed/sdk runtime dependency.\n${clone.stdout}\n${clone.stderr}`);
	}
	const checkout = spawnSync('git', ['checkout', sdkGitRef(sdkSpec)], {
		cwd: sourceRoot,
		encoding: 'utf8',
		shell: process.platform === 'win32',
	});
	if (checkout.status !== 0) {
		rmSync(tempRoot, { recursive: true, force: true });
		throw new Error(`Unable to checkout @treeseed/sdk runtime dependency ref ${sdkGitRef(sdkSpec)}.\n${checkout.stdout}\n${checkout.stderr}`);
	}
	const install = spawnSync('npm', ['install', '--workspaces=false', '--ignore-scripts'], {
		cwd: sourceRoot,
		encoding: 'utf8',
		shell: process.platform === 'win32',
		env: {
			...process.env,
			TREESEED_SKIP_PACKAGE_PREPARE: '1',
		},
	});
	if (install.status !== 0) {
		rmSync(tempRoot, { recursive: true, force: true });
		throw new Error(`Unable to install @treeseed/sdk runtime dependency build dependencies.\n${install.stdout}\n${install.stderr}`);
	}
	const buildSdk = spawnSync('npm', ['run', 'build:dist'], {
		cwd: sourceRoot,
		encoding: 'utf8',
		shell: process.platform === 'win32',
	});
	if (buildSdk.status !== 0) {
		rmSync(tempRoot, { recursive: true, force: true });
		throw new Error(`Unable to build @treeseed/sdk runtime dependency.\n${buildSdk.stdout}\n${buildSdk.stderr}`);
	}
	return {
		root: sourceRoot,
		cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
	};
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
			resolve(sdkPackage.root, 'dist', 'api', 'index.js'),
			resolve(sdkPackage.root, 'drizzle', 'market'),
		];
		for (const requiredOutput of requiredSdkOutputs) {
			if (!existsSync(requiredOutput)) {
				throw new Error(`@treeseed/sdk is missing required runtime artifact: ${relative(sdkPackage.root, requiredOutput)}`);
			}
		}
		mkdirSync(sdkVendorRoot, { recursive: true });
		copyFileSync(sdkPackageJson, resolve(sdkVendorRoot, 'package.json'));
		copyRuntimeArtifact(resolve(sdkPackage.root, 'dist'), resolve(sdkVendorRoot, 'dist'));
		copyRuntimeArtifact(resolve(sdkPackage.root, 'drizzle'), resolve(sdkVendorRoot, 'drizzle'));
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
assertRequiredOutputs();
