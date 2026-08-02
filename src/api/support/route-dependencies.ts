import * as sdk from "@treeseed/sdk";
import * as accountContracts from "@treeseed/sdk/account-contracts";
import * as sdkApi from "@treeseed/sdk/api";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import * as account from "../../auth/account.ts";
import * as authConfig from "../../auth/config.ts";
import * as emailConfirmation from "../../auth/email-confirmation.ts";
import * as authEmail from "../../auth/email.ts";
import { validateUsername as validatePublicUsername } from "../../auth/profile-validation.ts";
import * as welcomeEmail from "../../auth/welcome-email.ts";
import * as workdayProjection from "../../market/capacity/workdays/workday-projection.js";
import * as contentRelations from "../../market/content/content-relations.js";
import * as knowledgeProjection from "../../market/projects/knowledge/knowledge-projection.js";
import * as governanceProjection from "../../market/projects/projects-core/governance-projection.js";
import * as seedApply from "../../market/seeds/apply.js";
import * as infrastructureSeeds from "../../market/seeds/infrastructure-seeds.js";
import * as notifications from "../../notifications/service.ts";
import * as knowledgeContent from "../../view-models/knowledge-content.js";
import * as requestAuth from "../accounts/request-auth.ts";
import * as support from "../app/support/index.ts";
import * as capacityControlPlane from "../capacity/control-plane.ts";
import * as capacityRoutes from "../capacity/routes/index.ts";
import * as capacityRequest from "../capacity/routes/support/request-json.ts";
import * as teamCapacityDeletion from "../capacity/services/teams/team-deletion-service.ts";
import * as stripeConnect from "../commerce/commerce-core/stripe-connect.js";
import * as persistence from "../persistence/store.js";
import * as postgres from "./market-postgres.js";

/** Static dependencies exposed to bounded route installers. */
export const routeDependencies: Record<string, any> = {
  ...sdk,
  ...accountContracts,
  ...sdkApi,
  ...crypto,
  ...fs,
  ...fsPromises,
  ...account,
  ...authConfig,
  ...emailConfirmation,
  ...authEmail,
  ...welcomeEmail,
  ...workdayProjection,
  ...knowledgeProjection,
  ...governanceProjection,
  ...seedApply,
  ...infrastructureSeeds,
  ...notifications,
  ...knowledgeContent,
  ...requestAuth,
  ...capacityControlPlane,
  ...capacityRoutes,
  ...capacityRequest,
  ...teamCapacityDeletion,
  ...stripeConnect,
  ...persistence,
  ...postgres,
  ...support,
  contentRelationPolicy: contentRelations.contentRelationPolicy,
  DatabaseAuthProvider: sdkApi.D1AuthProvider,
  normalizeRepositoryContentInput: sdk.normalizePlatformContentInput,
  normalizeRepositoryRelationArray: sdk.normalizePlatformRelationArray,
  parseYaml,
  repositoryContentRelationPolicy: sdk.platformContentRelationPolicy,
  resolve: path.resolve,
  relative: path.relative,
  slugifyRepositoryContent: sdk.slugifyPlatformContent,
  validatePublicUsername,
};
