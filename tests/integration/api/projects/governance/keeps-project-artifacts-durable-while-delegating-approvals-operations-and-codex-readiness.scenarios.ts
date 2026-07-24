import { AgentSdk, ApiTestOptions, DataType, MarketControlPlaneStore, MarketPostgresDatabase, PlatformRunnerClient, afterEach, authorizeApp, createPlatformApiApp, createDeploymentReadyProject, createRunnerRepoFixture, createServer, createTeam, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, encryptHostConfig, encryptedHostEnvelope, encryptedTestHostEnvelope, execFileSync, existsSync, expect, getApiMocks, git, it, json, listManagedHostsFromConfig, mkdirSync, mkdtempSync, mockCloudflareDnsPreflight, newDb, resolve, rmSync, runOnceWithClient, tmpdir, Core, unsignedTestJwt, vi, waitForCondition, withEnv, withHttpMarketApp, writeFileSync } from '../../../../support/api-harness.ts';

describe('market api', () => {
it('keeps project artifacts durable while delegating approvals, operations, and Codex readiness', async () => {
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === 'https://project.example.com/v1/agent-artifacts') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						items: [{
							artifactKind: 'knowledge_draft',
							id: 'knowledge:runtime',
							title: 'Runtime',
							targetPath: 'src/content/knowledge/architecture/runtime/runtime.mdx',
							totalScore: 29,
							recommendation: 'promote',
						}],
						warnings: [],
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/agent-artifacts/knowledge%3Aruntime') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						artifact: {
							id: 'knowledge:runtime',
							artifactKind: 'knowledge_draft',
							title: 'Runtime',
						},
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/agent-artifacts/knowledge%3Aruntime/source-map') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						artifactId: 'knowledge:runtime',
						sourceMap: [{ path: 'packages/agent/src/services/manager.ts', evidence: 'direct' }],
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/agent-artifacts/knowledge%3Aruntime/diff') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						artifactId: 'knowledge:runtime',
						changedPaths: ['src/content/knowledge/architecture/runtime/runtime.mdx'],
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/approvals') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						items: [{ id: 'promotion:runtime', taskId: 'task-promote' }],
						warnings: [],
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/approvals/promotion%3Aruntime') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						approval: { id: 'promotion:runtime', state: 'pending' },
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/agents/status') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						agents: [{ agentSlug: 'architect', handler: 'writer', status: 'idle' }],
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/research-notes') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						items: [{ taskId: 'task-research', researchNote: { id: 'research:runtime' } }],
						warnings: [],
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/knowledge-drafts') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						items: [{ taskId: 'task-draft', knowledgeDraft: { id: 'knowledge:runtime', title: 'Runtime' } }],
						warnings: [],
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/optimization-reports') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						items: [{ taskId: 'task-optimize', optimizationReport: { id: 'optimization:runtime', draftId: 'knowledge:runtime', totalScore: 29, recommendation: 'promote' } }],
						warnings: [],
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/approvals/promotion%3Aruntime/decision') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						id: 'promotion:runtime',
						decision: JSON.parse(String(init?.body ?? '{}')).decision,
						releaseAttempted: false,
						stagingAttempted: false,
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/providers/codex/readiness') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						ok: true,
						providerSelected: true,
						sdkInstalled: true,
						nodeVersionOk: true,
						authDetected: false,
						subscriptionPlan: 'pro',
						warnings: [],
						blockingIssues: [],
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/operations/grants') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						items: [{
							id: 'grant-stage-docs',
							operations: ['stage'],
							modes: ['plan'],
							allowedPaths: ['src/content/knowledge/**'],
						}],
						warnings: [],
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/operations/events') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						items: [{
							id: 'event-stage-1',
							operation: 'stage',
							status: 'completed',
							changedPaths: ['src/content/knowledge/architecture/runtime/runtime.mdx'],
							stagedPaths: ['src/content/knowledge/architecture/runtime/runtime.mdx'],
						}],
						lifecycle: {
							worktreeSnapshots: [{ kind: 'verified_snapshot', taskId: 'task-promote' }],
							stagingMerges: [{ mergedToStaging: true, commitSha: 'abc123' }],
							mergeFailures: [],
							repairTasks: [],
							releaseApprovals: [],
							releaseResults: [],
							codexUsage: [],
						},
						warnings: [],
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/operations/stage/plan') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						planOnly: true,
						decision: { allowed: true },
						result: { status: 'completed' },
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/workdays/current') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						id: 'workday-1',
						state: 'active',
						updatedAt: '2026-05-13T00:00:00.000Z',
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (url === 'https://project.example.com/v1/workdays/reports') {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						projectId: 'hosted-project',
						items: [{ id: 'report-1', kind: 'workday_summary', workDayId: 'workday-1', createdAt: '2026-05-13T00:01:00.000Z' }],
						warnings: [],
					},
				}), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			return new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } });
		});
		const app = createTestApp({ fetchImpl: fetchMock as unknown as typeof fetch });
		const token = await authorizeApp(app);
		const { project } = await createTeamAndProject(app, token, {
			id: 'hosted-project',
			slug: 'hosted-project',
			name: 'Hosted Project',
		});

		await app.request(`/v1/projects/${project.id}/connection`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				mode: 'hosted',
				projectApiBaseUrl: 'https://project.example.com',
				metadata: {
					projectApiKey: 'hosted-project-key',
				},
			}),
		});

		const headers = { authorization: `Bearer ${token}` };
		const artifacts = await json(await app.request(`/v1/projects/${project.id}/agent-artifacts`, { headers }));
		expect(artifacts.payload).toMatchObject({ items: [], warnings: [] });

		const artifactDetail = await app.request(`/v1/projects/${project.id}/agent-artifacts/knowledge%3Aruntime`, { headers });
		expect(artifactDetail.status).toBe(404);

		const sourceMap = await app.request(`/v1/projects/${project.id}/agent-artifacts/knowledge%3Aruntime/source-map`, { headers });
		expect(sourceMap.status).toBe(404);

		const artifactDiff = await app.request(`/v1/projects/${project.id}/agent-artifacts/knowledge%3Aruntime/diff`, { headers });
		expect(artifactDiff.status).toBe(404);

		const approvals = await json(await app.request(`/v1/projects/${project.id}/approvals`, { headers }));
		expect(approvals.payload.items).toEqual([expect.objectContaining({ id: 'promotion:runtime' })]);

		const approvalDetail = await json(await app.request(`/v1/projects/${project.id}/approvals/promotion%3Aruntime`, { headers }));
		expect(approvalDetail.payload.approval).toMatchObject({ id: 'promotion:runtime' });

		const operationGrants = await json(await app.request(`/v1/projects/${project.id}/operations/grants`, { headers }));
		expect(operationGrants.payload.items).toEqual([expect.objectContaining({ id: 'grant-stage-docs' })]);

		const operationEvents = await json(await app.request(`/v1/projects/${project.id}/operations/events`, { headers }));
		expect(operationEvents.payload.items).toEqual([expect.objectContaining({ operation: 'stage' })]);
		expect(operationEvents.payload.lifecycle).toMatchObject({
			worktreeSnapshots: [expect.objectContaining({ kind: 'verified_snapshot' })],
			stagingMerges: [expect.objectContaining({ mergedToStaging: true })],
		});

		const operationPlan = await json(await app.request(`/v1/projects/${project.id}/operations/stage/plan`, {
			method: 'POST',
			headers: {
				...headers,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ request: { mode: 'plan' } }),
		}));
		expect(operationPlan.payload).toMatchObject({
			planOnly: true,
			result: { status: 'completed' },
		});

		const delegatedDecision = await json(await app.request(`/v1/projects/${project.id}/approvals/promotion%3Aruntime/decision`, {
			method: 'POST',
			headers: {
				...headers,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ decision: 'approve_as_book_content', reason: 'Reviewed in Agents page.' }),
		}));
		expect(delegatedDecision.payload).toMatchObject({
			id: 'promotion:runtime',
			decision: 'approve_as_book_content',
			releaseAttempted: false,
			stagingAttempted: false,
		});
		const decisionCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/v1/approvals/promotion%3Aruntime/decision'));
		expect(decisionCall?.[1]).toMatchObject({ method: 'POST' });
		expect(JSON.parse(String(decisionCall?.[1]?.body ?? '{}'))).toMatchObject({
			decision: 'approve_as_book_content',
			reason: 'Reviewed in Agents page.',
		});

		const delegatedAliasDecision = await json(await app.request(`/v1/projects/${project.id}/approvals/promotion%3Aruntime/decision`, {
			method: 'POST',
			headers: {
				...headers,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ decision: 'approve', reason: 'Reviewed from the governance table.' }),
		}));
		expect(delegatedAliasDecision.payload).toMatchObject({
			id: 'promotion:runtime',
			decision: 'approve',
		});

		const invalidDecision = await app.request(`/v1/projects/${project.id}/approvals/promotion%3Aruntime/decision`, {
			method: 'POST',
			headers: {
				...headers,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ decision: 'publish_release' }),
		});
		expect(invalidDecision.status).toBe(400);
		expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/v1/approvals/promotion%3Aruntime/decision'))).toHaveLength(2);

		const readiness = await json(await app.request(`/v1/projects/${project.id}/providers/codex/readiness`, { headers }));
		expect(readiness.payload).toMatchObject({ providerSelected: true, subscriptionPlan: 'pro' });

		const agents = await json(await app.request(`/v1/projects/${project.id}/agents`, { headers }));
		expect(agents.payload).toMatchObject({
			projectId: 'hosted-project',
			agents: [expect.objectContaining({ agentSlug: 'architect' })],
			generatedArtifacts: [],
			researchNotes: [],
			knowledgeDrafts: [],
			optimizationReports: [],
			approvals: [],
			operationGrants: [],
			operationEvents: [],
			operationLifecycle: expect.objectContaining({
				worktreeSnapshots: [],
				stagingMerges: [],
			}),
			codexReadiness: expect.objectContaining({ providerSelected: true, subscriptionPlan: 'pro' }),
			currentWorkday: null,
			runtimeReports: [],
			docsAutomation: expect.objectContaining({
				researchNoteCount: 0,
				knowledgeDraftCount: 0,
				optimizationReportCount: 0,
				generatedArtifactCount: 0,
			}),
		});

		const agentDetail = await json(await app.request(`/v1/projects/${project.id}/agents/architect`, { headers }));
		expect(agentDetail.payload.agent).toMatchObject({ agentSlug: 'architect', handler: 'writer' });

		const disconnectedProjectResponse = await json(await app.request(`/v1/teams/${project.teamId}/projects`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				id: 'disconnected-project',
				slug: 'disconnected-project',
				name: 'Disconnected Project',
			}),
		}));
		const disconnectedProject = disconnectedProjectResponse.payload.project;
		const fallback = await json(await app.request(`/v1/projects/${disconnectedProject.id}/agent-artifacts`, { headers }));
		expect(fallback.payload).toMatchObject({
			items: [],
			warnings: [],
		});
		const fallbackOperations = await json(await app.request(`/v1/projects/${disconnectedProject.id}/operations/grants`, { headers }));
		expect(fallbackOperations.payload).toMatchObject({
			items: [],
			warnings: ['Project runtime is not connected or unavailable.'],
		});

		const fallbackDryRun = await app.request(`/v1/projects/${disconnectedProject.id}/operations/stage/plan`, {
			method: 'POST',
			headers: {
				...headers,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ request: { mode: 'plan' } }),
		});
		expect(fallbackDryRun.status).toBe(409);

		const unavailableDecision = await json(await app.request(`/v1/projects/${disconnectedProject.id}/approvals/promotion%3Aruntime/decision`, {
			method: 'POST',
			headers: {
				...headers,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ decision: 'reject' }),
		}));
		expect(unavailableDecision).toMatchObject({
			ok: false,
			payload: {
				approvalId: 'promotion:runtime',
				warnings: ['Project runtime is not connected or unavailable.'],
				releaseAttempted: false,
				stagingAttempted: false,
			},
		});

		const disconnectedAgents = await json(await app.request(`/v1/projects/${disconnectedProject.id}/agents`, { headers }));
		expect(disconnectedAgents.payload).toMatchObject({
			generatedArtifacts: [],
			approvals: [],
			operationGrants: [],
			operationEvents: [],
			operationLifecycle: expect.objectContaining({
				worktreeSnapshots: [],
				stagingMerges: [],
			}),
			currentWorkday: null,
			runtimeReports: [],
			runtimeWarnings: ['Project runtime is not connected or unavailable.'],
		});
	});
});
