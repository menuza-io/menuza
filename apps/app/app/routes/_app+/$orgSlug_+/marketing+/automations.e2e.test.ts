import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as PermissionsModule from '#app/utils/organization/permissions.server.ts'
import {
	requireAnyUserWithOrganizationPermission,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import * as tenantApiServer from '#app/utils/tenant-api.server.ts'
import {
	loader as runsLoader,
	action as runsAction,
} from './automations.$journeyId.runs.tsx'
import {
	loader as detailLoader,
	action as detailAction,
} from './automations.$journeyId.tsx'
import {
	loader as indexLoader,
	action as indexAction,
} from './automations._index.tsx'
import { action as newAction } from './automations.new.tsx'
import { activateTestLingui } from './test-lingui.ts'

vi.mock(
	'#app/utils/organization/permissions.server.ts',
	async (importOriginal) => {
		const actual = await importOriginal<typeof PermissionsModule>()
		return {
			...actual,
			requireUserWithOrganizationPermission: vi.fn(),
			requireAnyUserWithOrganizationPermission: vi.fn(),
		}
	},
)

describe('Marketing Journeys UI & Route End-to-End Integration Suite', () => {
	let mockFetchTenant: ReturnType<typeof vi.fn>
	const testOrgSlug = 'epic-tenant'
	const testOrgId = 'org_abc_123'
	const testJourneyId = '550e8400-e29b-41d4-a716-446655440000'

	beforeEach(() => {
		activateTestLingui()
		mockFetchTenant = vi.fn()
		vi.mocked(requireUserWithOrganizationPermission).mockResolvedValue(
			'user_test_123',
		)
		vi.mocked(requireAnyUserWithOrganizationPermission).mockResolvedValue(
			'user_test_123',
		)
		vi.spyOn(tenantApiServer, 'getOperatorTenantClient').mockResolvedValue({
			orgId: testOrgId,
			orgSlug: testOrgSlug,
			dataRegion: 'us',
			jwt: 'mock-operator-jwt',
			tenantApiUrl: 'http://localhost:3007',
			fetchTenant: mockFetchTenant as any,
		})
	})

	describe('1. Journeys Index Route (automations._index.tsx)', () => {
		it('loader fetches and formats journey overview list', async () => {
			mockFetchTenant.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						journeys: [
							{
								id: testJourneyId,
								name: 'Welcome Series',
								description: 'Onboarding flow',
								status: 'active',
								triggerType: 'phone_verified',
								nodes: [{ id: '1' }, { id: '2' }],
								stats: { total: 15, running: 5, completed: 10, failed: 0 },
							},
						],
					}),
					{ status: 200 },
				),
			)

			const request = new Request(
				`http://localhost:3001/${testOrgSlug}/marketing/journeys`,
			)
			const result = await indexLoader({
				request,
				params: { orgSlug: testOrgSlug },
				context: {},
			} as any)

			expect(mockFetchTenant).toHaveBeenCalledWith('/operator/journeys')
			expect(result.journeys).toHaveLength(1)
			expect(result.journeys[0]!.name).toBe('Welcome Series')
			expect(result.journeys[0]!.stepCount).toBe(2)
		})

		it('action handles publish intent from index list', async () => {
			mockFetchTenant.mockResolvedValueOnce(
				new Response(JSON.stringify({ success: true, status: 'active' }), {
					status: 200,
				}),
			)

			const formData = new FormData()
			formData.set('intent', 'publish')
			formData.set('journeyId', testJourneyId)

			const request = new Request(
				`http://localhost:3001/${testOrgSlug}/marketing/journeys`,
				{
					method: 'POST',
					body: formData,
				},
			)

			const result = await indexAction({
				request,
				params: { orgSlug: testOrgSlug },
				context: {},
			} as any)

			expect(mockFetchTenant).toHaveBeenCalledWith(
				`/operator/journeys/${testJourneyId}/publish`,
				{
					method: 'POST',
				},
			)
			expect(result).toEqual({ success: true })
		})
	})

	describe('2. New Journey Route (automations.new.tsx)', () => {
		it('action creates draft journey and returns redirect response', async () => {
			mockFetchTenant.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						success: true,
						journey: { id: testJourneyId },
					}),
					{ status: 201 },
				),
			)

			const formData = new FormData()
			formData.set('name', 'New Signup Series')
			formData.set(
				'graphJson',
				JSON.stringify({
					nodes: [
						{
							id: 't1',
							type: 'trigger',
							data: { triggerType: 'phone_verified' },
						},
					],
					edges: [],
				}),
			)
			formData.set('publish', 'false')

			const request = new Request(
				`http://localhost:3001/${testOrgSlug}/marketing/journeys/new`,
				{
					method: 'POST',
					body: formData,
				},
			)

			const response = await newAction({
				request,
				params: { orgSlug: testOrgSlug },
				context: {},
			} as any)

			expect(response).toHaveProperty('status', 302)
			expect((response as Response).headers.get('Location')).toBe(
				`/${testOrgSlug}/marketing/automations/${testJourneyId}`,
			)
		})
	})

	describe('3. Journey Detail & Visual Canvas Route (automations.$journeyId.tsx)', () => {
		it('loader fetches journey definition', async () => {
			mockFetchTenant.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						journey: {
							id: testJourneyId,
							name: 'Active Welcome Journey',
							description: 'Onboarding',
							status: 'active',
							triggerType: 'phone_verified',
							nodes: [
								{
									id: 'n1',
									type: 'trigger',
									data: { triggerType: 'phone_verified' },
								},
							],
							edges: [],
							graphJson: '{"nodes":[],"edges":[]}',
							version: 2,
							publishedAt: new Date().toISOString(),
						},
					}),
					{ status: 200 },
				),
			)

			const request = new Request(
				`http://localhost:3001/${testOrgSlug}/marketing/journeys/${testJourneyId}`,
			)
			const result = await detailLoader({
				request,
				params: { orgSlug: testOrgSlug, journeyId: testJourneyId },
				context: {},
			} as any)

			expect(mockFetchTenant).toHaveBeenCalledWith(
				`/operator/journeys/${testJourneyId}`,
			)
			expect(result.journey.name).toBe('Active Welcome Journey')
			expect(result.journey.id).toBe(testJourneyId)
			expect(result.journey.nodes).toHaveLength(1)
		})

		it('action handles save intent with updated graphJson', async () => {
			mockFetchTenant.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						success: true,
						journeyId: testJourneyId,
						version: 3,
					}),
					{ status: 200 },
				),
			)

			const graphData = {
				nodes: [
					{
						id: 't',
						type: 'trigger',
						data: { triggerType: 'phone_verified' },
					},
					{
						id: 'e',
						type: 'action_email',
						data: { subject: 'Hi', bodyHtml: '<p>Hi</p>' },
					},
				],
				edges: [{ id: 'e1', source: 't', target: 'e' }],
			}

			const formData = new FormData()
			formData.set('intent', 'save')
			formData.set('name', 'Updated Journey Name')
			formData.set('graphJson', JSON.stringify(graphData))

			const request = new Request(
				`http://localhost:3001/${testOrgSlug}/marketing/journeys/${testJourneyId}`,
				{
					method: 'POST',
					body: formData,
				},
			)

			const result = await detailAction({
				request,
				params: { orgSlug: testOrgSlug, journeyId: testJourneyId },
				context: {},
			} as any)

			expect(mockFetchTenant).toHaveBeenCalledWith(
				`/operator/journeys/${testJourneyId}`,
				expect.objectContaining({
					method: 'PUT',
				}),
			)
			expect(result).toEqual({
				success: true,
				message: 'Automation saved successfully',
			})
		})

		it('action successfully publishes when graph is valid', async () => {
			mockFetchTenant
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ success: true }), { status: 200 }),
				)
				.mockResolvedValueOnce(
					new Response(
						JSON.stringify({
							success: true,
							status: 'active',
							publishedAt: new Date().toISOString(),
						}),
						{ status: 200 },
					),
				)

			const validGraph = {
				nodes: [
					{
						id: 't',
						type: 'trigger',
						data: { triggerType: 'phone_verified' },
					},
					{ id: 'd', type: 'delay', data: { duration: 1, unit: 'hours' } },
				],
				edges: [{ id: 'e1', source: 't', target: 'd' }],
			}

			const formData = new FormData()
			formData.set('intent', 'publish')
			formData.set('name', 'Valid Journey')
			formData.set('graphJson', JSON.stringify(validGraph))

			const request = new Request(
				`http://localhost:3001/${testOrgSlug}/marketing/journeys/${testJourneyId}`,
				{
					method: 'POST',
					body: formData,
				},
			)

			const result = await detailAction({
				request,
				params: { orgSlug: testOrgSlug, journeyId: testJourneyId },
				context: {},
			} as any)

			expect(result).toEqual({
				success: true,
				message: 'Automation published and activated!',
			})
		})

		it('action handles test_run trigger', async () => {
			mockFetchTenant.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						success: true,
						runId: 'run_test_999',
						status: 'running',
					}),
					{ status: 200 },
				),
			)

			const formData = new FormData()
			formData.set('intent', 'test_run')
			formData.set('customerId', 'cust_alice_456')

			const request = new Request(
				`http://localhost:3001/${testOrgSlug}/marketing/journeys/${testJourneyId}`,
				{
					method: 'POST',
					body: formData,
				},
			)

			const result = await detailAction({
				request,
				params: { orgSlug: testOrgSlug, journeyId: testJourneyId },
				context: {},
			} as any)

			expect(mockFetchTenant).toHaveBeenCalledWith(
				'/operator/journeys/trigger-test',
				expect.objectContaining({
					method: 'POST',
					body: JSON.stringify({
						journeyId: testJourneyId,
						customerId: 'cust_alice_456',
					}),
				}),
			)
			expect((result as any).runId).toBe('run_test_999')
			expect((result as any).success).toBe(true)
		})
	})

	describe('4. Journey Runs & Step Execution Audit History (automations.$journeyId.runs.tsx)', () => {
		it('loader fetches runs history and journey details', async () => {
			mockFetchTenant
				.mockResolvedValueOnce(
					new Response(
						JSON.stringify({
							journey: {
								id: testJourneyId,
								name: 'Onboarding Campaign',
								status: 'active',
								triggerType: 'phone_verified',
							},
						}),
						{ status: 200 },
					),
				)
				.mockResolvedValueOnce(
					new Response(
						JSON.stringify({
							runs: [
								{
									id: 'run_001',
									journeyId: testJourneyId,
									customerId: 'cust_001',
									status: 'completed',
									startedAt: '2026-08-24T00:00:00Z',
									completedAt: '2026-08-24T00:01:00Z',
								},
							],
						}),
						{ status: 200 },
					),
				)

			const request = new Request(
				`http://localhost:3001/${testOrgSlug}/marketing/journeys/${testJourneyId}/runs`,
			)
			const result = await runsLoader({
				request,
				params: { orgSlug: testOrgSlug, journeyId: testJourneyId },
				context: {},
			} as any)

			expect(result.journey.name).toBe('Onboarding Campaign')
			expect(result.runs).toHaveLength(1)
			expect(result.runs[0]!.id).toBe('run_001')
			expect(result.runs[0]!.status).toBe('completed')
		})

		it('action loads step execution timeline for a specific run', async () => {
			mockFetchTenant.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						steps: [
							{
								id: 'step_1',
								nodeId: 'node_email_1',
								nodeType: 'action_email',
								status: 'delivered',
								executedAt: '2026-08-24T00:00:10Z',
								executionDetails: '{"messageId":"resend-123"}',
							},
						],
					}),
					{ status: 200 },
				),
			)

			const formData = new FormData()
			formData.set('runId', 'run_001')

			const request = new Request(
				`http://localhost:3001/${testOrgSlug}/marketing/journeys/${testJourneyId}/runs`,
				{
					method: 'POST',
					body: formData,
				},
			)

			const result = await runsAction({
				request,
				params: { orgSlug: testOrgSlug, journeyId: testJourneyId },
				context: {},
			} as any)

			expect(mockFetchTenant).toHaveBeenCalledWith(
				'/operator/journeys/runs/run_001',
			)
			expect((result as any).timeline).toHaveLength(1)
			expect((result as any).timeline[0]!.nodeId).toBe('node_email_1')
			expect((result as any).timeline[0]!.status).toBe('delivered')
		})
	})
})
