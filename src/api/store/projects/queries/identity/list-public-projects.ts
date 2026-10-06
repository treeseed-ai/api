import { type ControlPlaneStore, serializeProject, type ProjectRow } from '../../../../persistence/store.ts';

function isPublic(project: any) {
	const metadata = project?.metadata ?? {};
	const declared = metadata.metadata ?? {};
	return String(declared.visibility ?? metadata.visibility ?? 'private').toLowerCase() === 'public';
}

export async function listPublicProjectsMethod(this: ControlPlaneStore) {
	await this.ensureInitialized();
	const rows = await this.all<ProjectRow>('SELECT * FROM projects ORDER BY created_at ASC');
	return rows.map(serializeProject).filter((project) => project?.metadata?.deletion?.status !== 'succeeded' && isPublic(project));
}
