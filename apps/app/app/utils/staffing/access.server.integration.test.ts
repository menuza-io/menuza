import { getFeatureFlags } from '@repo/common/feature-flags'
import { ConfigFlag, db, eq } from '@repo/database'
import { STAFFING_FLAGS } from '@repo/staffing'
import { describe, expect, it } from 'vitest'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import {
	getStaffingAccess,
	getStaffingFlags,
	requireStaffingFeature,
} from './access.server.ts'

async function setFlag(organizationId: string, key: string, value: unknown) {
	await db
		.insert(ConfigFlag)
		.values({ key, value, level: 'organization', organizationId })
}

function requestFor(slug: string, cookie: string) {
	return createAuthenticatedRequest(
		`http://localhost/${slug}/staffing/team`,
		{},
		cookie,
	)
}

describe('staffing access', () => {
	it('is off by default, even for admins', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		expect(await getStaffingFlags(organization.id)).toMatchObject({
			enabled: false,
			scheduling: false,
			timeclock: false,
		})
		await expect(
			requireStaffingFeature(
				requestFor(organization.slug, cookie),
				organization.slug,
				'staff',
			),
		).rejects.toMatchObject({ status: 404 })
	})

	it('grants built-in admins write access once enabled', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await setFlag(organization.id, STAFFING_FLAGS.enabled, true)
		await setFlag(organization.id, STAFFING_FLAGS.scheduling, true)
		const access = await getStaffingAccess(
			requestFor(organization.slug, cookie),
			organization.slug,
		)
		expect(access.grants).toEqual({
			staff: 'write',
			schedule: 'write',
			timeclock: null,
		})
		expect(access.impersonating).toBe(false)
		expect(access.canViewPay).toBe(false)
		await setFlag(organization.id, STAFFING_FLAGS.pay, true)
		expect(
			(
				await getStaffingAccess(
					requestFor(organization.slug, cookie),
					organization.slug,
				)
			).canViewPay,
		).toBe(true)
		await expect(
			requireStaffingFeature(
				requestFor(organization.slug, cookie),
				organization.slug,
				'timeclock',
			),
		).rejects.toMatchObject({ status: 404 })
	})

	it('denies built-in members, who have no staffing permissions', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlag(organization.id, STAFFING_FLAGS.enabled, true)
		const member = await createTestUser()
		await addOrganizationMember(member.id, organization.id, 'org_role_member')
		const { cookie } = await createTestSession(member.id)
		await expect(
			requireStaffingFeature(
				requestFor(organization.slug, cookie),
				organization.slug,
				'staff',
			),
		).rejects.toMatchObject({ status: 403 })
	})

	it('does not let one organization’s flag enable another', async () => {
		const first = await setupTestOrgWithUser('admin')
		const second = await setupTestOrgWithUser('admin')
		await setFlag(first.organization.id, STAFFING_FLAGS.enabled, true)
		expect((await getStaffingFlags(second.organization.id)).enabled).toBe(false)
	})
})

describe('getFeatureFlags', () => {
	it('prefers user, then organization, then system values', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		const key = `test.flag.${organization.id}`
		await db.insert(ConfigFlag).values([
			{ key, value: 'system', level: 'system' },
			{
				key,
				value: 'organization',
				level: 'organization',
				organizationId: organization.id,
			},
		])
		expect(
			await getFeatureFlags([key, 'test.missing'], {
				organizationId: organization.id,
			}),
		).toEqual({ [key]: 'organization', 'test.missing': null })
		await db
			.insert(ConfigFlag)
			.values({ key, value: 'user', level: 'user', userId: user.id })
		expect(
			(
				await getFeatureFlags([key], {
					organizationId: organization.id,
					userId: user.id,
				})
			)[key],
		).toBe('user')
		expect((await getFeatureFlags([key], {}))[key]).toBe('system')
		await db.delete(ConfigFlag).where(eq(ConfigFlag.key, key))
	})
})
