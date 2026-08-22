import { installProjectsSettingsAndSummariesRoutes } from "../routes/projects/projects-settings-and-summaries.ts";
import { installFoundationHealthAndControlPlaneRoutes } from "../routes/support/foundation-health-and-control-plane.ts";
import { installTeamsStorageAndContentPreviewsRoutes } from "../routes/teams/teams-storage-and-content-previews.ts";
import { installTreedxCredentialsMirrorsAndSharesRoutes } from "../routes/treedx/repositories/treedx-credentials-mirrors-and-shares.ts";
import { installTreedxInternalTreedxPublicFederationStatusRoutes } from "../routes/treedx/repositories/treedx-internal-treedx-public-federation-status.ts";
import { installTreedxTeamServiceAndPublicFederationRoutes } from "../routes/treedx/repositories/treedx-team-service-and-public-federation.ts";

export function installPlatformRoutes(context: any): void {
  installFoundationHealthAndControlPlaneRoutes(context);
  installTreedxTeamServiceAndPublicFederationRoutes(context);
  installTreedxInternalTreedxPublicFederationStatusRoutes(context);
  installTreedxCredentialsMirrorsAndSharesRoutes(context);
  installProjectsSettingsAndSummariesRoutes(context);
  installTeamsStorageAndContentPreviewsRoutes(context);
}
