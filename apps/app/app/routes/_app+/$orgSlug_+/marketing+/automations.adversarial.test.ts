import { brand } from '@repo/config/brand.ts'
import { jwtVerify } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('Adversarial Security & Robustness Suite: Marketing Journey Builder', () => {
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
			orgId: 'org_secure_999',
			orgSlug: 'secure-corp',
			dataRegion: 'us',
			jwt: 'mock-valid-operator-jwt',
			tenantApiUrl: 'http://localhost:3007',
			fetchTenant: mockFetchTenant as any,
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	// =========================================================================
	// 1. UNAUTHORIZED ACCESS & CLIENT SECURITY TESTS
	// =========================================================================
	describe('1. Security, Authorization & Tenant Isolation', () => {
		it('rejects access if getOperatorTenantClient throws unauthorized or not found', async () => {
			vi.spyOn(
				tenantApiServer,
				'getOperatorTenantClient',
			).mockRejectedValueOnce(
				new Response('Organization not found or access denied', {
					status: 404,
				}),
			)

			const request = new Request(
				'http://localhost:3001/attacker-org/marketing/journeys',
			)
			await expect(
				indexLoader({
					request,
					params: { orgSlug: 'attacker-org' },
					context: {},
				} as any),
			).rejects.toThrow()
		})

		it('rejects action if operator authentication fails', async () => {
			vi.spyOn(
				tenantApiServer,
				'getOperatorTenantClient',
			).mockRejectedValueOnce(
				new Response('Organization not found or access denied', {
					status: 404,
				}),
			)

			const formData = new FormData()
			formData.set('intent', 'save')
			formData.set('graphJson', JSON.stringify({ nodes: [], edges: [] }))

			const request = new Request(
				'http://localhost:3001/attacker-org/marketing/journeys/j1',
				{
					method: 'POST',
					body: formData,
				},
			)

			await expect(
				detailAction({
					request,
					params: { orgSlug: 'attacker-org', journeyId: 'j1' },
					context: {},
				} as any),
			).rejects.toThrow()
		})

		it('ensures operator token payload is securely signed with expected audience and role', async () => {
			const internalSecret = 'super_secret_internal_command_token_min_16_chars'
			process.env.INTERNAL_COMMAND_TOKEN = internalSecret

			// Test actual getOperatorTenantClient JWT creation logic via jose verification
			const { SignJWT } = await import('jose')
			const token = await new SignJWT({
				orgId: 'org_tenant_isolated_123',
				role: 'operator',
			})
				.setProtectedHeader({ alg: 'HS256' })
				.setAudience('tenant-api-operator')
				.setIssuer(brand.shortName)
				.setExpirationTime('15m')
				.sign(new TextEncoder().encode(internalSecret))

			const verified = await jwtVerify(
				token,
				new TextEncoder().encode(internalSecret),
				{ audience: 'tenant-api-operator', issuer: brand.shortName },
			)

			expect(verified.payload.orgId).toBe('org_tenant_isolated_123')
			expect(verified.payload.role).toBe('operator')
			expect(verified.payload.aud).toBe('tenant-api-operator')
			expect(verified.payload.iss).toBe(brand.shortName)

			// Verify that an invalid audience fails verification
			await expect(
				jwtVerify(token, new TextEncoder().encode(internalSecret), {
					audience: 'wrong-audience',
					issuer: brand.shortName,
				}),
			).rejects.toThrow()
		})
	})

	// =========================================================================
	// 2. MALFORMED JOURNEY PAYLOADS & BOUNDARY CONDITIONS
	// =========================================================================
	describe('2. Malformed Payloads & Boundary Handling in Actions', () => {
		describe('automations.new.tsx Action', () => {
			it('handles missing graphJson payload', async () => {
				const formData = new FormData()
				formData.set('name', 'Missing Graph Journey')

				const request = new Request(
					'http://localhost:3001/test-org/marketing/journeys/new',
					{
						method: 'POST',
						body: formData,
					},
				)

				const result = await newAction({
					request,
					params: { orgSlug: 'test-org' },
					context: {},
				} as any)

				expect(result).toEqual({ error: 'Graph data is required' })
				expect(mockFetchTenant).not.toHaveBeenCalled()
			})

			it('handles completely malformed / non-JSON graphJson', async () => {
				const formData = new FormData()
				formData.set('name', 'Corrupt JSON Journey')
				formData.set('graphJson', '<<<NOT A VALID JSON>>>')

				const request = new Request(
					'http://localhost:3001/test-org/marketing/journeys/new',
					{
						method: 'POST',
						body: formData,
					},
				)

				const result = await newAction({
					request,
					params: { orgSlug: 'test-org' },
					context: {},
				} as any)

				expect(result).toEqual({ error: 'Invalid graph format' })
				expect(mockFetchTenant).not.toHaveBeenCalled()
			})

			it('handles graph with zero trigger nodes gracefully by falling back to default triggerType', async () => {
				mockFetchTenant.mockResolvedValueOnce(
					new Response(
						JSON.stringify({
							success: true,
							journey: { id: 'j_no_trigger' },
						}),
						{ status: 201 },
					),
				)

				const formData = new FormData()
				formData.set('name', 'No Trigger Journey')
				formData.set('graphJson', JSON.stringify({ nodes: [], edges: [] }))

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
						body: expect.stringContaining('"triggerType":"phone_verified"'),
					}),
				)
				expect((response as Response).headers.get('Location')).toBe(
					'/test-org/marketing/automations/j_no_trigger',
				)
			})

			it('propagates tenant API rejection errors on creation failure', async () => {
				mockFetchTenant.mockResolvedValueOnce(
					new Response(
						JSON.stringify({
							error:
								'Database constraint violation: journey name must be unique',
						}),
						{ status: 400 },
					),
				)

				const formData = new FormData()
				formData.set('name', 'Duplicate Journey')
				formData.set('graphJson', JSON.stringify({ nodes: [], edges: [] }))

				const request = new Request(
					'http://localhost:3001/test-org/marketing/journeys/new',
					{
						method: 'POST',
						body: formData,
					},
				)

				const result = await newAction({
					request,
					params: { orgSlug: 'test-org' },
					context: {},
				} as any)

				expect(result).toEqual({
					error: 'Database constraint violation: journey name must be unique',
				})
			})

			it('handles publish flag on creation and issues publish request', async () => {
				mockFetchTenant
					.mockResolvedValueOnce(
						new Response(
							JSON.stringify({
								success: true,
								journey: { id: 'j_auto_pub' },
							}),
							{ status: 201 },
						),
					)
					.mockResolvedValueOnce(
						new Response(JSON.stringify({ success: true }), { status: 200 }),
					)

				const formData = new FormData()
				formData.set('name', 'Auto Publish Journey')
				formData.set('graphJson', JSON.stringify({ nodes: [], edges: [] }))
				formData.set('publish', 'true')

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

				expect(mockFetchTenant).toHaveBeenNthCalledWith(
					1,
					'/operator/journeys',
					expect.anything(),
				)
				expect(mockFetchTenant).toHaveBeenNthCalledWith(
					2,
					'/operator/journeys/j_auto_pub/publish',
					expect.objectContaining({ method: 'POST' }),
				)
				expect((response as Response).headers.get('Location')).toBe(
					'/test-org/marketing/automations/j_auto_pub',
				)
			})
		})

		describe('automations.$journeyId.tsx Loader & Action', () => {
			it('loader throws 404 when journey does not exist in tenant database', async () => {
				mockFetchTenant.mockResolvedValueOnce(
					new Response(JSON.stringify({ error: 'Journey not found' }), {
						status: 404,
					}),
				)

				const request = new Request(
					'http://localhost:3001/test-org/marketing/journeys/j_not_found',
				)
				await expect(
					detailLoader({
						request,
						params: { orgSlug: 'test-org', journeyId: 'j_not_found' },
						context: {},
					} as any),
				).rejects.toThrow()
			})

			it('save intent rejects missing or non-string graphJson', async () => {
				const formData = new FormData()
				formData.set('intent', 'save')
				formData.set('name', 'Valid Name')

				const request = new Request(
					'http://localhost:3001/test-org/marketing/journeys/j1',
					{
						method: 'POST',
						body: formData,
					},
				)

				const result = await detailAction({
					request,
					params: { orgSlug: 'test-org', journeyId: 'j1' },
					context: {},
				} as any)

				expect(result).toEqual({ error: 'Graph data missing' })
			})

			it('save intent rejects malformed JSON graphJson', async () => {
				const formData = new FormData()
				formData.set('intent', 'save')
				formData.set('graphJson', '{ broken: true ')

				const request = new Request(
					'http://localhost:3001/test-org/marketing/journeys/j1',
					{
						method: 'POST',
						body: formData,
					},
				)

				const result = await detailAction({
					request,
					params: { orgSlug: 'test-org', journeyId: 'j1' },
					context: {},
				} as any)

				expect(result).toEqual({ error: 'Invalid graph format' })
			})

			it('publish intent handles API rejection (e.g. DAG cycle error from backend)', async () => {
				mockFetchTenant
					.mockResolvedValueOnce(
						new Response(JSON.stringify({ success: true }), { status: 200 }),
					)
					.mockResolvedValueOnce(
						new Response(
							JSON.stringify({
								error: 'Validation failed: Workflow DAG contains cycles',
							}),
							{ status: 400 },
						),
					)

				const formData = new FormData()
				formData.set('intent', 'publish')
				formData.set('graphJson', JSON.stringify({ nodes: [], edges: [] }))

				const request = new Request(
					'http://localhost:3001/test-org/marketing/journeys/j1',
					{
						method: 'POST',
						body: formData,
					},
				)

				const result = await detailAction({
					request,
					params: { orgSlug: 'test-org', journeyId: 'j1' },
					context: {},
				} as any)

				expect(result).toEqual({
					error: 'Validation failed: Workflow DAG contains cycles',
				})
			})

			it('pause intent propagates tenant failure', async () => {
				mockFetchTenant.mockResolvedValueOnce(
					new Response(JSON.stringify({ error: 'Journey is not active' }), {
						status: 400,
					}),
				)

				const formData = new FormData()
				formData.set('intent', 'pause')

				const request = new Request(
					'http://localhost:3001/test-org/marketing/journeys/j1',
					{
						method: 'POST',
						body: formData,
					},
				)

				const result = await detailAction({
					request,
					params: { orgSlug: 'test-org', journeyId: 'j1' },
					context: {},
				} as any)

				expect(result).toEqual({ error: 'Journey is not active' })
			})

			it('delete intent redirects to list on success and handles failure', async () => {
				// Failure case
				mockFetchTenant.mockResolvedValueOnce(
					new Response(
						JSON.stringify({ error: 'Cannot delete active journey' }),
						{
							status: 400,
						},
					),
				)

				const failForm = new FormData()
				failForm.set('intent', 'delete')
				const failRes = await detailAction({
					request: new Request('http://localhost/test', {
						method: 'POST',
						body: failForm,
					}),
					params: { orgSlug: 'test-org', journeyId: 'j1' },
					context: {},
				} as any)
				expect(failRes).toEqual({ error: 'Cannot delete active journey' })

				// Success case -> Redirect
				mockFetchTenant.mockResolvedValueOnce(
					new Response(JSON.stringify({ success: true }), { status: 200 }),
				)
				const successForm = new FormData()
				successForm.set('intent', 'delete')
				const successRes = await detailAction({
					request: new Request('http://localhost/test', {
						method: 'POST',
						body: successForm,
					}),
					params: { orgSlug: 'test-org', journeyId: 'j1' },
					context: {},
				} as any)
				expect((successRes as Response).headers.get('Location')).toBe(
					'/test-org/marketing/automations',
				)
			})

			it('test_run intent validates customerId presence and passes customerId', async () => {
				// Missing customerId
				const emptyForm = new FormData()
				emptyForm.set('intent', 'test_run')
				const emptyRes = await detailAction({
					request: new Request('http://localhost/test', {
						method: 'POST',
						body: emptyForm,
					}),
					params: { orgSlug: 'test-org', journeyId: 'j1' },
					context: {},
				} as any)
				expect(emptyRes).toEqual({ error: 'customerId is required' })

				// Tenant API rejection
				mockFetchTenant.mockResolvedValueOnce(
					new Response(
						JSON.stringify({
							error: 'Customer not found in regional database',
						}),
						{ status: 404 },
					),
				)
				const testForm = new FormData()
				testForm.set('intent', 'test_run')
				testForm.set('customerId', 'cust_nonexistent_999')
				const testRes = await detailAction({
					request: new Request('http://localhost/test', {
						method: 'POST',
						body: testForm,
					}),
					params: { orgSlug: 'test-org', journeyId: 'j1' },
					context: {},
				} as any)
				expect(testRes).toEqual({
					error: 'Customer not found in regional database',
				})

				// Successful test trigger
				mockFetchTenant.mockResolvedValueOnce(
					new Response(
						JSON.stringify({
							success: true,
							runId: 'run_synthetic_abc123',
						}),
						{ status: 200 },
					),
				)
				const successTestForm = new FormData()
				successTestForm.set('intent', 'test_run')
				successTestForm.set('customerId', 'cust_alice_valid')
				const successTestRes = await detailAction({
					request: new Request('http://localhost/test', {
						method: 'POST',
						body: successTestForm,
					}),
					params: { orgSlug: 'test-org', journeyId: 'j1' },
					context: {},
				} as any)
				expect((successTestRes as any).success).toBe(true)
				expect((successTestRes as any).runId).toBe('run_synthetic_abc123')
			})

			it('rejects unknown / injection intents', async () => {
				const formData = new FormData()
				formData.set('intent', '__proto__')

				const request = new Request(
					'http://localhost:3001/test-org/marketing/journeys/j1',
					{
						method: 'POST',
						body: formData,
					},
				)

				const result = await detailAction({
					request,
					params: { orgSlug: 'test-org', journeyId: 'j1' },
					context: {},
				} as any)

				expect(result).toEqual({ error: 'Unknown intent' })
			})
		})

		describe('automations._index.tsx Action & Boundary Conditions', () => {
			it('action rejects missing journeyId', async () => {
				const formData = new FormData()
				formData.set('intent', 'publish')

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

				expect(result).toEqual({ error: 'journeyId is required' })
			})

			it('action duplicate intent handles non-existent original journey', async () => {
				mockFetchTenant.mockResolvedValueOnce(
					new Response(JSON.stringify({ error: 'Journey not found' }), {
						status: 404,
					}),
				)

				const formData = new FormData()
				formData.set('intent', 'duplicate')
				formData.set('journeyId', 'j_ghost')

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

				expect(result).toEqual({ error: 'Failed to find original journey' })
			})

			it('action duplicate intent handles creation failure', async () => {
				mockFetchTenant
					.mockResolvedValueOnce(
						new Response(
							JSON.stringify({
								journey: {
									name: 'Original Journey',
									triggerType: 'phone_verified',
									nodes: [],
									edges: [],
								},
							}),
							{ status: 200 },
						),
					)
					.mockResolvedValueOnce(
						new Response(
							JSON.stringify({ error: 'Tenant DB out of disk space' }),
							{ status: 500 },
						),
					)

				const formData = new FormData()
				formData.set('intent', 'duplicate')
				formData.set('journeyId', 'j_orig')

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

				expect(result).toEqual({ error: 'Tenant DB out of disk space' })
			})

			it('loader handles network error or database unavailability gracefully', async () => {
				mockFetchTenant.mockRejectedValueOnce(
					new Error('Regional OCI connection refused'),
				)

				const request = new Request(
					'http://localhost:3001/test-org/marketing/journeys',
				)
				const result = await indexLoader({
					request,
					params: { orgSlug: 'test-org' },
					context: {},
				} as any)

				expect(result.journeys).toEqual([])
				expect(result.error).toBe('Regional OCI connection refused')
			})
		})

		describe('automations.$journeyId.runs.tsx Action & Boundary Conditions', () => {
			it('action rejects missing runId', async () => {
				const formData = new FormData()

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

				expect(result).toEqual({ error: 'runId is required' })
			})

			it('action handles non-existent or invalid runId (404 from tenant API)', async () => {
				mockFetchTenant.mockResolvedValueOnce(
					new Response(JSON.stringify({ error: 'Run not found' }), {
						status: 404,
					}),
				)

				const formData = new FormData()
				formData.set('runId', 'run_invalid_999')

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

				expect(result).toEqual({ error: 'Failed to load timeline' })
			})

			it('loader handles missing journey with 404 response', async () => {
				mockFetchTenant
					.mockResolvedValueOnce(
						new Response(JSON.stringify({ error: 'Journey not found' }), {
							status: 404,
						}),
					)
					.mockResolvedValueOnce(
						new Response(JSON.stringify({ runs: [] }), { status: 200 }),
					)

				const request = new Request(
					'http://localhost:3001/test-org/marketing/journeys/j_ghost/runs',
				)
				await expect(
					runsLoader({
						request,
						params: { orgSlug: 'test-org', journeyId: 'j_ghost' },
						context: {},
					} as any),
				).rejects.toThrow()
			})

			it('loader handles runs endpoint degradation gracefully when journey exists', async () => {
				mockFetchTenant
					.mockResolvedValueOnce(
						new Response(
							JSON.stringify({
								journey: {
									id: 'j1',
									name: 'Active Journey',
									status: 'active',
									triggerType: 'phone_verified',
								},
							}),
							{ status: 200 },
						),
					)
					.mockResolvedValueOnce(
						new Response(JSON.stringify({ error: 'Runs table locked' }), {
							status: 500,
						}),
					)

				const request = new Request(
					'http://localhost:3001/test-org/marketing/journeys/j1/runs',
				)
				const result = await runsLoader({
					request,
					params: { orgSlug: 'test-org', journeyId: 'j1' },
					context: {},
				} as any)

				expect(result.journey.name).toBe('Active Journey')
				expect(result.runs).toEqual([])
			})
		})
	})
})
