import { createHash, randomUUID } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { compileAgentDefinition, compileDefaultChatActivityProfile, compileGroupDefinition, validateAgentSignalContract, validateProposalTypeContract, validateGroupDefinition, validateGroupEdgeDefinition } from "@treeseed/sdk/agent-capacity";
import { parseSceneManifest } from "@treeseed/sdk/scenes";
import { validateSeedSource } from "@treeseed/sdk/seeds";
import { parseFrontmatterDocument } from "@treeseed/sdk/frontmatter";
import { AGENT_OPERATIONAL_CONTENT_COLLECTIONS, validateContentFrontmatter } from "@treeseed/sdk/content-validation";
import { resolveKnowledgeGatewayConnection } from "../../../../knowledge/gateway-treedx-connection.ts";
import { ProjectAgentClassService } from "../../../services/projects/agents/project-agent-class-service.ts";
import { projectTreeDxCommitSignals } from "../../../services/treedx/repositories/treedx-change-projector.ts";
import { recordTreeDxAuthoringState } from "../../../services/treedx/repositories/treedx-authoring-journal.ts";
import { agentLabRepositoryDefinitions, invalidateAgentLabRepositoryDefinitions, repositoryDefinitionSource, validateAgentDefinitionSource } from "./repository-definitions.ts";
import { agentClassProjectionIdempotencyKey,projectionDigest } from './deployment-support/projection-identity.ts';
import { reconcileUnchangedAuthoringReplay } from './deployment-support/unchanged-authoring-replay.ts';
import { authoringExecutionPolicy } from './deployment-support/authoring-execution-policy.ts'; import { reconcileInterruptedOperatorAuthoring } from './deployment-support/authoring-journal-recovery.ts';
export { agentClassProjectionIdempotencyKey } from './deployment-support/projection-identity.ts';
import { readCapacityRequestObject } from "../request-json.ts";
import { applyTextChangeset } from "../../../../knowledge/changesets/apply-text-changeset.ts";
import { parseValidatedQuestionContent } from "./question-content.ts";
import { prepareTreeDxCredentialDelivery } from "../../../../routes/treedx/repositories/treedx-credential-delivery-preparation.ts";
import { parseAgentLabSimulationDraftOptions, validateAgentLabSimulationSelection } from "./simulation-draft-options.ts";
import { installAgentDeploymentRoutes } from './deployments.ts';
const PORTABLE_PATH = /^(?:\.treeseed\/agents\/signals\/[^/]+\.ya?ml|\.treeseed\/governance\/proposal-types\/[^/]+\.ya?ml|seeds\/[^/]+\.ya?ml|scenes\/[^/]+(?:\/[^/]+)*\.ya?ml)$/u;
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function jsonObject(value) {
  if (typeof value === "string") try {
    return object(JSON.parse(value));
  } catch {
    return {};
  }
  return object(value);
}
function text(...values) { return String(values.find((value) => typeof value === "string" && value) ?? ""); }
function strings(value) {
  return Array.isArray(value) ? [...new Set(value.map(text).filter(Boolean))] : [];
}
async function configuredContentRoot(dependencies, projectId) {
  const library = await dependencies.store.first("SELECT content_path FROM treedx_project_libraries WHERE project_id = ? LIMIT 1", [projectId]);
  return text(library?.content_path).trim().replace(/^\/+|\/+$/gu, "");
}
async function compileIntentRequest(dependencies, body) {
  if (!body.intent || typeof body.intent !== "object" || Array.isArray(body.intent)) return body;
  const projectId = text(body.projectId);
  let requestedPath = text(body.path);
  let currentSource = text(body.source);
  const contentRoot = await configuredContentRoot(dependencies, projectId);
  if (!contentRoot) return { ...body, contentPathMissing: true };
  if (!currentSource) {
    const preview = compileAgentDefinition({ intent: body.intent, projectId, contentRoot });
    requestedPath = preview.identity.path;
    const connection = await resolveKnowledgeGatewayConnection(dependencies.store, { projectId, write: false, authoringPaths: true }).catch(() => null);
    if (connection) {
      const ref = `refs/heads/${connection.authoringBranch.replace(/^refs\/heads\//u, "")}`;
      const read = await connection.client.readRepositoryFile({ repoId: connection.repositoryId, ref, path: requestedPath, encoding: "utf8", maxBytes: 196608 }).catch(() => null);
      currentSource = repositoryDefinitionSource(read?.file);
    }
  }
  const parsed = currentSource ? parseFrontmatterDocument(currentSource) : { frontmatter: {}, body: "" };
  const current = object(parsed.frontmatter);
  const existingSlug = text(current.slug);
  const existing = existingSlug ? { identity: { id: text(current.id, `agent:${existingSlug}`), slug: existingSlug, path: requestedPath, createdFromTemplate: text(current.template) || void 0 }, frontmatter: current } : void 0;
  const compiled = compileAgentDefinition({ intent: body.intent, projectId, contentRoot, existing });
  const nestedDocument = parsed.body.indexOf("\n---\n");
  const retainedBody = nestedDocument >= 0 ? parsed.body.slice(0, nestedDocument) : parsed.body;
  const source = `---
${stringifyYaml(compiled.frontmatter, { lineWidth: 0 }).trim()}
---
${text(body.contentBody, retainedBody, `
${text(object(body.intent).name)} participates through declared activity profiles and durable outputs.
`)}`;
  return { ...body, path: compiled.identity.path, source, generated: compiled.generated };
}
function validateSource(path, source) {
  if (path.includes("/agent-tests/")) {
    try {
      return validateContentFrontmatter("agent_test", parseFrontmatterDocument(source).frontmatter);
    } catch (error) {
      return { ok: false, diagnostics: [{ path, message: error instanceof Error ? error.message : "Invalid agent test frontmatter." }] };
    }
  }
  if (path.includes("/groups/") || path.includes("/group-edges/")) {
    try {
      const value = parseFrontmatterDocument(source).frontmatter;
      return path.includes("/group-edges/") ? validateGroupEdgeDefinition(value) : validateGroupDefinition(value);
    } catch (error) {
      return { ok: false, diagnostics: [{ path, message: error instanceof Error ? error.message : "Invalid group frontmatter." }] };
    }
  }
  const operationalModel = Object.entries(AGENT_OPERATIONAL_CONTENT_COLLECTIONS)
    .find(([, collection]) => path.includes(`/${collection}/`))?.[0];
  if (operationalModel) {
    try {
      return validateContentFrontmatter(operationalModel, parseFrontmatterDocument(source).frontmatter);
    } catch (error) {
      return { ok: false, diagnostics: [{ path, message: error instanceof Error ? error.message : "Invalid operational agent content frontmatter." }] };
    }
  }
  if (path.endsWith(".mdx")) return validateAgentDefinitionSource(source);
  let parsed;
  try {
    parsed = parseYaml(source);
  } catch (error) {
    return { ok: false, diagnostics: [{ path, message: error instanceof Error ? error.message : "Invalid YAML." }] };
  }
  if (path.includes("/agents/signals/")) return validateAgentSignalContract(parsed);
  if (path.includes("/governance/proposal-types/")) return validateProposalTypeContract(parsed);
  if (path.startsWith("seeds/")) return validateSeedSource(source);
  if (path.startsWith("scenes/")) {
    const diagnostics = [];
    const scene = parseSceneManifest(parsed, diagnostics);
    return { ok: Boolean(scene) && !diagnostics.some((item) => item.severity === "error"), diagnostics };
  }
  return { ok: false, diagnostics: [{ path, message: "Unsupported authoring definition." }] };
}
function activityCapabilities(activities) {
  const values = ["repo_read", "agent_mode_run"];
  for (const activity of Object.values(activities).map(object)) values.push(...strings(object(activity.execution).requiredCapabilities));
  return [...new Set(values)];
}
async function refreshAgentDefinitionIndex(connection, commit) {
	const paths = [`${connection.contentPath}/**`,".treeseed/agents/signals/**",".treeseed/governance/proposal-types/**"];
  const graphRequest = await connection.client.refreshGraph({ repoId: connection.repositoryId, ref: commit, paths, forceFull: true });
  if (graphRequest.jobId) {
    let completed = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const job = await connection.client.getGraphRefreshJob({ repoId: connection.repositoryId, ref: commit, jobId: graphRequest.jobId });
      if (job.status === "completed") {
        completed = true;
        break;
      }
      if (job.status === "failed") throw new Error(`TreeDX agent-definition graph refresh failed: ${job.errorCode ?? "unknown error"}.`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if (!completed) throw new Error("TreeDX agent-definition graph refresh timed out.");
  }
  const refreshed = await connection.client.refreshSearchIndex({ repoId: connection.repositoryId, ref: commit, paths });
  const resolved = text(refreshed.resolvedRef, refreshed.sourceCommit);
  if (refreshed.stale || resolved !== commit) throw new Error("TreeDX agent-definition index did not resolve the committed revision.");
}
async function reconcileAgents(dependencies, project, commit) {
  const connection = await resolveKnowledgeGatewayConnection(dependencies.store, { projectId: text(project.id), write: true, authoringPaths: true, readRefs: [commit] });
  if (!connection) throw new Error("The project TreeDX repository is unavailable for agent reconciliation.");
  await refreshAgentDefinitionIndex(connection, commit);
  const definitions = await agentLabRepositoryDefinitions(dependencies, [project], commit);
  const agents = definitions.filter((item) => item.kind === "agent" && object(item.data).valid === true);
  const contracts = Object.fromEntries(definitions.filter((item) => item.kind === "signal").map((item) => [text(object(item.data).contractId), object(object(item.data).definition)]));
  const proposalTypes = Object.fromEntries(definitions.filter((item) => item.kind === "proposal-type").map((item) => [text(object(item.data).contractId), object(object(item.data).definition)]));
  const groupContracts = Object.fromEntries(definitions.filter((item) => item.kind === "group").map((item) => [text(object(item.data).contractId), object(object(item.data).definition)]));
  const groupEdgeContracts = Object.fromEntries(definitions.filter((item) => item.kind === "group-edge").map((item) => [text(object(item.data).contractId), object(object(item.data).definition)]));
  const capacityClasses = /* @__PURE__ */ new Map();
  for (const agent of agents) {
    const definition = object(object(agent.data).definition);
    const classSlug = text(definition.projectAgentClassId, definition.agentClass);
    if (classSlug) capacityClasses.set(classSlug, [...capacityClasses.get(classSlug) ?? [], agent]);
  }
  const service = new ProjectAgentClassService(dependencies.store);
  const existing = await service.listPage(text(project.id), { limit: 200, cursor: null });
  for (const [classSlug, entries] of capacityClasses) {
    const configured = entries.map((entry) => {
      const data = object(entry.data);
      const definition = object(data.definition);
      const groupIds = strings(definition.groupIds);
	  const activities = object(data.activities);
	  activities.chat ??= { activityType: "chat", ...compileDefaultChatActivityProfile(text(definition.slug, definition.id), object(definition.chatProfile)) };
      return {
        slug: text(definition.slug, definition.id), name: text(definition.name, definition.title, definition.slug), groupIds,
        topicIds: strings(definition.topicIds), contextQueryRefs: Array.isArray(definition.contextQueryRefs) ? definition.contextQueryRefs : [],
        contextQuerySetRefs: Array.isArray(definition.contextQuerySetRefs) ? definition.contextQuerySetRefs : [],
        instructionTemplateRefs: Array.isArray(definition.instructionTemplateRefs) ? definition.instructionTemplateRefs : [],
        contentPath: text(data.path), enabled: definition.enabled !== false, activities,
      };
    });
    const allowedModes = [...new Set(configured.flatMap((agent) => Object.values(agent.activities).map((activity) => text(object(activity).activityType) === "acting" ? "acting" : "planning")))];
    const current = existing.items.find((item) => item.slug === classSlug || item.id === `${project.id}:${classSlug}`);
    const value = { id: `${project.id}:${classSlug}`, slug: classSlug, name: text(object(object(entries[0].data).definition).agentClassTitle, classSlug), status: configured.some((agent) => agent.enabled) ? "active" : "paused", allowedModes, requiredCapabilities: [...new Set(configured.flatMap((agent) => activityCapabilities(agent.activities)))], handlerRefs: { agents: configured, signalContracts: contracts, proposalTypeContracts: proposalTypes, groupContracts, groupEdgeContracts }, metadata: { source: "treedx_agent_lab_authoring", immutableRef: commit } };
    const idempotencyKey = agentClassProjectionIdempotencyKey(commit, classSlug, value, current);
    if (current) {
      if (projectionDigest(current) !== projectionDigest(value)) await service.update(text(project.id), current.id, value, idempotencyKey);
    } else await service.create(text(project.id), value, idempotencyKey);
  }
}
async function verifyReferences(dependencies, connection, workspaceBase, files) {
  const references = files.flatMap((file) => file.path.startsWith(`${connection.contentPath}/agents/`) ? validateAgentDefinitionSource(file.source).references : []);
  const included = new Map(files.map((file) => [file.path, file.source]));
  const paths = [...new Set(references.map((reference) => `.treeseed/agents/signals/${reference.id}.yaml`))];
  const missingPaths = paths.filter((path) => !included.has(path));
  const read = missingPaths.length ? await connection.client.readRepositoryFiles({ repoId: connection.repositoryId, ref: workspaceBase, paths: missingPaths, encoding: "utf8", parseFrontmatter: false, allowProtected: true }).catch(() => ({ files: [] })) : { files: [] };
  const available = new Map([...included, ...(read.files ?? []).map((file) => [text(object(file).path), text(object(file).content)])]);
  return references.flatMap((reference) => {
    const path = `.treeseed/agents/signals/${reference.id}.yaml`;
    const source = available.get(path);
    if (!source) return [{ path, message: `Missing signal contract ${reference.id}.` }];
    try {
      const result = validateAgentSignalContract(parseYaml(source));
      return result.ok ? [] : result.diagnostics;
    } catch {
      return [{ path, message: `Signal contract ${reference.id} is invalid YAML.` }];
    }
  });
}
async function publishAuthoringCommit(dependencies, projectId, branchName, commitSha) {
  const connection = await resolveKnowledgeGatewayConnection(dependencies.store, { projectId, write: false, publishRefs: [branchName] });
  if (!connection) throw new Error("The project TreeDX publication connection is unavailable.");
  const library = await dependencies.store.getProjectTreeDxLibrary(projectId);
  const libraryMetadata = object(library?.metadata);
  const contentTopology = object(object(library?.topology).contentRepository);
  const treeDxBaseUrl = text(object(contentTopology.treeDx).baseUrl);
  const localAcceptance = libraryMetadata.acceptance === true && text(libraryMetadata.publicationMode) === "local-only"
    && (process.env.TREESEED_ENVIRONMENT === "local" || process.env.LOCAL_DEV_MODE === "1" || /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)/u.test(treeDxBaseUrl));
  if (localAcceptance) {
    const refs = await connection.client.listRepositoryRefs(connection.repositoryId);
    const publishedRef = refs.find((entry) => entry.name === branchName);
    const observedHead = text(publishedRef?.target, publishedRef?.sha);
    if (observedHead !== commitSha) throw new Error("Fresh TreeDX read-back did not observe the local acceptance content commit.");
    return { status: "local-only", afterHead: observedHead, observed: { afterHead: observedHead } };
  }
  const identity = await dependencies.store.first(`SELECT project.slug AS project_slug, team.slug AS team_slug
		FROM projects project JOIN teams team ON team.id = project.team_id WHERE project.id = ?`, [projectId]);
  const repository = await dependencies.store.first(`SELECT owner, name FROM hub_repositories
		WHERE hub_id = ? AND role = 'content' AND status = 'active' LIMIT 1`, [projectId]);
  if (!identity || !repository) throw new Error("The project content repository identity is unavailable.");
  const placement = await connection.client.getPlacement(connection.repositoryId);
  const nodeId = text(placement.primaryNodeId);
  if (!nodeId) throw new Error("TreeDX did not resolve the primary node for credential delivery.");
  const refspec = `${branchName}:${branchName}`;
  const pushCredential = await prepareTreeDxCredentialDelivery({ store: dependencies.store, body: {
    teamSlug: identity.team_slug,
    projectSlug: identity.project_slug,
    owner: repository.owner,
    name: repository.name,
    nodeId,
    sourceRef: branchName,
    destinationRef: branchName,
    idempotencyKey: `agent-lab-push:${nodeId}:${projectId}:${commitSha}`,
    refspec,
    operationKind: "push"
  } });
  const push = await connection.client.push({
    repoId: connection.repositoryId,
    remoteName: "origin",
    remoteUrl: pushCredential.remoteUrl,
    credentialId: pushCredential.deliveryId,
    refspecs: [refspec],
    expectedRemoteHead: pushCredential.expectedRemoteHead
  });
  if (push.rejectedRefs.length || push.status !== "pushed" || push.afterHead !== commitSha) throw new Error("TreeDX did not push the exact Agent Lab content commit.");
  const fetchRefspec = `+${branchName}:${branchName}`;
  const fetchCredential = await prepareTreeDxCredentialDelivery({ store: dependencies.store, body: {
    teamSlug: identity.team_slug,
    projectSlug: identity.project_slug,
    owner: repository.owner,
    name: repository.name,
    nodeId,
    sourceRef: branchName,
    destinationRef: branchName,
    expectedRemoteHead: commitSha,
    idempotencyKey: `agent-lab-fetch:${nodeId}:${projectId}:${commitSha}`,
    refspec: fetchRefspec,
    operationKind: "fetch"
  } });
  const observed = await connection.client.fetchRemote({
    repoId: connection.repositoryId,
    remoteName: "origin",
    remoteUrl: fetchCredential.remoteUrl,
    credentialId: fetchCredential.deliveryId,
    refspecs: [fetchRefspec]
  });
  const refs = await connection.client.listRepositoryRefs(connection.repositoryId);
  const publishedRef = refs.find((entry) => entry.name === branchName);
  const observedHead = text(publishedRef?.target, publishedRef?.sha);
  if (observedHead !== commitSha) throw new Error("Fresh TreeDX remote read-back did not observe the Agent Lab content commit.");
  return { push, observed: { ...observed.fetch, afterHead: observedHead } };
}
async function commitBundle(c, dependencies, body) {
  if (body.contentPathMissing === true) return c.json({ ok: false, code: "agent_lab_content_path_required", error: "Configure the project content path before authoring Agent Lab definitions." }, 409);
  const projectId = text(body.projectId);
	let policy;
	try { policy = authoringExecutionPolicy(body.executionMode); }
	catch (error) { return c.json({ ok: false, code: "agent_lab_execution_mode_invalid", error: error instanceof Error ? error.message : String(error) }, 422); }
	const { executionMode, upstreamMutationPolicy } = policy;
  const project = projectId ? await dependencies.store.first("SELECT id, name, slug FROM projects WHERE id = ? AND team_id = ? LIMIT 1", [projectId, c.req.param("teamId")]) : null;
  if (!project) return c.json({ ok: false, code: "agent_lab_authoring_project_invalid", error: "Choose a project in this team." }, 422);
  const connection = await resolveKnowledgeGatewayConnection(dependencies.store, { projectId, write: true, authoringPaths: true });
  if (!connection) return c.json({ ok: false, code: "agent_lab_treedx_unavailable", error: "The project TreeDX repository is unavailable." }, 503);
  const files = (Array.isArray(body.files) ? body.files : [{ path: body.path, source: body.source }]).map(object).map((file) => ({ path: text(file.path).replace(/^\/+|\/+$/gu, ""), source: text(file.source) }));
  const modelPath = (path) => ["agents","agent-tests","groups","group-edges",...Object.values(AGENT_OPERATIONAL_CONTENT_COLLECTIONS)]
    .some((collection) => path.startsWith(`${connection.contentPath}/${collection}/`) && path.endsWith(".mdx"));
  if (!files.length || files.some((file) => !PORTABLE_PATH.test(file.path) && !modelPath(file.path) || !file.source.trim()) || new Set(files.map((file) => file.path)).size !== files.length) return c.json({ ok: false, code: "agent_lab_authoring_bundle_invalid", error: "Every definition needs a unique allowed repository path and nonempty source." }, 422);
  const diagnostics = files.flatMap((file) => {
    const result = validateSource(file.path, file.source);
    return result.ok ? [] : result.diagnostics;
  });
  if (diagnostics.length) return c.json({ ok: false, code: "agent_lab_authoring_validation_failed", error: "Correct the definition diagnostics before committing.", diagnostics }, 422);
  const branchName = `refs/heads/${connection.authoringBranch.replace(/^refs\/heads\//u, "")}`;
  let workspace;
  try {
    workspace = await connection.client.createWorkspace({ repoId: connection.repositoryId, baseRef: branchName, branchName, mode: "writable", allowedPaths: connection.allowedPaths, ttlSeconds: 900 });
  } catch (error) {
    return c.json({ ok: false, code: "agent_lab_authoring_workspace_failed", error: error instanceof Error ? error.message : "TreeDX could not open the authoring workspace." }, 409);
  }
  if (text(body.expectedBase) && text(body.expectedBase) !== workspace.baseCommitSha) {
    await connection.client.closeWorkspace(workspace.workspaceId).catch(() => {
    });
    return c.json({ ok: false, code: "agent_lab_authoring_conflict", error: "The authoring branch changed. Compare and rebase before saving.", currentBase: workspace.baseCommitSha }, 409);
  }
  const referenceConnection = await resolveKnowledgeGatewayConnection(dependencies.store, {
    projectId,
    write: false,
    authoringPaths: true,
    readRefs: [workspace.baseCommitSha]
  });
  if (!referenceConnection) {
    await connection.client.closeWorkspace(workspace.workspaceId).catch(() => {
    });
    return c.json({ ok: false, code: "agent_lab_reference_verification_unavailable", error: "TreeDX could not authorize immutable contract verification." }, 503);
  }
  const referenceDiagnostics = await verifyReferences(dependencies, referenceConnection, workspace.baseCommitSha, files);
  if (referenceDiagnostics.length) {
    await connection.client.closeWorkspace(workspace.workspaceId).catch(() => {
    });
    return c.json({ ok: false, code: "agent_contract_reference_invalid", error: "The bundle references missing or invalid signal contracts.", diagnostics: referenceDiagnostics }, 422);
  }
  try {
    const beforeByPath = new Map(await Promise.all(files.map(async (file) => {
      const existing = await connection.client.readRepositoryFile({ repoId: connection.repositoryId, ref: branchName, path: file.path, encoding: "utf8", parseFrontmatter: false, allowProtected: true }).catch(() => null);
      return [file.path, existing?.file ? repositoryDefinitionSource(existing.file) : null];
    })));
    if (files.every((file) => beforeByPath.get(file.path) === file.source)) {
      const payload = await reconcileUnchangedAuthoringReplay({
        closeWorkspace: () => connection.client.closeWorkspace(workspace.workspaceId),
        reconcileProjection: () => reconcileAgents(dependencies, project, workspace.baseCommitSha),
        workspaceId: workspace.workspaceId,
        baseRef: branchName,
        baseCommitSha: workspace.baseCommitSha,
      });
      await reconcileInterruptedOperatorAuthoring({store:dependencies.store,projectId,repositoryId:connection.repositoryId,ref:branchName,observedHead:workspace.baseCommitSha});
      return c.json({ ok: true, payload: { ...payload, executionMode, upstreamMutationPolicy } });
    }
    const changeset = await applyTextChangeset({ client: connection.client, workspace, changes: files.map((file) => ({ path: file.path, before: beforeByPath.get(file.path) ?? null, after: file.source })) });
    const access = await dependencies.manage(c);
    const commit = await connection.client.commit({ workspaceId: workspace.workspaceId, message: text(body.changeSummary, `agent-lab: update ${files.length} definition${files.length === 1 ? "" : "s"}`), author: { name: access.principal?.name ?? access.principal?.id ?? "Agent Lab operator", email: access.principal?.email ?? "agent-lab@users.treeseed.local" } });
    await recordTreeDxAuthoringState(dependencies.store,"unpublished",{ projectId,repositoryId:connection.repositoryId,commitSha:commit.commitSha,ref:commit.branchName,changedPaths:commit.changedPaths,actorType:"user",actorId:access.principal?.id }); await connection.client.closeWorkspace(workspace.workspaceId);
    const publication = executionMode === "production"
      ? await publishAuthoringCommit(dependencies, projectId, branchName, commit.commitSha)
      : { status: "simulation-local-checkpoint", upstreamMutationPolicy: "denied", afterHead: commit.commitSha };
    if (executionMode === "production") {
      await recordTreeDxAuthoringState(dependencies.store,"integrated",{ projectId,repositoryId:connection.repositoryId,commitSha:commit.commitSha,ref:commit.branchName,changedPaths:commit.changedPaths,actorType:"user",actorId:access.principal?.id }); await reconcileInterruptedOperatorAuthoring({store:dependencies.store,projectId,repositoryId:connection.repositoryId,ref:commit.branchName,observedHead:commit.commitSha,actorId:access.principal?.id});
      await projectTreeDxCommitSignals(dependencies.store, { projectId, commitSha: commit.commitSha, immutableRef: commit.branchName, changedPaths: commit.changedPaths, changeSummary: text(body.changeSummary, "Agent Lab definition update"), actorType: "user", actorId: access.principal?.id });
    }
    if (files.some((file) => modelPath(file.path) || file.path.includes("/agents/signals/") || file.path.includes("/proposal-types/"))) await reconcileAgents(dependencies, project, commit.commitSha);
    invalidateAgentLabRepositoryDefinitions(dependencies, projectId); await dependencies.store.run("INSERT INTO audit_events (id, actor_type, actor_id, event_type, target_type, target_id, data_json, created_at) VALUES (?, 'user', ?, 'agent_lab.authoring.committed', 'project', ?, ?, ?)", [randomUUID(), access.principal?.id ?? null, projectId, JSON.stringify({ changedPaths: commit.changedPaths, commitSha: commit.commitSha, executionMode, upstreamMutationPolicy }), (/* @__PURE__ */ new Date()).toISOString()]);
    return c.json({ ok: true, payload: { commit: commit.commitSha, branch: commit.branchName, changedPaths: commit.changedPaths, changeset: { ...changeset, resultCommitSha: commit.commitSha }, publication, executionMode, upstreamMutationPolicy } });
  } catch (error) {
    await connection.client.closeWorkspace(workspace.workspaceId).catch(() => {
    });
    return c.json({ ok: false, code: "agent_lab_authoring_failed", error: error instanceof Error ? error.message : "TreeDX could not commit the definitions." }, 409);
  }
}
async function compileGroupRequest(dependencies, body) {
  const projectId = text(body.projectId);
  const contentRoot = await configuredContentRoot(dependencies, projectId);
  if (!contentRoot) return { ...body, contentPathMissing: true };
  const compiled = compileGroupDefinition({ intent: body.intent, contentRoot });
  const document = (value) => `---
${stringifyYaml(value, { lineWidth: 0 }).trim()}
---
`;
  return { ...body, files: [{ path: compiled.groupPath, source: document(compiled.group) }, ...compiled.edge && compiled.edgePath ? [{ path: compiled.edgePath, source: document(compiled.edge) }] : []] };
}
async function agentLabSimulationDraft(dependencies, teamId, selectedProjectId, simulationOptions = parseAgentLabSimulationDraftOptions(() => undefined)) {
  const team = await dependencies.store.first("SELECT id, slug, name FROM teams WHERE id = ? LIMIT 1", [teamId]);
  const projects = await dependencies.store.all("SELECT id, slug, name, description, metadata_json FROM projects WHERE team_id = ? ORDER BY slug", [teamId]);
  const chosen = projects.find((project) => text(project.id) === selectedProjectId) ?? (!selectedProjectId ? projects[0] : void 0);
  const selectedProjects = chosen ? [chosen] : [];
  const teamKey = `team:${text(team?.slug, "team")}`;
  const projectKeys = new Map(selectedProjects.map((project) => [text(project.id), `project:${text(team?.slug, "team")}/${text(project.slug)}`]));
  const resources = { teams: [{ key: teamKey, slug: text(team?.slug), name: text(team?.name) }], projects: selectedProjects.map((project) => {
    const configuration = jsonObject(project.metadata_json);
    return { key: projectKeys.get(text(project.id)), team: teamKey, slug: text(project.slug), name: text(project.name), description: text(project.description), kind: text(configuration.kind), repository: object(configuration.repository), architecture: object(configuration.architecture) };
  }) };
  const provider = chosen ? await dependencies.store.first(`SELECT provider.id, provider.display_name,
		capacity_grant.metadata_json AS grant_metadata_json,
		capacity_grant.execution_provider_ids_json
		FROM capacity_grants capacity_grant
		JOIN capacity_providers provider ON provider.id = capacity_grant.capacity_provider_id
		JOIN capacity_provider_team_memberships membership ON membership.id = capacity_grant.membership_id
		WHERE capacity_grant.team_id = ? AND capacity_grant.project_id = ? AND capacity_grant.status = 'active'
			AND membership.team_id = ? AND membership.status = 'approved' AND provider.status = 'active'
		ORDER BY capacity_grant.updated_at DESC LIMIT 1`, [teamId, chosen.id, teamId]) : null;
  const providerResourceKey = text(jsonObject(provider?.grant_metadata_json).seedResourceKey);
  const executionProviderIds = Array.isArray(provider?.execution_provider_ids_json) ? provider.execution_provider_ids_json.map(text).filter(Boolean) : (() => {
    try {
      const parsed = JSON.parse(text(provider?.execution_provider_ids_json, "[]"));
      return Array.isArray(parsed) ? parsed.map(text).filter(Boolean) : [];
    } catch {
      return [];
    }
  })();
  const executionProviderId = executionProviderIds[0] ?? "";
  const seed = { name: `agent-lab-${text(team?.slug, "team")}`, version: 1, description: `Portable Agent Lab profile for ${text(chosen?.name, team?.name, "team")}.`, defaultEnvironments: ["local"], environments: ["local"], references: providerResourceKey ? [providerResourceKey] : [], resources, runtime: { agentLabServicePrincipals: [{ key: `service-principal:${text(team?.slug)}/agent-lab`, environments: ["local"], team: teamKey, name: "Agent Lab Service Principal", roles: ["team_owner"] }] } };
  const connection = chosen ? await resolveKnowledgeGatewayConnection(dependencies.store, { projectId: text(chosen.id), write: false, authoringPaths: true }) : null;
  const authoringRef = connection ? `refs/heads/${connection.authoringBranch.replace(/^refs\/heads\//u, "")}` : "";
  const refs = connection ? await connection.client.listRepositoryRefs(connection.repositoryId).catch(() => []) : [];
  const observed = refs.find((entry) => entry.name === authoringRef || entry.name === connection?.authoringBranch);
  const definitions = chosen && observed ? await agentLabRepositoryDefinitions(dependencies, [chosen], text(observed.target, observed.sha)) : [];
  const configuredAgents = [...new Set(definitions.filter((entry) => entry.kind === "agent" && object(entry.data).valid === true).map((entry) => object(object(entry.data).definition)).filter((definition) => definition.enabled !== false).map((definition) => text(definition.slug, definition.id)).filter(Boolean))];
  const selectedAgents = simulationOptions.agentSlugs.length ? configuredAgents.filter((slug) => simulationOptions.agentSlugs.includes(slug)) : configuredAgents;
  const missingAgents = simulationOptions.agentSlugs.filter((slug) => !configuredAgents.includes(slug));
  const generatedTestId = "agent-lab-project-inventory";
  const selectedTest = selectedAgents.length && !missingAgents.length ? generatedTestId : "";
  const testPath = connection ? `${connection.contentPath}/agent-tests/${generatedTestId}.mdx` : "";
  const testMdx = selectedTest ? `---
${stringifyYaml({ id: `agent-test:${generatedTestId}`, agent: selectedAgents[0], kind: "workday", trigger: { planningOnly: true, agents: selectedAgents }, expect: { productionPath: true, everySelectedAgent: true, durableModeRuns: true, treeDxOnlyContentAccess: true, usageAndSettlement: true }, groupIds: [] }, { lineWidth: 0 }).trim()}
---

Run the enabled agents for this project through a real planning-only workday using the normal provider, AgentKernel, TreeDX, usage, and settlement paths.
` : "";
  const seedPath = `seeds/${seed.name}.yaml`;
  const scenePath = `scenes/agent-lab/${text(team?.slug, "team")}-browser-demo.yaml`;
  const graphDiagnostics = chosen && selectedTest ? await validateAgentLabSimulationSelection(dependencies.store, text(chosen.id), { ...simulationOptions, agentSlugs: selectedAgents }) : [];
  const scene = { schemaVersion: "treeseed.scene/v1", id: `${text(team?.slug, "team")}-browser-demo`, title: `${text(team?.name, "Team")} Agent Lab Demo`, description: "Team-scoped retained cooperative planning simulation.", audience: ["operator"], journey: { kind: "agent-lab", proves: [] }, mode: { test: false, demo: true, training: false }, runtime: { mode: "demo" }, target: { app: "market", environment: "local", baseUrl: "auto", browser: "chromium", viewport: { width: 1440, height: 900 } }, setup: { dev: { required: false, reuseExisting: true }, seeds: [{ name: seed.name, environments: ["local"], apply: false }] }, artifacts: { trace: false, video: false, screenshots: false, console: true, network: true, timeline: true, appLogs: true }, workflow: [], agentLab: { scope: { kind: "team", team: teamKey, capacityProvider: providerResourceKey }, provider: "local", executionProvider: executionProviderId, presentation: "race-control", repositories: chosen ? [text(chosen.slug)] : [], workdays: [{ id: "cooperative-planning-demo", title: "Cooperative Planning Demo", agentTests: selectedTest ? [selectedTest] : [], durationSeconds: simulationOptions.durationSeconds, timePolicy: { cooperativePlanningPercent: 90, governedExecutionPercent: 0, reservePercent: 10 }, planningSession: { rounds: simulationOptions.planningRounds, assignmentTimeboxSeconds: simulationOptions.assignmentTimeboxSeconds, tokenWarning: 12e3 }, maxActiveAssignments: simulationOptions.maxActiveAssignments, planningOnly: true, activityTypes: simulationOptions.activityTypes }] }, training: { enabled: false } };
  return { projectId: text(chosen?.id), projectName: text(chosen?.name), seedPath, scenePath, testPath: selectedTest ? testPath : "", seedYaml: stringifyYaml(seed, { lineWidth: 0 }), sceneYaml: stringifyYaml(scene, { lineWidth: 0 }), testMdx: selectedTest ? testMdx : "", expectedBase: text(observed?.target, observed?.sha), diagnostics: [...chosen ? [] : [{ severity: "error", message: "Choose a project from this team before generating a simulation." }], ...providerResourceKey && executionProviderId ? [] : [{ severity: "error", message: "No reconciled seed-backed capacity provider has an active grant for this project." }], ...missingAgents.length ? [{ severity: "error", message: `Requested agents are not enabled in this project: ${missingAgents.join(", ")}.`, path: "agents" }] : [], ...selectedTest ? [] : [{ severity: "error", message: "The selected project has no enabled repository-backed agents for a workday test." }], ...graphDiagnostics, ...!observed ? [{ severity: "error", message: "The TreeDX authoring branch could not be resolved to an exact commit." }] : []] };
}
function installOperatorAgentLabAuthoringRoutes(app, dependencies) {
	installAgentDeploymentRoutes(app,dependencies,commitBundle);
  app.get("/v1/teams/:teamId/agent-lab/surfaces/build/draft", async (c) => {
    const access = await dependencies.manage(c);
    if (access.response) return access.response;
    return c.json({ ok: true, payload: await agentLabSimulationDraft(dependencies, c.req.param("teamId"), c.req.query("project"), parseAgentLabSimulationDraftOptions((name) => c.req.query(name))) });
  });
  app.post("/v1/teams/:teamId/agent-lab/surfaces/build/authoring", async (c) => {
    const access = await dependencies.manage(c);
    if (access.response) return access.response;
    return commitBundle(c, dependencies, await compileIntentRequest(dependencies, await readCapacityRequestObject(c)));
  });
  app.post("/v1/teams/:teamId/agent-lab/surfaces/build/authoring-bundle", async (c) => {
    const access = await dependencies.manage(c);
    if (access.response) return access.response;
    return commitBundle(c, dependencies, await readCapacityRequestObject(c));
  });
  app.post("/v1/teams/:teamId/agent-lab/surfaces/build/authoring-group", async (c) => {
    const access = await dependencies.manage(c);
    if (access.response) return access.response;
    const body = await readCapacityRequestObject(c);
    return commitBundle(c, dependencies, await compileGroupRequest(dependencies, body));
  });
  app.post("/v1/teams/:teamId/agent-lab/questions/answer", async (c) => {
    const access = await dependencies.manage(c);
    if (access.response) return access.response;
    const body = await readCapacityRequestObject(c);
    const projectId = text(body.projectId);
    const path = text(body.path).replace(/^\/+|\/+$/gu, "");
    const answer = text(body.answer).trim();
    const project = await dependencies.store.first("SELECT id FROM projects WHERE id = ? AND team_id = ? LIMIT 1", [projectId, c.req.param("teamId")]);
    if (!project || !answer) return c.json({ ok: false, code: "agent_lab_question_answer_invalid", error: "Choose a team question and provide an answer." }, 422);
    const connection = await resolveKnowledgeGatewayConnection(dependencies.store, { projectId, write: true, relationPaths: true });
    if (!connection || !path.startsWith(`${connection.contentPath}/questions/`)) return c.json({ ok: false, code: "agent_lab_question_path_invalid", error: "The question is outside this project\u2019s canonical question collection." }, 422);
    const branchName = `refs/heads/${connection.authoringBranch.replace(/^refs\/heads\//u, "")}`;
    const workspace = await connection.client.createWorkspace({ repoId: connection.repositoryId, baseRef: branchName, branchName, mode: "writable", allowedPaths: connection.allowedPaths, ttlSeconds: 600 });
    if (text(body.expectedBase) && text(body.expectedBase) !== workspace.baseCommitSha) {
      await connection.client.closeWorkspace(workspace.workspaceId).catch(() => {
      });
      return c.json({ ok: false, code: "agent_lab_question_conflict", error: "The question changed before this answer was submitted.", currentBase: workspace.baseCommitSha }, 409);
    }
    try {
      const read = await connection.client.readRepositoryFile({ repoId: connection.repositoryId, ref: workspace.baseCommitSha, path, encoding: "utf8", maxBytes: 196608 });
      const before = text(object(read.file).content);
      const parsed = parseFrontmatterDocument(before);
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const source = `---
${stringifyYaml({ ...object(parsed.frontmatter), status: "answered", answer, answeredAt: now, answeredBy: access.principal?.id ?? "team-owner" }, { lineWidth: 0 }).trim()}
---
${parsed.body}`;
      const validation = parseValidatedQuestionContent(path, source);
      if (!validation.ok) {
        await connection.client.closeWorkspace(workspace.workspaceId).catch(() => {
        });
        return c.json({ ok: false, code: "agent_lab_question_content_invalid", error: "Correct the question fields before submitting an answer.", model: "question", diagnostics: validation.diagnostics }, 422);
      }
      const changeset = await applyTextChangeset({ client: connection.client, workspace, changes: [{ path, before, after: source }] });
      const commit = await connection.client.commit({ workspaceId: workspace.workspaceId, message: `agent-lab: answer ${path}`, author: { name: access.principal?.name ?? "Agent Lab operator", email: access.principal?.email ?? "agent-lab@users.treeseed.local" } });
      await recordTreeDxAuthoringState(dependencies.store,"unpublished",{ projectId,repositoryId:connection.repositoryId,commitSha:commit.commitSha,ref:commit.branchName,changedPaths:commit.changedPaths,actorType:"user",actorId:access.principal?.id });
      const publication = await publishAuthoringCommit(dependencies, projectId, branchName, commit.commitSha);
      await recordTreeDxAuthoringState(dependencies.store,"integrated",{ projectId,repositoryId:connection.repositoryId,commitSha:commit.commitSha,ref:commit.branchName,changedPaths:commit.changedPaths,actorType:"user",actorId:access.principal?.id });
      await projectTreeDxCommitSignals(dependencies.store, { projectId, commitSha: commit.commitSha, immutableRef: commit.branchName, changedPaths: commit.changedPaths, changeSummary: "Answer team question", actorType: "user", actorId: access.principal?.id });
      return c.json({ ok: true, payload: { commit: commit.commitSha, status: "answered", changeset: { ...changeset, resultCommitSha: commit.commitSha }, publication } });
    } catch (error) {
      await connection.client.closeWorkspace(workspace.workspaceId).catch(() => {
      });
      return c.json({ ok: false, code: "agent_lab_question_answer_failed", error: error instanceof Error ? error.message : "The answer could not be committed." }, 409);
    }
  });
}
export {
  agentLabSimulationDraft,
  installOperatorAgentLabAuthoringRoutes
};
