import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url));

export function findPackageRoot(start) {
    let current = start;
    while (current !== dirname(current)) {
        if (existsSync(resolve(current, 'package.json')) && existsSync(resolve(current, 'src/api'))) {
            return current;
        }
        current = dirname(current);
    }
    return start;
}

export const packageRoot = findPackageRoot(here);

export function sourcePathFor(baseName) {
    const tsPath = resolve(here, `${baseName}.ts`);
    if (existsSync(tsPath))
        return tsPath;
    const packageTsPath = resolve(packageRoot, 'src/api', `${baseName}.ts`);
    if (existsSync(packageTsPath))
        return packageTsPath;
    const jsPath = resolve(here, `${baseName}.js`);
    if (existsSync(jsPath))
        return jsPath;
    return resolve(packageRoot, 'src/api', `${baseName}.js`);
}

export const appSourcePath = sourcePathFor('app');

export const projectDeploymentRoutesSourcePath = sourcePathFor('project-deployment-routes');

export function capacityRouteSourcePaths() {
    const sourceDirectory = resolve(packageRoot, 'src/api/capacity/routes');
    const directory = existsSync(sourceDirectory)
        ? sourceDirectory
        : resolve(packageRoot, 'dist/api/capacity/routes');
    const entries = readdirSync(directory);
    // Keep TypeScript suffixes out of a single string literal because the package
    // build's runtime-specifier rewrite intentionally converts quoted `.ts` suffixes.
    const tsExtension = ['.', 't', 's'].join('');
    const declarationExtension = ['.', 'd', '.', 't', 's'].join('');
    const extension = entries.some((name) => name.endsWith(tsExtension) && !name.endsWith(declarationExtension))
        ? tsExtension
        : '.js';
    return entries
        .filter((name) => name.endsWith(extension) && !name.endsWith('.d.js'))
        .map((name) => resolve(directory, name))
        .sort();
}

export function applicationRouteSourcePaths() {
    const sourceDirectory = resolve(packageRoot, 'src/api/routes');
    const directory = existsSync(sourceDirectory)
        ? sourceDirectory
        : resolve(packageRoot, 'dist/api/routes');
    const entries = readdirSync(directory);
    const extension = entries.some((name) => name.endsWith('.ts')) ? '.ts' : '.js';
    return entries
        .filter((name) => name.endsWith(extension) && !name.endsWith('.d.ts') && !name.endsWith('.d.js'))
        .map((name) => resolve(directory, name))
        .sort();
}
