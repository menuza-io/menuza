import { describe, it, expect, vi, beforeEach } from 'vitest'
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

describe('Marketing Journeys Routes Loaders & Actions', () => {
	let mockFetchTenant: ReturnType<typeof vi.fn>

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
			orgId: 'org_test_123',
			orgSlug: 'test-org',
			dataRegion: 'us',
			jwt: 'mock-jwt-token',
			tenantApiUrl: 'http://localhost:3007',
			fetchTenant: mockFetchTenant as any,
		})
	})

	describe('automations._index.tsx', () => {
		it('loader fetches and formats journey list', async () => {
			mockFetchTenant.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						journeys: [
							{
								id: 'j1',
								name: 'Welcome Series',
								description: 'Onboarding flow',
								status: 'active',
								triggerType: 'phone_verified',
								nodes: [{ id: '1' }, { id: '2' }],
								runsCount: 15,
							},
						],
					}),
					{ status: 200 },
				),
			)

			const request = new Request(
				'http://localhost:3001/test-org/marketing/journeys',
			)
			const result = await indexLoader({
				request,
				params: { orgSlug: 'test-org' },
				context: {},
			} as any)

			expect(mockFetchTenant).toHaveBeenCalledWith('/operator/journeys')
			expect(result.journeys).toHaveLength(1)
			expect(result.journeys[0]!.name).toBe('Welcome Series')
			expect(result.journeys[0]!.stepCount).toBe(2)
			expect(result.journeys[0]!.runsCount).toBe(15)
		})

		it('action handles publish intent', async () => {
			mockFetchTenant.mockResolvedValueOnce(
				new Response(JSON.stringify({ success: true }), { status: 200 }),
			)

			const formData = new FormData()
			formData.set('intent', 'publish')
			formData.set('journeyId', 'j1')

			const request = new Request(
				'http://localhost:3001/test-org/marketing/journeys',
				{
					method: 'POST',
					body: formData,
				},
			)

			const result = await indexAction({
				request,
				params: { orgSlug: 'test-org' },
				context: {},
			} as any)

			expect(mockFetchTenant).toHaveBeenCalledWith(
				'/operator/journeys/j1/publish',
				{
					method: 'POST',
				},
			)
			expect(result).toEqual({ success: true })
		})

		it('action handles pause and delete intents', async () => {
			mockFetchTenant.mockResolvedValue(
				new Response(JSON.stringify({ success: true }), { status: 200 }),
			)

			// Pause
			const pauseForm = new FormData()
			pauseForm.set('intent', 'pause')
			pauseForm.set('journeyId', 'j1')
			await indexAction({
				request: new Request('http://localhost/test', {
					method: 'POST',
					body: pauseForm,
				}),
				params: { orgSlug: 'test-org' },
				context: {},
			} as any)
			expect(mockFetchTenant).toHaveBeenCalledWith(
				'/operator/journeys/j1/pause',
				{
					method: 'POST',
				},
			)

			// Delete
			const deleteForm = new FormData()
			deleteForm.set('intent', 'delete')
			deleteForm.set('journeyId', 'j1')
			await indexAction({
				request: new Request('http://localhost/test', {
					method: 'POST',
					body: deleteForm,
				}),
				params: { orgSlug: 'test-org' },
				context: {},
			} as any)
			expect(mockFetchTenant).toHaveBeenCalledWith('/operator/journeys/j1', {
				method: 'DELETE',
			})
		})
	})

	describe('automations.new.tsx', () => {
		it('action creates new journey and redirects to editor', async () => {
			mockFetchTenant.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						success: true,
						journey: { id: 'journey_new_123' },
					}),
					{ status: 201 },
				),
			)

			const testGraph = {
				nodes: [
					{
						id: 't1',
						type: 'trigger',
						data: { triggerType: 'phone_verified', config: {} },
					},
				],
				edges: [],
			}

			const formData = new FormData()
			formData.set('name', 'My Brand New Journey')
			formData.set('graphJson', JSON.stringify(testGraph))
			formData.set('publish', 'false')

			const request = new Request(
				'http://localhost:3001/test-org/marketing/journeys/new',
				{
					method: 'POST',
					body: formData,
				},
			)

			const response = await newAction({
				request,
				params: { orgSlug: 'test-org' },
				context: {},
			} as any)

			expect(mockFetchTenant).toHaveBeenCalledWith(
				'/operator/journeys',
				expect.objectContaining({
					method: 'POST',
				}),
			)
			// Expect redirect Response to /test-org/marketing/automations/journey_new_123
			expect((response as Response).headers.get('Location')).toBe(
				'/test-org/marketing/automations/journey_new_123',
			)
		})
	})

	describe('automations.$journeyId.tsx', () => {
		it('loader fetches journey definition', async () => {
			mockFetchTenant.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						journey: {
							id: 'j_detail_1',
							name: 'Detail Journey',
							status: 'draft',
							triggerType: 'phone_verified',
							graphJson: JSON.stringify({ nodes: [], edges: [] }),
							nodes: [],
							edges: [],
						},
					}),
					{ status: 200 },
				),
			)

			const request = new Request(
				'http://localhost:3001/test-org/marketing/journeys/j_detail_1',
			)
			const result = await detailLoader({
				request,
				params: { orgSlug: 'test-org', journeyId: 'j_detail_1' },
				context: {},
			} as any)

			expect(mockFetchTenant).toHaveBeenCalledWith(
				'/operator/journeys/j_detail_1',
			)
			expect(result.journey.id).toBe('j_detail_1')
			expect(result.journey.name).toBe('Detail Journey')
		})

		it('action handles save draft intent', async () => {
			mockFetchTenant.mockResolvedValueOnce(
				new Response(JSON.stringify({ success: true }), { status: 200 }),
			)

			const testGraph = {
				nodes: [
					{
						id: 't1',
						type: 'trigger',
						data: { triggerType: 'phone_verified' },
					},
					{
						id: 'd1',
						type: 'delay',
						data: { duration: 5, unit: 'minutes' },
					},
				],
				edges: [{ id: 'e1', source: 't1', target: 'd1' }],
			}

			const formData = new FormData()
			formData.set('intent', 'save')
			formData.set('name', 'Updated Journey Name')
			formData.set('graphJson', JSON.stringify(testGraph))

			const request = new Request(
				'http://localhost:3001/test-org/marketing/journeys/j_detail_1',
				{
					method: 'POST',
					body: formData,
				},
			)

			const result = await detailAction({
				request,
				params: { orgSlug: 'test-org', journeyId: 'j_detail_1' },
				context: {},
			} as any)

			expect(mockFetchTenant).toHaveBeenCalledWith(
				'/operator/journeys/j_detail_1',
				expect.objectContaining({
					method: 'PUT',
				}),
			)
			expect(result).toEqual({
				success: true,
				message: 'Automation saved successfully',
			})
		})

		it('action handles test_run intent', async () => {
			mockFetchTenant.mockResolvedValueOnce(
				new Response(JSON.stringify({ success: true, runId: 'run_test_999' }), {
					status: 200,
				}),
			)

			const formData = new FormData()
			formData.set('intent', 'test_run')
			formData.set('customerId', 'cust_alice_456')

			const request = new Request(
				'http://localhost:3001/test-org/marketing/journeys/j_detail_1',
				{
					method: 'POST',
					body: formData,
				},
			)

			const result = await detailAction({
				request,
				params: { orgSlug: 'test-org', journeyId: 'j_detail_1' },
				context: {},
			} as any)

			expect(mockFetchTenant).toHaveBeenCalledWith(
				'/operator/journeys/trigger-test',
				expect.objectContaining({
					method: 'POST',
					body: JSON.stringify({
						journeyId: 'j_detail_1',
						customerId: 'cust_alice_456',
					}),
				}),
			)
			expect((result as any).success).toBe(true)
			expect((result as any).runId).toBe('run_test_999')
		})
	})

	describe('automations.$journeyId.runs.tsx', () => {
		it('loader fetches runs history and journey details', async () => {
			mockFetchTenant
				.mockResolvedValueOnce(
					new Response(
						JSON.stringify({
							journey: {
								id: 'j1',
								name: 'Welcome Journey',
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
									id: 'run_1',
									journeyId: 'j1',
									customerId: 'cust_1',
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
				'http://localhost:3001/test-org/marketing/journeys/j1/runs',
			)
			const result = await runsLoader({
				request,
				params: { orgSlug: 'test-org', journeyId: 'j1' },
				context: {},
			} as any)

			expect(result.journey.name).toBe('Welcome Journey')
			expect(result.runs).toHaveLength(1)
			expect(result.runs[0]!.id).toBe('run_1')
			expect(result.runs[0]!.status).toBe('completed')
		})

		it('action loads execution timeline for a specific run', async () => {
			mockFetchTenant.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						timeline: [
							{
								id: 'step_1',
								nodeId: 'node_email_1',
								nodeType: 'action_email',
								status: 'completed',
								attempt: 1,
							},
						],
					}),
					{ status: 200 },
				),
			)

			const formData = new FormData()
			formData.set('runId', 'run_1')

			const request = new Request(
				'http://localhost:3001/test-org/marketing/journeys/j1/runs',
				{
					method: 'POST',
					body: formData,
				},
			)

			const result = await runsAction({
				request,
				params: { orgSlug: 'test-org', journeyId: 'j1' },
				context: {},
			} as any)

			expect(mockFetchTenant).toHaveBeenCalledWith(
				'/operator/journeys/runs/run_1',
			)
			expect((result as any).timeline).toHaveLength(1)
			expect((result as any).timeline[0]!.nodeId).toBe('node_email_1')
		})
	})
})
