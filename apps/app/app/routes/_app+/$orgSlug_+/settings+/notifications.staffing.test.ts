import { ConfigFlag, db, inArray } from '@repo/database'
import { STAFFING_FLAG_KEYS } from '@repo/staffing'
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
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { loader } from './notifications.tsx'

const createdFlagIds: string[] = []

async function setFlag(key: string, organizationId: string) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({ key, value: true, level: 'organization', organizationId })
		.returning({ id: ConfigFlag.id })
	createdFlagIds.push(row!.id)
}

afterEach(async () => {
	if (createdFlagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, createdFlagIds))
		createdFlagIds.length = 0
	}
})

async function load(slug: string, cookie: string) {
	const request = createAuthenticatedRequest(
		`http://localhost:3000/${slug}/settings/notifications`,
		{},
		cookie,
	)
	return (await loader({
		request,
		params: { orgSlug: slug },
		context: {},
	} as never)) as {
		organizationId: string
		showStaffingAlerts: boolean
		showScheduleAlerts: boolean
		showHiringAlerts: boolean
	}
}

describe('notification settings: time clock alerts', () => {
	it('are not offered while staffing is off', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		expect((await load(organization.slug, cookie)).showStaffingAlerts).toBe(
			false,
		)
	})

	it('need the time clock flag, not just the master switch', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await setFlag(STAFFING_FLAG_KEYS.enabled, organization.id)
		expect((await load(organization.slug, cookie)).showStaffingAlerts).toBe(
			false,
		)
	})

	it('are offered to a member who can read timesheets once the time clock is on', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await setFlag(STAFFING_FLAG_KEYS.enabled, organization.id)
		await setFlag(STAFFING_FLAG_KEYS.timeclock, organization.id)
		expect((await load(organization.slug, cookie)).showStaffingAlerts).toBe(
			true,
		)
	})

	it('are not offered to a member who cannot read timesheets', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlag(STAFFING_FLAG_KEYS.enabled, organization.id)
		await setFlag(STAFFING_FLAG_KEYS.timeclock, organization.id)
		const user = await createTestUser()
		await addOrganizationMember(user.id, organization.id, 'org_role_member')
		const { cookie } = await createTestSession(user.id)
		expect((await load(organization.slug, cookie)).showStaffingAlerts).toBe(
			false,
		)
	})
})

describe('notification settings: schedule alerts', () => {
	it('are not offered while staffing or scheduling is off', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		expect((await load(organization.slug, cookie)).showScheduleAlerts).toBe(
			false,
		)
		await setFlag(STAFFING_FLAG_KEYS.enabled, organization.id)
		await setFlag(STAFFING_FLAG_KEYS.timeclock, organization.id)
		const state = await load(organization.slug, cookie)
		expect(state.showScheduleAlerts).toBe(false)
		expect(state.showStaffingAlerts).toBe(true)
	})

	it('are offered to a member who can read the schedule once scheduling is on', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await setFlag(STAFFING_FLAG_KEYS.enabled, organization.id)
		await setFlag(STAFFING_FLAG_KEYS.scheduling, organization.id)
		const state = await load(organization.slug, cookie)
		expect(state.showScheduleAlerts).toBe(true)
		expect(state.showStaffingAlerts).toBe(false)
	})

	it('are not offered to a member who cannot read the schedule', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlag(STAFFING_FLAG_KEYS.enabled, organization.id)
		await setFlag(STAFFING_FLAG_KEYS.scheduling, organization.id)
		const user = await createTestUser()
		await addOrganizationMember(user.id, organization.id, 'org_role_member')
		const { cookie } = await createTestSession(user.id)
		expect((await load(organization.slug, cookie)).showScheduleAlerts).toBe(
			false,
		)
	})
})

describe('notification settings: new applicant alerts', () => {
	it('are not offered while staffing or hiring is off', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		expect((await load(organization.slug, cookie)).showHiringAlerts).toBe(false)
		await setFlag(STAFFING_FLAG_KEYS.enabled, organization.id)
		await setFlag(STAFFING_FLAG_KEYS.timeclock, organization.id)
		expect((await load(organization.slug, cookie)).showHiringAlerts).toBe(false)
	})

	it('are offered to a member who can read applicants once hiring is on', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await setFlag(STAFFING_FLAG_KEYS.enabled, organization.id)
		await setFlag(STAFFING_FLAG_KEYS.hiring, organization.id)
		const state = await load(organization.slug, cookie)
		expect(state.showHiringAlerts).toBe(true)
		expect(state.showStaffingAlerts).toBe(false)
		expect(state.showScheduleAlerts).toBe(false)
	})

	it('are not offered to a member who cannot read applicants', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlag(STAFFING_FLAG_KEYS.enabled, organization.id)
		await setFlag(STAFFING_FLAG_KEYS.hiring, organization.id)
		const user = await createTestUser()
		await addOrganizationMember(user.id, organization.id, 'org_role_member')
		const { cookie } = await createTestSession(user.id)
		expect((await load(organization.slug, cookie)).showHiringAlerts).toBe(false)
	})
})
