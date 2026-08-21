import { AgentSdk } from "@treeseed/sdk";
import {
  D1AuthProvider as DatabaseAuthProvider,
  createApiApp as createSdkApiApp,
} from "@treeseed/sdk/api";
import { createCapacityControlPlane } from "../capacity/control-plane.ts";
import { ControlPlaneStore } from "../persistence/store.js";
import {
  POSTGRES_AUTH_PROVIDER_ID,
  createApiExtension,
  defaultConfig,
  installApiRequestLogger,
	localAcceptanceAdminToken,
	localAcceptanceAuthEnabled,
  resolveAgentArtifactBucket,
  resolveAuthApprovalBaseUrl,
  shouldLogApiRequests,
} from "../app/support/index.ts";
import { createControlPlanePostgresDatabase } from "./control-plane-postgres.js";
import { routeDependencies } from "./route-dependencies.ts";
import { installPlatformRoutes } from "./route-installers.ts";
import { SessionEventService } from "../realtime/session-events.ts";
import { installControlPlaneProtocolRoutes } from "../control-plane/http/protocol-routes.ts";

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
  const db = options.db ?? createControlPlanePostgresDatabase(apiDatabaseUrl);
  const store =
    options.store ??
    new ControlPlaneStore(
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
  const sessionEvents = options.sessionEvents ?? new SessionEventService(store, db.pool);
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
	const authenticateBearerOverride = async (token: string) => {
		if (!localAcceptanceAuthEnabled({ resolved: { config } }) || token !== localAcceptanceAdminToken()) return null;
		return {
			principal: {
				id: 'team-key:local-capacity-acceptance', displayName: 'Local Capacity Acceptance',
				roles: ['team_api_key', 'market_admin'], permissions: ['*:*:*', 'seeds:apply:global', 'teams:manage:team'],
				scopes: ['auth:me'], metadata: { localAcceptance: true },
			},
			credential: { type: 'service_token' as const, id: 'local-capacity-acceptance', label: 'Local Capacity Acceptance' },
		};
	};

  return createSdkApiApp({
    ...options,
    config: {
      ...config,
      providers: { ...(config.providers ?? {}), auth: authProviderId },
    },
    runtimeProviders,
    sdk: sharedSdk,
	authenticateBearerOverride,
    internalPrefix: options.internalPrefix ?? "/internal/core",
    surfaces: { templates: false, ...(options.surfaces ?? {}) },
    extensions: [
      createApiExtension({
        mount(app, runtime) {
          if (logRequests) installApiRequestLogger(app);
          const runtimeControlPlaneAuthProvider = new DatabaseAuthProvider(
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
            runtimeControlPlaneAuthProvider,
            runtimeProviders,
            sharedSdk,
            sessionEvents,
            store,
          };
          installPlatformRoutes(routeContext);
          installControlPlaneProtocolRoutes(app, (token) => runtimeControlPlaneAuthProvider.authenticateBearerToken(token));
          options.extendApp?.(app, runtime);
        },
      }),
      ...(options.extensions ?? []),
    ],
  });
}
