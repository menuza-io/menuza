import {
	_OrganizationPermissionToRole,
	and,
	ConfigFlag,
	db,
	eq,
	inArray,
	OrganizationRole,
	UserOrganization,
} from '@repo/database'
import {
	LOYALTY_FLAG_KEYS,
	LOYALTY_PERMISSIONS as P,
	type LoyaltyFeatures,
} from '@repo/loyalty'
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

import {
	getLoyaltyNavAccess,
	HIDDEN_LOYALTY_NAV,
} from '#app/utils/loyalty/access.server.ts'
import {
	computeLoyaltyNavAccess,
	firstVisibleLoyaltyPath,
} from '#app/utils/loyalty/nav.ts'
import {
	addOrganizationMember,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'

const flagIds: string[] = []

async function setFlag(key: string, organizationId: string, value = true) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({ key, value, level: 'organization', organizationId })
		.returning({ id: ConfigFlag.id })
	flagIds.push(row!.id)
}

async function customRole(organizationId: string, permissions: string[]) {
	const [role] = await db
		.insert(OrganizationRole)
		.values({
			name: `Custom ${crypto.randomUUID().slice(0, 8)}`,
			description: '',
			level: 0,
			organizationId,
		})
		.returning({ id: OrganizationRole.id })
	if (permissions.length > 0) {
		await db.insert(_OrganizationPermissionToRole).values(
			permissions.map((permission) => ({
				A: role!.id,
				B: `org_perm_${permission.replaceAll(':', '_')}`,
			})),
		)
	}
	return role!.id
}

async function memberWith(organizationId: string, permissions: string[]) {
	const user = await createTestUser()
	await addOrganizationMember(
		user.id,
		organizationId,
		await customRole(organizationId, permissions),
	)
	return user
}

afterEach(async () => {
	if (flagIds.length > 0) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds.splice(0)))
	}
})

const ENABLED: LoyaltyFeatures = {
	enabled: true,
	redemption: true,
}

describe('Loyalty navigation access', () => {
	it('hides every Loyalty section when loyalty.enabled is off', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		const nav = await getLoyaltyNavAccess(user.id, organization.id)
		expect(nav).toEqual(HIDDEN_LOYALTY_NAV)
	})

	it('hides every Loyalty section when the flag is on but the member holds no loyalty grants', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlag(LOYALTY_FLAG_KEYS.enabled, organization.id)

		const member = await memberWith(organization.id, [])
		const nav = await getLoyaltyNavAccess(member.id, organization.id)
		expect(nav).toEqual(HIDDEN_LOYALTY_NAV)
	})

	it('shows every section for a member holding read:loyalty:any (it satisfies every section)', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlag(LOYALTY_FLAG_KEYS.enabled, organization.id)

		const member = await memberWith(organization.id, [P.READ_LOYALTY])
		const nav = await getLoyaltyNavAccess(member.id, organization.id)
		expect(nav).toEqual({
			visible: true,
			overview: true,
			program: true,
			rewards: true,
			activity: true,
		})
	})

	it('shows overview only for a member holding just read:loyalty_report:any', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlag(LOYALTY_FLAG_KEYS.enabled, organization.id)

		const member = await memberWith(organization.id, [P.READ_LOYALTY_REPORT])
		const nav = await getLoyaltyNavAccess(member.id, organization.id)
		expect(nav).toEqual({
			visible: true,
			overview: true,
			program: false,
			rewards: false,
			activity: false,
		})
	})

	it('shows every section for a member holding only update:loyalty_program:any (the implied read satisfies the rest)', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlag(LOYALTY_FLAG_KEYS.enabled, organization.id)

		const member = await memberWith(organization.id, [P.UPDATE_LOYALTY_PROGRAM])
		const nav = await getLoyaltyNavAccess(member.id, organization.id)
		// getUserLoyaltyGrants expands update:loyalty_program:any with the
		// implied read:loyalty:any, and read:loyalty:any appears in every
		// section's permission list (including activity).
		expect(nav).toEqual({
			visible: true,
			overview: true,
			program: true,
			rewards: true,
			activity: true,
		})
	})

	it('hides every section for a member restricted to zero locations', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlag(LOYALTY_FLAG_KEYS.enabled, organization.id)

		const member = await memberWith(organization.id, [P.READ_LOYALTY])
		await db
			.update(UserOrganization)
			.set({ locationScope: 'selected' })
			.where(
				and(
					eq(UserOrganization.userId, member.id),
					eq(UserOrganization.organizationId, organization.id),
				),
			)
		const nav = await getLoyaltyNavAccess(member.id, organization.id)
		expect(nav).toEqual(HIDDEN_LOYALTY_NAV)
	})

	it('computes nav access purely from features and grants without a database', () => {
		// Master flag off hides everything, even with grants.
		expect(
			computeLoyaltyNavAccess({ enabled: false, redemption: false }, [
				P.READ_LOYALTY,
			]),
		).toEqual(HIDDEN_LOYALTY_NAV)

		// No grants: nothing visible.
		expect(computeLoyaltyNavAccess(ENABLED, [])).toEqual(HIDDEN_LOYALTY_NAV)

		// A write grant implies read:loyalty:any through hasLoyaltyGrant, so
		// every section (each lists read:loyalty:any) becomes visible.
		expect(computeLoyaltyNavAccess(ENABLED, [P.UPDATE_LOYALTY_POINTS])).toEqual(
			{
				visible: true,
				overview: true,
				program: true,
				rewards: true,
				activity: true,
			},
		)

		// Report readers see only the overview.
		const reportOnly = computeLoyaltyNavAccess(ENABLED, [P.READ_LOYALTY_REPORT])
		expect(reportOnly).toEqual({
			visible: true,
			overview: true,
			program: false,
			rewards: false,
			activity: false,
		})
		expect(
			firstVisibleLoyaltyPath('acme', ENABLED, [P.READ_LOYALTY_REPORT]),
		).toBe('/acme/loyalty/overview')
		expect(firstVisibleLoyaltyPath('acme', ENABLED, [])).toBeNull()
	})
})
