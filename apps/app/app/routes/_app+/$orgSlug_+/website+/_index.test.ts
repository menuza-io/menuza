import { db, eq, Organization } from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	deprovisionTenantDatabase,
	provisionTenantDatabase,
} from '#app/utils/sites/tenant-api.server.ts'
import {
	createAuthenticatedRequest,
	createTestOrganization,
	createTestSession,
	createTestUser,
} from '#tests/test-utils.ts'
import { action } from './_index.tsx'

const databaseMocks = vi.hoisted(() => ({ update: vi.fn() }))

vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<{ db: typeof db }>()
	databaseMocks.update.mockImplementation((table) => actual.db.update(table))
	return {
		...actual,
		db: new Proxy(actual.db, {
			get(target, property) {
				return property === 'update'
					? databaseMocks.update
					: Reflect.get(target, property)
			},
		}),
	}
})

vi.mock('#app/utils/sites/tenant-api.server.ts', () => ({
	provisionTenantDatabase: vi.fn(),
	deprovisionTenantDatabase: vi.fn(),
}))
vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(),
}))

beforeEach(() => {
	databaseMocks.update.mockClear()
	vi.mocked(provisionTenantDatabase).mockReset().mockResolvedValue({
		region: 'us',
	})
	vi.mocked(deprovisionTenantDatabase).mockReset().mockResolvedValue({
		region: 'us',
	})
})

async function setup(hasProvisionedDb = true) {
	const user = await createTestUser()
	const organization = await createTestOrganization(user.id)
	const { cookie } = await createTestSession(user.id)
	await db
		.update(Organization)
		.set({ hasProvisionedDb, sitePublished: false, dataRegion: 'us' })
		.where(eq(Organization.id, organization.id))
	const url = new URL(`http://localhost:3001/${organization.slug}/website`)

	return {
		organization,
		submit: (values: Record<string, string>) =>
			action({
				request: createAuthenticatedRequest(
					url.toString(),
					{
						method: 'POST',
						body: new URLSearchParams({
							organizationId: organization.id,
							...values,
						}),
					},
					cookie,
				),
				params: { orgSlug: organization.slug },
				context: new RouterContextProvider(),
				url,
				pattern: '/:orgSlug/website',
			}),
	}
}

