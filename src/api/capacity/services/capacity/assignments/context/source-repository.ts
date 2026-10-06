import { CapacityGovernanceError } from '../../../../database.ts';

/** Source custody is explicit. A knowledge-library binding is never a substitute for project code. */
export function selectAssignmentSourceRepository(repositories: Array<Record<string, unknown>>) {
	const sources = repositories.filter(repository => ['software', 'primary', 'package'].includes(String(repository.role)));
	if (sources.length !== 1) throw new CapacityGovernanceError('assignment_source_repository_required',
		'Assignment source access requires exactly one explicit primary software repository.', 409);
	const repository = sources[0]!;
	const id = String(repository.id ?? ''), owner = String(repository.owner ?? ''), name = String(repository.name ?? '');
	const ref = String(repository.currentBranch ?? repository.defaultBranch ?? '');
	if (!id || repository.provider !== 'github' || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/u.test(owner)
		|| !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,99}$/u.test(name) || !ref || ref.startsWith('-')
		|| ref.includes('..') || /[\s~^:?*\[\\\x00-\x1f\x7f]/u.test(ref) || ref.includes('@{')
		|| ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.') || ref.endsWith('.lock')) {
		throw new CapacityGovernanceError('assignment_source_repository_invalid', 'The configured software repository or source ref is invalid.', 409);
	}
	// Derive transport from the verified provider tuple, never arbitrary URLs or userinfo.
	return { id, provider: 'github' as const, owner, name, ref, cloneUrl: `https://github.com/${owner}/${name}.git` };
}
