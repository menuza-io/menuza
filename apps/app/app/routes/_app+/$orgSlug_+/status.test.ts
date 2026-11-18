import {
	db,
	eq,
	Organization,
	OrganizationLocation,
	OrganizationMenu,
} from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { loadBuiltInBlockData } from '#app/utils/dashboards/block-data.server.ts'
import { setMemberLocationScope } from '#app/utils/staffing/restaurant/location-scope.server.ts'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { loader } from './status.tsx'

vi.mock('@repo/common/feature-flags', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getFeatureFlag: vi.fn(async () => null),
}))

const week = JSON.stringify(
	[
		'monday',
		'tuesday',
		'wednesday',
		'thursday',
		'friday',
		'saturday',
		'sunday',
	].map((day) => ({ day, isOpen: true, slots: [{ start: '00:00', end: '23:59' }] })),
)

async function createLocation(organizationId: string, name: string) {
	const [row] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId,
			name,
			slug: `l-${crypto.randomUUID().slice(0, 8)}`,
			timezone: 'UTC',
			storeHours: week,
			onlineHours: week,
		})
		.returning()
	return row!
}

async function makeHealthy(organizationId: string) {
	await db
		.update(Organization)
		.set({
			sitePublished: true,
			shopPaymentProvider: 'connect',
			stripeConnectAccountId: 'acct_test',
			stripeConnectChargesEnabled: true,
		})
		.where(eq(Organization.id, organizationId))
	await db.insert(OrganizationMenu).values({
		organizationId,
		displayName: 'Dinner',
	})
}

async function open(orgSlug: string, cookie: string) {
	return (await loader({
		request: createAuthenticatedRequest(`https://app.test/${orgSlug}/status`, {}, cookie),
		params: { orgSlug },
		context: new RouterContextProvider(),
	} as never)) as any
}

describe('Status (#332)', () => {
	it('a location with a disabled payments account shows Not taking orders with a link to payments', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await createLocation(organization.id, 'Main')
		await db
			.update(Organization)
			.set({ sitePublished: true })
			.where(eq(Organization.id, organization.id))
		await db.insert(OrganizationMenu).values({ organizationId: organization.id, displayName: 'Menu' })

		const { status } = await open(organization.slug, cookie)
		expect(status.summary).toBe('not_taking_orders')
		const payments = status.locations[0].checks.find((c: any) => c.id === 'payments')
		expect(payments).toMatchObject({
			status: 'blocking',
			code: 'payments_disabled',
			href: '/settings/shop',
		})
	})

	it('a healthy location shows all checks passed', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await createLocation(organization.id, 'Main')
		await makeHealthy(organization.id)
		const { status } = await open(organization.slug, cookie)
		expect(status.summary).toBe('taking_orders')
		expect(status.locations[0].allPassed).toBe(true)
		expect(status.locations[0].checks.every((c: any) => c.status === 'ok')).toBe(true)
	})

	it('a manager sees only their own locations', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await makeHealthy(organization.id)
		const mine = await createLocation(organization.id, 'Mine')
		await createLocation(organization.id, 'Theirs')
		const manager = await createTestUser()
		await addOrganizationMember(manager.id, organization.id, 'org_role_admin')
		await setMemberLocationScope({
			organizationId: organization.id,
			userId: manager.id,
			value: { scope: 'selected', locationIds: [mine.id] },
		})
		const { cookie } = await createTestSession(manager.id)
		const { status } = await open(organization.slug, cookie)
		expect(status.locations.map((l: any) => l.name)).toEqual(['Mine'])
	})

	it('the worst location decides the summary and each is listed separately', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await makeHealthy(organization.id)
		const a = await createLocation(organization.id, 'A')
		await createLocation(organization.id, 'B')
		await db
			.update(OrganizationLocation)
			.set({ orderingPausedAt: new Date(Date.now() - 1000), orderingPausedUntil: null })
			.where(eq(OrganizationLocation.id, a.id))
		const { status } = await open(organization.slug, cookie)
		expect(status.summary).toBe('not_taking_orders')
		expect(Object.fromEntries(status.locations.map((l: any) => [l.name, l.summary]))).toEqual({
			A: 'not_taking_orders',
			B: 'taking_orders',
		})
	})

	it('the dashboard Status card gets the same data, only for people who may see it', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await createLocation(organization.id, 'Main')
		const data = await loadBuiltInBlockData({
			userId: user.id,
			organization: { id: organization.id, slug: organization.slug, createdAt: new Date() } as never,
			blocks: [{ id: 'status', type: 'status' }],
		})
		expect(data.status?.locations).toHaveLength(1)

		const guest = await createTestUser()
		await addOrganizationMember(guest.id, organization.id, 'org_role_guest')
		const hidden = await loadBuiltInBlockData({
			userId: guest.id,
			organization: { id: organization.id, slug: organization.slug, createdAt: new Date() } as never,
			blocks: [{ id: 'status', type: 'status' }],
		})
		expect(hidden.status).toBeNull()
	})
})
