import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { governanceVotingProvider } from '@treeseed/sdk';
import { containsPlaintextSecretMaterial, validateClientEncryptedEscrowMetadata, validateSecretsCapabilityRegistry, validateWritableSecretMetadata, } from '@treeseed/sdk/secrets-capability';
import { redactDeploymentValue } from "../../../../../market/hosting/deployment-actions.ts";
import { projectDeploymentAuditPayload } from "../../../../../market/governance/policy/deployment-governance.ts";
import { getNodeBuiltin, safeStoragePathSegment, safeIdPart, artifactStorageRoot, isoNow, parseJson, missingSchemaError, objectValue, arrayValue, governanceContentHash, governanceSlug, PROJECT_ARCHITECTURE_TOPOLOGIES, CONTENT_RUNTIME_SOURCES, LOCAL_CONTENT_MATERIALIZATIONS, CONTENT_PUBLISH_TARGETS, LEGACY_PROJECT_TOPOLOGIES, projectArchitectureError, normalizeProjectPath, normalizeProjectContentPublishTarget, normalizeProjectArchitecture, projectArchitectureContentSource, stringValue, optionalStringValue, numberValue, enumValue, requireEnumValue, stableHash, equalHash, tokenPrefix, normalizeOperationCapabilities, COMMERCE_PRODUCT_KINDS, COMMERCE_OFFER_MODES, COMMERCE_VENDOR_TRUST_LEVELS, COMMERCE_GOVERNANCE_STATES, COMMERCE_OWNERSHIP_MODELS, COMMERCE_STEWARDSHIP_ROLES, COMMERCE_STRIPE_ACCOUNT_STATUSES, COMMERCE_STRIPE_ONBOARDING_STATUSES, COMMERCE_STRIPE_ENVIRONMENTS, COMMERCE_STRIPE_SYNC_STATUSES, COMMERCE_ENTITLEMENT_STATUSES, COMMERCE_CART_STATUSES, COMMERCE_CHECKOUT_STATUSES, COMMERCE_ORDER_STATUSES, COMMERCE_ORDER_ITEM_STATUSES, COMMERCE_SUBSCRIPTION_STATUSES, COMMERCE_PAYMENT_GROUP_STATUSES, COMMERCE_WEBHOOK_EVENT_STATUSES, COMMERCE_REFUND_STATUSES, COMMERCE_FULFILLMENT_STATUSES, COMMERCE_FULFILLMENT_EVENT_TYPES, COMMERCE_SERVICE_REQUEST_STATUSES, COMMERCE_SERVICE_QUOTE_STATUSES, COMMERCE_SERVICE_CONTRACT_STATUSES, COMMERCE_SERVICE_EVENT_TYPES, COMMERCE_CAPACITY_LISTING_STATUSES, COMMERCE_CAPACITY_INQUIRY_STATUSES, COMMERCE_CAPACITY_ACCESS_LEVELS, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVELS, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVELS, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVELS, COMMERCE_CAPACITY_DATA_ACCESS_LEVELS, COMMERCE_CAPACITY_SECRET_ACCESS_LEVELS, COMMERCE_PRODUCT_KIND_SET, COMMERCE_OFFER_MODE_SET, COMMERCE_VENDOR_TRUST_LEVEL_SET, COMMERCE_GOVERNANCE_STATE_SET, COMMERCE_OWNERSHIP_MODEL_SET, COMMERCE_STEWARDSHIP_ROLE_SET, COMMERCE_STRIPE_ACCOUNT_STATUS_SET, COMMERCE_STRIPE_ONBOARDING_STATUS_SET, COMMERCE_STRIPE_ENVIRONMENT_SET, COMMERCE_STRIPE_SYNC_STATUS_SET, COMMERCE_ENTITLEMENT_STATUS_SET, COMMERCE_CART_STATUS_SET, COMMERCE_CHECKOUT_STATUS_SET, COMMERCE_ORDER_STATUS_SET, COMMERCE_ORDER_ITEM_STATUS_SET, COMMERCE_SUBSCRIPTION_STATUS_SET, COMMERCE_PAYMENT_GROUP_STATUS_SET, COMMERCE_WEBHOOK_EVENT_STATUS_SET, COMMERCE_REFUND_STATUS_SET, COMMERCE_FULFILLMENT_STATUS_SET, COMMERCE_FULFILLMENT_EVENT_TYPE_SET, COMMERCE_SERVICE_REQUEST_STATUS_SET, COMMERCE_SERVICE_QUOTE_STATUS_SET, COMMERCE_SERVICE_CONTRACT_STATUS_SET, COMMERCE_SERVICE_EVENT_TYPE_SET, COMMERCE_CAPACITY_LISTING_STATUS_SET, COMMERCE_CAPACITY_INQUIRY_STATUS_SET, COMMERCE_CAPACITY_ACCESS_LEVEL_SET, COMMERCE_CAPACITY_RUNTIME_ISOLATION_LEVEL_SET, COMMERCE_CAPACITY_HUMAN_INVOLVEMENT_LEVEL_SET, COMMERCE_CAPACITY_AI_INVOLVEMENT_LEVEL_SET, COMMERCE_CAPACITY_DATA_ACCESS_LEVEL_SET, COMMERCE_CAPACITY_SECRET_ACCESS_LEVEL_SET, COMMERCE_VISIBILITY_SET, COMMERCE_FULFILLMENT_MODE_SET, COMMERCE_PRICE_STATUS_SET, COMMERCE_PRICE_INTERVAL_SET, COMMERCE_TAX_BEHAVIOR_SET, COMMERCE_COMMERCIAL_OFFER_MODES, COMMERCE_ZERO_PRICE_OFFER_MODES, COMMERCE_CAPACITY_LISTING_OFFER_MODES, principalIsAdmin, TEAM_ROLE_CAPABILITIES, TEAM_ROLE_DESCRIPTIONS, ALL_TEAM_CAPABILITIES, CAPABILITY_PERMISSIONS, TEAM_DELETION_CONFIRMATION_PREFIX, TEAM_MANAGEMENT_ROLES, TEAM_RESERVED_NAMES, COMMONS_TEAM_SLUG, COMMONS_WEIGHT_POLICY_VERSION, COMMONS_BACKING_THRESHOLD, COMMONS_WEIGHT_THRESHOLD, COMMONS_TOTAL_WEIGHT_CAP, COMMONS_DELEGATED_WEIGHT_CAP, normalizeTeamName, validateTeamName, teamDeletionConfirmationMatches, projectDeletionConfirmationMatches, normalizeProjectSlug, validateProjectSlug, normalizeBaseUrl, signAssertionPayload, uniqueCapabilities, normalizeTeamRoleKey, primaryTeamRole, projectConnectionModeFromHosting, serializeTeam, teamIsPrivate, centralTreeDxRegistryUrl, normalizeAllocationSlices, serializeTeamMember, serializeTeamWebHost, SUPPORTED_TEAM_HOST_PROVIDERS, normalizedStrings, serializeApprovalRequest, serializeCommonsParticipant, serializeCommonsQuestion, serializeCommonsProposal, serializeCommonsWeightSnapshot, serializeCommonsProposalBacking, serializeCommonsProposalVote, serializeCommonsDelegation, serializeCommonsDecision, serializeCommonsGovernanceEvent, serializeGovernancePolicy, serializeGovernanceProposal, serializeGovernanceElectorateSnapshot, serializeGovernanceVote, serializeGovernanceDelegation, serializeGovernanceDecision, serializeGovernanceEvent, serializeSeedRun, serializeTeamInvite, serializeProject, isoDate, compareDatesDesc, latestDate, uniqueStrings, PROJECT_DEPLOYMENT_TERMINAL_STATUSES, PROJECT_DEPLOYMENT_ACTIVE_STATUSES, normalizeProjectDeploymentStatus, deploymentKindForAction, summarizeProjectHealth, summarizeDeploymentStatus, toActivityItem, serializeConnection, serializeRepositoryHost, serializeHubRepository, serializeHubContentSource, serializeTreeDxInstance, serializeTreeDxProjectLibrary, serializeTreeDxMirror, serializeTreeDxShare, serializeTreeDxDeployment, serializeHubLaunch, serializeHubLaunchEvent, serializeHubWorkspaceLink, serializeProjectUpdatePlan, serializeProviderCredentialSession, serializeCapability, serializeEntitlement, serializeJob, serializeJobEvent, serializePlatformOperation, serializePlatformOperationEvent, serializeMarketOperationRunner, serializePlatformRepositoryClaim, platformRepositoryKey, platformRepositoryWorkspacePath, serializeAuditEvent, serializeSecretMetadataRecord, serializeClientEncryptedEscrowRecord, serializeGitHubRepositoryGrant, serializeGitHubAppInstallationRecord, serializeGitHubAppTokenIssuanceRecord, serializeWorkflowOperationRecord, serializeWorkflowDispatchRecord, serializeTreeDxCredentialIssuanceRecord, secretCapabilityValidationError, rejectSecretCapabilityPlaintext, serializeKnowledgePack, serializeTeamStorageLocator, serializeCatalogItem, serializeCatalogArtifactVersion, serializeCommerceVendor, serializeCommerceVendorStripeAccount, serializeCommerceProduct, serializeCommerceOwnershipRecord, serializeCommerceStewardshipAssignment, serializeCommerceContribution, serializeCommerceGovernancePolicy, serializeCommerceOwnershipTransfer, serializeCommerceSuccessionEvent, serializeCommerceOwnershipWorkflowSummary, serializeCommerceProductVersion, serializeCommerceOffer, serializeCommercePrice, serializeCommerceGovernanceEvent, serializeCommerceCart, serializeCommerceCartItem, serializeCommerceCheckout, serializeCommerceOrder, serializeCommerceOrderItem, serializeCommerceRefund, serializeCommerceFulfillmentEvent, serializeCommerceServiceRequest, serializeCommerceServiceQuote, serializeCommerceServiceContract, serializeCommerceServiceEvent, serializeCommerceCapacityListing, serializeCommerceCapacityListingInquiry, redactBuyerUserId, serializeCommerceVendorOrderSummary, serializeCommercePaymentGroup, serializeCommerceSubscription, serializeCommerceEntitlement, serializeCommerceBuyerStripeCustomer, serializeCommerceWebhookEvent, serializeProjectHosting, serializeProjectEnvironment, serializeProjectInfrastructureResource, serializeProjectDeployment, serializeProjectDeploymentEvent, serializeTeamInboxItem, serializeProjectSummarySnapshot, MarketControlPlaneStore } from "../../../../persistence/store.ts";
export async function getTeamHomeSummaryMethod(this: MarketControlPlaneStore, teamId, principal = null, capacity) {
    const team = await this.getTeam(teamId);
    if (!team) {
        return null;
    }
    if (principal && !(await this.principalCanAccessTeam(principal, teamId))) {
        return null;
    }
    const [members, projects, products, inbox, pendingInvitations, hosts, auditEvents, access, contentActivityRows] = await Promise.all([
        this.listTeamMembers(teamId),
        this.listTeamProjects(teamId),
        this.listTeamProducts(teamId, principal),
        this.listTeamInboxItems(teamId, principal),
        this.listTeamInvites(teamId),
        this.listTeamWebHosts(teamId),
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
    const readyToRelease = projectSummaries.filter((summary) => summary?.latestStagingDeployment?.status === 'succeeded'
        && (!summary.latestProdDeployment || summary.latestProdDeployment.releaseTag !== summary.latestStagingDeployment.releaseTag));
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
            timestamp: Date.parse(event.created_at),
            type: event.content_type,
            action: Number(event.is_update) === 1 ? 'updated' : 'created',
        }))
        .filter((event) => Number.isFinite(event.timestamp) && contentTypes.has(event.type))
        .reverse();
    return {
        team,
        members,
        counts: {
            projects: projects.length,
            releaseReady: readyToRelease.length,
            activeAgents: activeAgents.length,
            liveListings: publishedProducts.length,
            inbox: inbox.length,
            members: members.length,
            pendingInvitations: pendingInvitations.length,
            hosts: hosts.length,
        },
        access,
        pendingInvitations,
        operational: {
            projects: { count: projects.length, href: '/app/projects' },
            hosts: { count: hosts.length, href: '/app/hosts' },
            capacity: { count: activeAgents.length, href: '/app/capacity' },
            knowledge: { count: inbox.length, href: '/app/knowledge' },
            catalog: { count: publishedProducts.length, href: '/app/market' },
        },
        contentActivity,
        auditEvents: projectedAuditEvents,
        continueWorking: projectSummaries.slice(0, 6),
        readyToRelease,
        activeAgents,
        publishedProducts,
        inbox,
    };
}
