import { AgentSdk } from "@treeseed/sdk";
import {
  D1AuthProvider as DatabaseAuthProvider,
  createApiApp as createSdkApiApp,
} from "@treeseed/sdk/api";
import { createCapacityControlPlane } from "../capacity/control-plane.ts";
import {
  createStripeConnectService,
  resolveStripeEnvironment,
} from "../commerce/commerce-core/stripe-connect.js";
import { MarketControlPlaneStore } from "../persistence/store.js";
import {
  POSTGRES_AUTH_PROVIDER_ID,
  createApiExtension,
  defaultConfig,
  installApiRequestLogger,
  resolveAgentArtifactBucket,
  resolveAuthApprovalBaseUrl,
  shouldLogApiRequests,
} from "../app/support/index.ts";
import { createMarketPostgresDatabase } from "./market-postgres.js";
import { routeDependencies } from "./route-dependencies.ts";
import { installPlatformRoutes } from "./route-installers.ts";

export * from "../app/support/index.ts";

export function createPlatformApiApp(
  options: any = {},
): ReturnType<typeof createSdkApiApp> {
  const config = defaultConfig(options.config ?? {});
  const apiDatabaseUrl =
    config.apiDatabaseUrl ?? process.env.TREESEED_DATABASE_URL ?? null;
  if (!options.db && !apiDatabaseUrl) {
    throw new Error(
      "TREESEED_DATABASE_URL is required for the Treeseed PostgreSQL control-plane database.",
    );
  }
  const db = options.db ?? createMarketPostgresDatabase(apiDatabaseUrl);
  const store =
    options.store ??
    new MarketControlPlaneStore(
      {
        ...config,
        assertionSecret: config.webAssertionSecret,
        serviceId: config.webServiceId,
        serviceSecret: config.webServiceSecret,
        fetchImpl: options.fetchImpl ?? fetch,
      },
      db,
    );
  const capacity = createCapacityControlPlane(store);
  const configuredAuthProviderId =
    config.providers?.auth ?? POSTGRES_AUTH_PROVIDER_ID;
  const authProviderId =
    configuredAuthProviderId === "d1"
      ? POSTGRES_AUTH_PROVIDER_ID
      : configuredAuthProviderId;
  const authConfig = {
    ...config,
    baseUrl: resolveAuthApprovalBaseUrl(config),
  };
  const sharedSdk =
    options.sdk ?? AgentSdk.createLocal({ repoRoot: config.repoRoot });
  const runtimeProviders =
    authProviderId === POSTGRES_AUTH_PROVIDER_ID
      ? {
          ...(options.runtimeProviders ?? {}),
          auth: {
            ...(options.runtimeProviders?.auth ?? {}),
            [POSTGRES_AUTH_PROVIDER_ID]: ({ config: runtimeConfig }: any) =>
              new DatabaseAuthProvider(
                {
                  ...runtimeConfig,
                  baseUrl: resolveAuthApprovalBaseUrl({
                    ...config,
                    ...runtimeConfig,
                  }),
                },
                { db },
              ),
          },
        }
      : { ...(options.runtimeProviders ?? {}) };
  const logRequests = shouldLogApiRequests(config, options);
  const stripeConnectService =
    options.stripeConnectService ??
    createStripeConnectService({
      config,
      environment: resolveStripeEnvironment(config),
    });

  return createSdkApiApp({
    ...options,
    config: {
      ...config,
      providers: { ...(config.providers ?? {}), auth: authProviderId },
    },
    runtimeProviders,
    sdk: sharedSdk,
    internalPrefix: options.internalPrefix ?? "/internal/core",
    surfaces: { templates: false, ...(options.surfaces ?? {}) },
    extensions: [
      createApiExtension({
        mount(app, runtime) {
          if (logRequests) installApiRequestLogger(app);
          const runtimeMarketAuthProvider = new DatabaseAuthProvider(
            {
              ...authConfig,
              ...runtime.resolved.config,
              baseUrl: resolveAuthApprovalBaseUrl({
                ...config,
                ...runtime.resolved.config,
              }),
            },
            { db },
          );
          store.setArtifactBucket(resolveAgentArtifactBucket(runtime));
          const routeContext = {
            ...routeDependencies,
            apiDatabaseUrl,
            app,
            authConfig,
            authProviderId,
            capacity,
            config,
            configuredAuthProviderId,
            db,
            logRequests,
            options,
            runtime,
            runtimeMarketAuthProvider,
            runtimeProviders,
            sharedSdk,
            store,
            stripeConnectService,
          };
          installPlatformRoutes(routeContext);
          options.extendApp?.(app, runtime);
        },
      }),
      ...(options.extensions ?? []),
    ],
  });
}
