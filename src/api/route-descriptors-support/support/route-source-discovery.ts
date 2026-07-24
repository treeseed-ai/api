import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

export const appSourcePath = sourcePathFor('support/app');

export const projectDeploymentRoutesSourcePath = sourcePathFor('projects/deployments/project-deployment-routes');

function executableFiles(directory, extension) {
    return readdirSync(directory, { withFileTypes: true })
        .flatMap((entry) => {
            const path = resolve(directory, entry.name);
            return entry.isDirectory()
                ? executableFiles(path, extension)
                : entry.name.endsWith(extension) && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.d.js')
                    ? [path]
                    : [];
        });
}

export function capacityRouteSourcePaths() {
    const sourceDirectory = resolve(packageRoot, 'src/api/capacity/routes');
    const directory = existsSync(sourceDirectory)
        ? sourceDirectory
        : resolve(packageRoot, 'dist/api/capacity/routes');
    const entries = executableFiles(directory, '.ts');
    // Keep TypeScript suffixes out of a single string literal because the package
    // build's runtime-specifier rewrite intentionally converts quoted `.ts` suffixes.
    const tsExtension = ['.', 't', 's'].join('');
    const extension = entries.length > 0
        ? tsExtension
        : '.js';
    return executableFiles(directory, extension).sort();
}

export function applicationRouteSourcePaths() {
    const source = readFileSync(appSourcePath, 'utf8');
    return [...source.matchAll(/from ['"](\.\.\/routes\/[^'"]+)['"]/gu)]
        .map((match) => resolve(dirname(appSourcePath), match[1]))
        .map((path) => {
            const typescriptPath = path.replace(/\.js$/u, '.ts');
            return existsSync(typescriptPath) ? typescriptPath : path;
        })
        .sort();
}
