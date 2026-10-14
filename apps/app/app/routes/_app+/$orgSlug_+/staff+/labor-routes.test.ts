import {
	_OrganizationPermissionToRole,
	ConfigFlag,
	db,
	inArray,
	OrganizationLocation,
	OrganizationRole,
} from '@repo/database'
import {
	DEFAULT_SCOPE_ID,
	STAFFING_FLAG_KEYS,
	STAFFING_PERMISSIONS as P,
	type StaffingFeature,
} from '@repo/staffing'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
	process.env.SESSION_SECRET = 'test-session-secret'
	process.env.JWT_SECRET = 'test-jwt-secret-key'
	const workerId =
		process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0'
	process.env.DATABASE_URL = `file:./tests/database/data.${workerId}.db`
	process.env.AWS_ENDPOINT_URL_S3 = 'http://localhost:9000'
	process.env.AWS_REGION = 'us-east-1'
	process.env.AWS_ACCESS_KEY_ID = 'test'
	process.env.AWS_SECRET_ACCESS_KEY = 'test'
	process.env.BUCKET_NAME = 'test'
})

import { setMemberLocationScope } from '#app/utils/staffing/restaurant/location-scope.server.ts'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { loader } from './labor.tsx'

const flagIds: string[] = []

const locationIds: string[] = []

async function location(
	organizationId: string,
	name: string,
	address?: { country: string },
) {
	const [row] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId,
			name,
			slug: `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 6)}`,
			timezone: 'America/Chicago',
			address: address ? JSON.stringify(address) : null,
		})
		.returning({ id: OrganizationLocation.id })
	locationIds.push(row!.id)
	return row!.id
}

async function setFlag(feature: StaffingFeature, organizationId: string) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({
			key: STAFFING_FLAG_KEYS[feature],
			value: true,
			level: 'organization',
			organizationId,
		})
		.returning({ id: ConfigFlag.id })
	flagIds.push(row!.id)
}

async function enableLabor(organizationId: string) {
	await setFlag('enabled', organizationId)
	await setFlag('labor', organizationId)
}

async function memberWith(organizationId: string, permissions: string[]) {
	const [role] = await db
		.insert(OrganizationRole)
		.values({
			name: `Custom ${crypto.randomUUID().slice(0, 8)}`,
			description: '',
			level: 0,
			organizationId,
		})
		.returning({ id: OrganizationRole.id })
	await db.insert(_OrganizationPermissionToRole).values(
		permissions.map((permission) => ({
			A: role!.id,
			B: `org_perm_${permission.replaceAll(':', '_')}`,
		})),
	)
	const user = await createTestUser()
	await addOrganizationMember(user.id, organizationId, role!.id)
	const { cookie } = await createTestSession(user.id)
	return { user, cookie }
}

type LoaderData = {
	scopes: Array<{ id: string; currency: string; name: string }>
	can: { editSales: boolean; editSettings: boolean; seeTips: boolean }
}

async function load(
	slug: string,
	cookie: string,
): Promise<{ status: number; data: LoaderData | null }> {
	try {
		const data = (await loader({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${slug}/staff/labor`,
				{},
				cookie,
			),
			params: { orgSlug: slug },
			context: {},
		} as never)) as LoaderData
		return { status: 200, data }
	} catch (error) {
		if (error instanceof Response) return { status: error.status, data: null }
		throw error
	}
}

afterEach(async () => {
	if (locationIds.length) {
		await db
			.delete(OrganizationLocation)
			.where(inArray(OrganizationLocation.id, locationIds))
		locationIds.length = 0
	}
	if (flagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds))
		flagIds.length = 0
	}
})

describe('labor route loader', () => {
	it('is 404 while staffing or the labor flag is off, even for an admin', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		expect((await load(organization.slug, cookie)).status).toBe(404)
		await setFlag('enabled', organization.id)
		expect((await load(organization.slug, cookie)).status).toBe(404)
		// Another child flag does not open it.
		await setFlag('timeclock', organization.id)
		expect((await load(organization.slug, cookie)).status).toBe(404)
	})

	it('opens for an admin once both flags are on, with the one implicit workplace and its currency', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableLabor(organization.id)
		const result = await load(organization.slug, cookie)
		expect(result.data?.can).toEqual({
			editSales: true,
			editSettings: true,
			seeTips: true,
		})
		expect(result.data?.scopes).toEqual([
			expect.objectContaining({
				id: DEFAULT_SCOPE_ID,
				name: organization.name,
				currency: 'USD',
			}),
		])
	})

	it('lists only the scopes the member is limited to', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableLabor(organization.id)
		const a = await location(organization.id, 'Alpha')
		await location(organization.id, 'Beta')
		const scoped = await memberWith(organization.id, [P.READ_LABOR])
		await setMemberLocationScope({
			organizationId: organization.id,
			userId: scoped.user.id,
			value: { scope: 'selected', locationIds: [a] },
		})
		const result = await load(organization.slug, scoped.cookie)
		expect(result.data?.scopes.map((s) => s.id)).toEqual([a])
	})

	it('shows each location in the currency of its address', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableLabor(organization.id)
		const us = await location(organization.id, 'Alpha', { country: 'US' })
		const sa = await location(organization.id, 'Beta', { country: 'SA' })
		const result = await load(organization.slug, cookie)
		const currency = Object.fromEntries(
			(result.data?.scopes ?? []).map((s) => [s.id, s.currency]),
		)
		expect(currency[us]).toBe('USD')
		expect(currency[sa]).toBe('SAR')
	})

	it('is 403 for a member without the labor grant, and a pay grant alone is not enough', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableLabor(organization.id)
		const none = await setupTestOrgWithUser('member')
		await enableLabor(none.organization.id)
		expect((await load(none.organization.slug, none.cookie)).status).toBe(403)
		const payOnly = await memberWith(organization.id, [
			P.READ_STAFF,
			P.READ_STAFF_PAY,
			P.READ_TIMESHEET,
		])
		expect((await load(organization.slug, payOnly.cookie)).status).toBe(403)
	})

	it('tells the page only what the member may do', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableLabor(organization.id)
		const viewer = await memberWith(organization.id, [P.READ_LABOR])
		const result = await load(organization.slug, viewer.cookie)
		expect(result.data?.can).toEqual({
			editSales: false,
			editSettings: false,
			seeTips: false,
		})
		const manager = await memberWith(organization.id, [
			P.READ_LABOR,
			P.UPDATE_TIMESHEET,
			P.READ_STAFF,
			P.READ_STAFF_PAY,
		])
		const second = await load(organization.slug, manager.cookie)
		expect(second.data?.can).toEqual({
			editSales: true,
			editSettings: false,
			seeTips: true,
		})
	})
})
