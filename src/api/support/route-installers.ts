import { installFeedbackAdministrationRoutes } from "../routes/feedback/administration.ts";
import { installFeedbackSubmissionRoutes } from "../routes/feedback/submission.ts";
import { installSessionEventRoutes } from "../routes/realtime/session-events.ts";
import { installClientActionRoutes } from "../routes/realtime/client-actions.ts";
import { installOperationsPlatformRunnersAndJobsRoutes } from "../routes/operations/operations-platform-runners-and-jobs.ts";
import { installOperationsProjectJobsRoutes } from "../routes/projects/operations/operations-project-jobs.ts";
import { installProjectsSettingsAndSummariesRoutes } from "../routes/projects/projects-settings-and-summaries.ts";
import { installGitHubConnectorRoutes } from "../routes/providers/github-connectors.ts";
import { installGitHubWebhookRoutes } from "../routes/providers/github-webhooks.ts";
import { installSeedResourceResolutionRoutes } from "../routes/seeds/seed-resource-resolution.ts";
import { installSeedRunLifecycleRoutes } from "../routes/seeds/seed-run-lifecycle.ts";
import { installFoundationHealthAndControlPlaneRoutes } from "../routes/support/foundation-health-and-control-plane.ts";
import { installTeamServicesRoutes } from "../routes/teams/team-services.ts";
import { installTeamServiceAuthorityRoutes } from "../routes/teams/team-service-authorities.ts";
import { installTeamsStorageAndContentPreviewsRoutes } from "../routes/teams/teams-storage-and-content-previews.ts";
import { installTreedxCredentialsMirrorsAndSharesRoutes } from "../routes/treedx/repositories/treedx-credentials-mirrors-and-shares.ts";
import { installTreedxInternalTreedxPublicFederationStatusRoutes } from "../routes/treedx/repositories/treedx-internal-treedx-public-federation-status.ts";
import { installTreedxTeamServiceAndPublicFederationRoutes } from "../routes/treedx/repositories/treedx-team-service-and-public-federation.ts";

export function installPlatformRoutes(context: any): void {
  installFoundationHealthAndControlPlaneRoutes(context);
  installFeedbackSubmissionRoutes(context);
  installSessionEventRoutes(context);
  installClientActionRoutes(context);
  installFeedbackAdministrationRoutes(context);
  installSeedResourceResolutionRoutes(context);
  installSeedRunLifecycleRoutes(context);
  installOperationsPlatformRunnersAndJobsRoutes(context);
  installTreedxTeamServiceAndPublicFederationRoutes(context);
  installTreedxInternalTreedxPublicFederationStatusRoutes(context);
  installTreedxCredentialsMirrorsAndSharesRoutes(context);
  installTeamServicesRoutes(context);
  installTeamServiceAuthorityRoutes(context);
  installGitHubConnectorRoutes(context);
  installGitHubWebhookRoutes(context);
  installProjectsSettingsAndSummariesRoutes(context);
  installOperationsProjectJobsRoutes(context);
  installTeamsStorageAndContentPreviewsRoutes(context);
}
