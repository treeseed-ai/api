import { ensurePrincipal,jsonError,requireTeamAccess } from '../../index.ts';
import type { ControlPlaneStore } from '../../../../persistence/store.ts';
function normalizeRepositorySlug(value: unknown) {
    const text = String(value ?? '').trim().toLowerCase();
    return text.includes('/') ? text : null;
}
export function markdownToPlainProjectSummary(markdown: unknown, fallback: string | null = null) {
    const text = String(markdown ?? '')
        .replace(/^---[\s\S]*?---/u, ' ')
        .replace(/```[\s\S]*?```/gu, ' ')
        .replace(/`([^`]+)`/gu, '$1')
        .replace(/!\[[^\]]*\]\([^)]+\)/gu, ' ')
        .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
        .replace(/^#{1,6}\s+/gmu, '')
        .replace(/^\s*[-*+]\s+/gmu, '')
        .replace(/^\s*\d+\.\s+/gmu, '')
        .replace(/[*_~>#]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim();
    if (!text)
        return fallback;
    return text.length > 240 ? `${text.slice(0, 237).trimEnd()}...` : text;
}
export function projectAllowedCiRepositories(projectDetails: Pick<NonNullable<Awaited<ReturnType<ControlPlaneStore['getProjectDetails']>>>, 'repositories'>) {
    const slugs = new Set();
    for (const repository of projectDetails.repositories ?? []) {
        if (repository.role !== 'software')
            continue;
        const slug = normalizeRepositorySlug(`${repository.owner}/${repository.name}`);
        if (slug)
            slugs.add(slug);
    }
    return slugs;
}
export async function resolveUiProjectionContext(c: Parameters<typeof ensurePrincipal>[0], store: Pick<ControlPlaneStore, 'listTeamsForPrincipal' | 'listTeamProjects'>) {
    const auth = await ensurePrincipal(c);
    if (auth.response)
        return auth;
    const teams = await store.listTeamsForPrincipal(auth.principal).catch(() => []);
    const activeTeam = teams[0] ?? null;
    const projects = activeTeam ? await store.listTeamProjects(activeTeam.id).catch(() => []) : [];
    return {
        principal: auth.principal,
        teams,
        activeTeam,
        projects,
    };
}
export async function requireProjectAccess(c: Parameters<typeof ensurePrincipal>[0], store: ControlPlaneStore, projectId: string, permission: string | null = null) {
    const auth = await ensurePrincipal(c);
    if (auth.response) {
        return auth;
    }
    const details = await store.getProjectDetails(projectId);
    if (!details) {
        return {
            response: jsonError(c, 404, `Unknown project "${projectId}".`),
        };
    }
    const access = await requireTeamAccess(c, store, details.project.teamId, permission);
    if (access.response) {
        return access;
    }
    return {
        principal: access.principal,
        details,
    };
}
export async function projectAppHref(_store: unknown, _teamId: unknown, _projectSlug: string | null | undefined, section: unknown) {
    if (section === 'share')
        return '/app/knowledge/artifacts';
    return _projectSlug ? `/app/projects/${encodeURIComponent(_projectSlug)}` : '/app/projects';
}
