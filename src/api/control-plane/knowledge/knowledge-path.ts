export function allowedKnowledgePath(workspace: { allowedPaths: string[] }, path: string) {
	return Boolean(path && !path.startsWith('/') && !path.split('/').some((part) => !part || part === '.' || part === '..')
		&& workspace.allowedPaths.some((pattern) => path.startsWith(pattern.replace(/\*\*$/u, ''))));
}
