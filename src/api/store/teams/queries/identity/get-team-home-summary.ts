import { MarketControlPlaneStore,parseJson } from "../../../../persistence/store.ts";
export async function getTeamHomeSummaryMethod(this: MarketControlPlaneStore, teamId, principal = null, capacity) {
    const team = await this.getTeam(teamId);
    if (!team) {
        return null;
    }
    if (principal && !(await this.principalCanAccessTeam(principal, teamId))) {
        return null;
    }
    const [members, projects, products, inbox, pendingInvitations, services, auditEvents, access, contentActivityRows] = await Promise.all([
        this.listTeamMembers(teamId),
        this.listTeamProjects(teamId),
        this.listTeamProducts(teamId, principal),
        this.listTeamInboxItems(teamId, principal),
        this.listTeamInvites(teamId),
        this.listTeamServiceConnections(teamId),
        this.listAuditEventsForTarget('team', teamId, 12),
        this.getTeamAccessSummary(teamId, principal),
        this.all(`SELECT current_event.id,
                current_event.content_type,
                current_event.project_id,
                current_event.resource_id,
                current_event.created_at,
                CASE WHEN current_event.created_at || ':' || current_event.id
                    > first_publication.first_sort_key THEN 1 ELSE 0 END AS is_update
           FROM notification_events AS current_event
           INNER JOIN projects ON projects.id = current_event.project_id
           INNER JOIN (
                SELECT project_id, content_type, resource_id,
                       MIN(created_at || ':' || id) AS first_sort_key
                  FROM notification_events
                 GROUP BY project_id, content_type, resource_id
           ) AS first_publication
             ON first_publication.project_id = current_event.project_id
            AND first_publication.content_type = current_event.content_type
            AND first_publication.resource_id = current_event.resource_id
          WHERE projects.team_id = ?
          ORDER BY current_event.created_at DESC, current_event.id DESC
          LIMIT 720`, [teamId]),
    ]);
    const projectSummaries = (await Promise.all(projects.map((project) => this.getProjectSummary(project.id, principal)))).filter(Boolean);
    const publishedProducts = products.filter((item) => item.visibility === 'public' && item.listingEnabled);
    const agentSummaries = await Promise.all(projects.map((project) => capacity.getProjectAgentsSummary(project.id, principal)));
    const activeAgents = agentSummaries.flatMap((summary) => Array.isArray(summary?.agents)
        ? summary.agents.filter((agent) => ['active', 'running', 'ready'].includes(String(agent?.status ?? '').toLowerCase()))
        : []);
    const actorUserIds = [...new Set(auditEvents
        .filter((event) => event.actorType === 'user' && typeof event.actorId === 'string')
        .map((event) => event.actorId))];
    const actorUsers = actorUserIds.length > 0
        ? await this.all(`SELECT users.id, users.display_name, users.email, users.username, users.metadata_json,
                user_identities.profile_json
              FROM users
              LEFT JOIN user_identities ON user_identities.user_id = users.id
             WHERE users.id IN (${actorUserIds.map(() => '?').join(', ')})
             ORDER BY users.id, user_identities.updated_at DESC`, actorUserIds)
        : [];
    const actorByUserId = new Map();
    for (const actor of actorUsers) {
        if (!actorByUserId.has(actor.id)) actorByUserId.set(actor.id, actor);
    }
    const projectedAuditEvents = auditEvents.map((event) => {
        const actor = event.actorType === 'user' ? actorByUserId.get(event.actorId) : null;
        const identityProfile = parseJson(actor?.profile_json, {});
        const accountProfile = parseJson(actor?.metadata_json, {});
        return {
            ...event,
            actor: {
                type: event.actorType,
                displayName: actor?.display_name ?? null,
                email: actor?.email ?? null,
                username: actor?.username ?? null,
                image: typeof accountProfile.image === 'string'
                    ? accountProfile.image
                    : typeof identityProfile.image === 'string' ? identityProfile.image : null,
            },
        };
    });
    const contentTypes = new Set(['questions', 'objectives', 'notes', 'proposals', 'decisions', 'agents']);
    const contentActivity = contentActivityRows
        .map((event) => ({
            id: event.id,
            timestamp: Date.parse(String(event.created_at)),
            type: event.content_type,
            action: Number(event.is_update) === 1 ? 'updated' : 'created',
        }))
        .filter((event) => Number.isFinite(event.timestamp) && contentTypes.has(String(event.type)))
        .reverse();
    return {
        team,
        members,
        counts: {
            projects: projects.length,
            activeAgents: activeAgents.length,
            liveListings: publishedProducts.length,
            inbox: inbox.length,
            members: members.length,
            pendingInvitations: pendingInvitations.length,
            services: services.length,
        },
        access,
        pendingInvitations,
        operational: {
            projects: { count: projects.length, href: '/app/projects' },
            services: { label: 'Services', count: services.length, href: '/app/services' },
            capacity: { count: activeAgents.length, href: '/app/capacity' },
            knowledge: { count: inbox.length, href: '/app/knowledge' },
            catalog: { count: publishedProducts.length, href: '/app/market' },
        },
        contentActivity,
        auditEvents: projectedAuditEvents,
        continueWorking: projectSummaries.slice(0, 6),
        activeAgents,
        publishedProducts,
        inbox,
    };
}
