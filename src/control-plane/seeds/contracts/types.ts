export const SEED_ENVIRONMENTS = ['local', 'staging', 'prod'] as const;

export type SeedEnvironment = typeof SEED_ENVIRONMENTS[number];
export type SeedDiagnosticSeverity = 'error' | 'warning';
export type SeedPlanActionType = 'create' | 'update' | 'unchanged' | 'skip' | 'delete' | 'error';
export type SeedResourceKind =
	| 'team'
	| 'teamMembership'
	| 'project'
	| 'hubRepository'
	| 'product'
	| 'catalogArtifact';

export type SeedOperationRecipeChannel = 'cli' | 'ui' | 'api' | 'provider-runtime' | 'system-check';

export type SeedDiagnostic = {
	severity: SeedDiagnosticSeverity;
	code: string;
	message: string;
	path?: string;
};

export type SeedResourceBase = {
	key: string;
	environments?: SeedEnvironment[];
};

export const SEED_PROJECT_TOPOLOGIES = ['single_repository_site', 'split_site_content', 'parent_workspace'] as const;
export const SEED_CONTENT_RUNTIME_SOURCES = ['local_directory', 'treedx_snapshot', 'r2_published_manifest', 'r2_preview_overlay'] as const;
export const SEED_LOCAL_CONTENT_MATERIALIZATIONS = ['none', 'existing_path', 'managed_clone', 'submodule'] as const;
export const SEED_CONTENT_PUBLISH_TARGETS = ['none', 'cloudflare_r2'] as const;

export type SeedProjectTopology = typeof SEED_PROJECT_TOPOLOGIES[number];
export type SeedContentRuntimeSource = typeof SEED_CONTENT_RUNTIME_SOURCES[number];
export type SeedLocalContentMaterialization = typeof SEED_LOCAL_CONTENT_MATERIALIZATIONS[number];
export type SeedContentPublishTargetKind = typeof SEED_CONTENT_PUBLISH_TARGETS[number];

export type SeedProjectContentPublishTarget = {
	kind: SeedContentPublishTargetKind;
	bucket?: string;
	prefix?: string;
	manifestPath?: string;
	metadata?: Record<string, unknown>;
};

export type SeedRepositoryPolicy = {
	visibility: 'public' | 'private';
	lifecycle: 'create-or-adopt' | 'adopt-only';
	deletionPolicy: 'retain' | 'archive';
	defaultBranch: 'main';
	stagingBranch: 'staging';
	issues: boolean;
	actions: boolean;
	workflows?: string[];
};

export type SeedProjectArchitecture = {
	topology: SeedProjectTopology;
	rootPath: string;
	sitePath: string;
	contentPath?: string;
	contentRuntimeSource: SeedContentRuntimeSource;
	localContentMaterialization: SeedLocalContentMaterialization;
	contentPublishTarget?: SeedProjectContentPublishTarget;
	requiresLocalContentForCi?: boolean;
	requiresLocalContentForDeploy?: boolean;
};

export type SeedManifest = {
	name: string;
	version: 1;
	description?: string;
	references: string[];
	defaultEnvironments?: SeedEnvironment[];
	environments: SeedEnvironment[];
	resources: SeedManifestResources;
	runtime: SeedRuntimePrerequisites;
	operationRecipes: SeedOperationRecipe[];
};

export type SeedManifestResources = {
	teams: SeedTeamResource[];
	teamMemberships: SeedTeamMembershipResource[];
	projects: SeedProjectResource[];
	hubRepositories: SeedHubRepositoryResource[];
	supportRepositories: SeedSupportRepositoryResource[];
	products: SeedProductResource[];
	catalogArtifacts: SeedCatalogArtifactResource[];
};

export type SeedTeamMembershipResource = SeedResourceBase & {
	team: string;
	email: string;
	roles: string[];
	missingUser: 'defer';
};

export type SeedCapacityProviderPrerequisite = SeedResourceBase & {
	providerClass: 'agent' | 'platform-operation';
	team: string;
	manifest: string;
	connectionId: string;
	approval: 'trusted-local-owner';
	projects: string[];
	allowedModes: Array<'planning' | 'acting'>;
	executionProviderIds: string[];
};

export type SeedAgentLabServicePrincipalPrerequisite = SeedResourceBase & {
	team: string;
	name: string;
	roles: ['team_owner'];
};