describe('website tenant database lifecycle', () => {
	it('publishes provisioned organizations without calling tenant-api again', async () => {
		const { organization, submit } = await setup()

		const response = await submit({
			intent: 'update-site-publish',
			sitePublished: 'true',
		})
		expect(response.status).toBe(200)
		expect(provisionTenantDatabase).not.toHaveBeenCalled()
		const updated = await db.query.Organization.findFirst({
			where: eq(Organization.id, organization.id),
		})
		expect(updated?.sitePublished).toBe(true)
		expect(updated?.hasProvisionedDb).toBe(true)
	})

	it('repairs legacy unprovisioned organizations when publishing', async () => {
		const { organization, submit } = await setup(false)

		expect(
			(
				await submit({
					intent: 'update-site-publish',
					sitePublished: 'true',
				})
			).status,
		).toBe(200)
		expect(provisionTenantDatabase).toHaveBeenCalledWith({
			orgId: organization.id,
			slug: organization.slug,
			customDomain: null,
			dataRegion: 'us',
		})
	})

	it('requires wipe confirmation before switching a provisioned organization', async () => {
		const { organization, submit } = await setup()

		expect(
			(
				await submit({
					intent: 'update-site-data-region',
					dataRegion: 'ksa',
				})
			).status,
		).toBe(400)
		expect(deprovisionTenantDatabase).not.toHaveBeenCalled()
		expect(provisionTenantDatabase).not.toHaveBeenCalled()
		expect(
			(
				await db.query.Organization.findFirst({
					where: eq(Organization.id, organization.id),
				})
			)?.dataRegion,
		).toBe('us')
	})

	it('provisions the replacement region even when the website is unpublished', async () => {
		const { organization, submit } = await setup()
		vi.mocked(provisionTenantDatabase).mockResolvedValue({ region: 'ksa' })
		vi.mocked(deprovisionTenantDatabase).mockImplementationOnce(async () => {
			expect(
				await db.query.Organization.findFirst({
					where: eq(Organization.id, organization.id),
				}),
			).toMatchObject({ dataRegion: 'us', hasProvisionedDb: false })
			return { region: 'us' }
		})

		expect(
			(
				await submit({
					intent: 'update-site-data-region',
					dataRegion: 'ksa',
					confirmWipe: 'true',
				})
			).status,
		).toBe(302)
		expect(deprovisionTenantDatabase).toHaveBeenCalledWith({
			orgId: organization.id,
			slug: organization.slug,
			customDomain: null,
			dataRegion: 'us',
		})
		expect(provisionTenantDatabase).toHaveBeenCalledWith({
			orgId: organization.id,
			slug: organization.slug,
			customDomain: null,
			dataRegion: 'ksa',
		})
		expect(
			await db.query.Organization.findFirst({
				where: eq(Organization.id, organization.id),
			}),
		).toMatchObject({
			dataRegion: 'ksa',
			hasProvisionedDb: true,
			sitePublished: false,
		})
	})

	it('can retry provisioning the selected region without wiping it', async () => {
		const { organization, submit } = await setup(false)

		expect(
			(
				await submit({
					intent: 'update-site-data-region',
					dataRegion: 'us',
				})
			).status,
		).toBe(302)
		expect(deprovisionTenantDatabase).not.toHaveBeenCalled()
		expect(provisionTenantDatabase).toHaveBeenCalledOnce()
		expect(
			(
				await db.query.Organization.findFirst({
					where: eq(Organization.id, organization.id),
				})
			)?.hasProvisionedDb,
		).toBe(true)
	})

	it.each(['us', 'ksa'] as const)(
		'can retry in %s after deletion succeeds but recording the new region fails',
		async (retryRegion) => {
			const { organization, submit } = await setup()
			vi.spyOn(console, 'error').mockImplementation(() => {})
			const update = databaseMocks.update.getMockImplementation()!
			databaseMocks.update
				.mockImplementationOnce(update)
				.mockImplementationOnce(() => {
					throw new Error('Could not record the new region')
				})

			expect(
				(
					await submit({
						intent: 'update-site-data-region',
						dataRegion: 'ksa',
						confirmWipe: 'true',
					})
				).status,
			).toBe(500)

			expect(deprovisionTenantDatabase).toHaveBeenCalledOnce()
			expect(
				await db.query.Organization.findFirst({
					where: eq(Organization.id, organization.id),
				}),
			).toMatchObject({ dataRegion: 'us', hasProvisionedDb: false })
			vi.mocked(provisionTenantDatabase).mockResolvedValue({
				region: retryRegion,
			})

			expect(
				(
					await submit({
						intent: 'update-site-data-region',
						dataRegion: retryRegion,
					})
				).status,
			).toBe(302)
			expect(provisionTenantDatabase).toHaveBeenCalledWith(
				expect.objectContaining({ dataRegion: retryRegion }),
			)
			expect(
				await db.query.Organization.findFirst({
					where: eq(Organization.id, organization.id),
				}),
			).toMatchObject({ dataRegion: retryRegion, hasProvisionedDb: true })
		},
	)

	it('does not delete the old database if recording its unavailable state fails', async () => {
		const { organization, submit } = await setup()
		vi.spyOn(console, 'error').mockImplementation(() => {})
		databaseMocks.update.mockImplementationOnce(() => {
			throw new Error('Could not record the unavailable state')
		})

		expect(
			(
				await submit({
					intent: 'update-site-data-region',
					dataRegion: 'ksa',
					confirmWipe: 'true',
				})
			).status,
		).toBe(500)

		expect(deprovisionTenantDatabase).not.toHaveBeenCalled()
		expect(provisionTenantDatabase).not.toHaveBeenCalled()
		expect(
			await db.query.Organization.findFirst({
				where: eq(Organization.id, organization.id),
			}),
		).toMatchObject({ dataRegion: 'us', hasProvisionedDb: true })
	})

	it('retries an unsuccessful old-region wipe before provisioning the new region', async () => {
		const { organization, submit } = await setup()
		vi.spyOn(console, 'error').mockImplementation(() => {})
		vi.mocked(deprovisionTenantDatabase).mockRejectedValueOnce(
			new Error('The old region could not be wiped'),
		)

		expect(
			(
				await submit({
					intent: 'update-site-data-region',
					dataRegion: 'ksa',
					confirmWipe: 'true',
				})
			).status,
		).toBe(500)
		expect(provisionTenantDatabase).not.toHaveBeenCalled()
		expect(
			await db.query.Organization.findFirst({
				where: eq(Organization.id, organization.id),
			}),
		).toMatchObject({ dataRegion: 'us', hasProvisionedDb: false })

		vi.mocked(provisionTenantDatabase).mockResolvedValue({ region: 'ksa' })
		expect(
			(
				await submit({
					intent: 'update-site-data-region',
					dataRegion: 'ksa',
				})
			).status,
		).toBe(302)
		expect(deprovisionTenantDatabase).toHaveBeenCalledTimes(2)
		expect(provisionTenantDatabase).toHaveBeenCalledOnce()
	})
})