export type SeedRuntimePrerequisites = {
	capacityProviders: SeedCapacityProviderPrerequisite[];
	agentLabServicePrincipals: SeedAgentLabServicePrincipalPrerequisite[];
};

export type SeedTeamResource = SeedResourceBase & {
	slug: string;
	name?: string;
	displayName?: string;
	logoUrl?: string;
	profileSummary?: string;
	metadata?: Record<string, unknown>;
};

export type SeedProjectRepository = {
	role: string;
	provider: string;
	owner: string;
	name: string;
	gitUrl: string;
	defaultBranch?: string;
	checkoutPath?: string;
	submodulePath?: string;
	webUrl?: string;
	repositoryPolicy?: SeedRepositoryPolicy;
};

export type SeedProjectResource = SeedResourceBase & {
	team: string;
	slug: string;
	name: string;
	description?: string;
	kind?: string;
	repository: SeedProjectRepository;
	architecture: SeedProjectArchitecture;
	metadata?: Record<string, unknown>;
};

export type SeedHubRepositoryResource = SeedResourceBase & {
	project: string;
	role: string;
	provider: string;
	owner: string;
	name: string;
	gitUrl: string;
	defaultBranch?: string;
	currentBranch?: string;
	submodulePath?: string;
	status?: string;
	accessPolicy?: Record<string, unknown>;
	releasePolicy?: Record<string, unknown>;
	publishPolicy?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	repositoryPolicy?: SeedRepositoryPolicy;
};

export type SeedSupportRepositoryResource = SeedResourceBase & {
	provider: string;
	owner: string;
	name: string;
	gitUrl: string;
	defaultBranch?: string;
	description?: string;
	metadata?: Record<string, unknown>;
	repositoryPolicy?: SeedRepositoryPolicy;
};

export type SeedProductResource = SeedResourceBase & {
	team: string;
	kind: string;
	slug: string;
	title: string;
	summary?: string;
	visibility?: string;
	listingEnabled?: boolean;
	offerMode?: string;
	manifestKey?: string;
	artifactKey?: string;
	searchText?: string;
	metadata?: Record<string, unknown>;
};

export type SeedCatalogArtifactResource = SeedResourceBase & {
	product: string;
	version: string;
	kind: string;
	contentKey: string;
	manifestKey?: string;
	publishedAt?: string;
	metadata?: Record<string, unknown>;
};

export type SeedOperationRecipeCommand = {
	argv: string[];
};

export type SeedOperationRecipeAssertion = Record<string, unknown>;

export type SeedOperationRecipeArtifact = Record<string, unknown>;

export type SeedOperationRecipeStep = {
	id: string;
	title: string;
	actor?: string;
	channel: SeedOperationRecipeChannel;
	operation: string;
	dependsOn: string[];
	uses: string[];
	target?: string;
	command?: SeedOperationRecipeCommand;
	assertions: SeedOperationRecipeAssertion[];
	artifacts: SeedOperationRecipeArtifact[];
};

export type SeedOperationRecipe = {
	id: string;
	title: string;
	environments: SeedEnvironment[];
	entrypoints: string[];
	steps: SeedOperationRecipeStep[];
};

export type SeedOperationRecipePlan = SeedOperationRecipe & {
	selected: boolean;
	orderedSteps: SeedOperationRecipeStep[];
};

export type NormalizedSeedResource = {
	kind: SeedResourceKind;
	key: string;
	label: string;
	environments: SeedEnvironment[];
	payload: Record<string, unknown>;
	parentKey?: string;
};

export type SeedPlanAction = NormalizedSeedResource & {
	action: SeedPlanActionType;
	reason?: string;
	existing?: Record<string, unknown> | null;
};

export type SeedPlanSummary = Record<SeedPlanActionType, number>;

export type SeedCurrentResource = {
	key: string;
	kind: SeedResourceKind;
	payload: Record<string, unknown>;
	existing?: Record<string, unknown> | null;
};

export type SeedPlan = {
	ok: boolean;
	seed: string;
	version: 1;
	references: string[];
	mode: 'plan' | 'validate' | 'apply';
	environments: SeedEnvironment[];
	summary: SeedPlanSummary;
	actions: SeedPlanAction[];
	runtime: SeedRuntimePrerequisites;
	recipes: SeedOperationRecipePlan[];
	diagnostics: SeedDiagnostic[];
	manifestPath: string;
};
