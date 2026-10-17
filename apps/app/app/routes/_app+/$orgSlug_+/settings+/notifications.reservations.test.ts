import { ConfigFlag, db, inArray } from '@repo/database'
import { RESERVATIONS_FLAG_KEYS } from '@repo/reservations'
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
	} as never)) as { showReservationsAlerts: boolean }
}

describe('notification settings: reservations alerts', () => {
	it('are not offered while reservations is off', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		expect((await load(organization.slug, cookie)).showReservationsAlerts).toBe(
			false,
		)
	})

	it('are offered to a member who can read reservations once the module is on', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await setFlag(RESERVATIONS_FLAG_KEYS.enabled, organization.id)
		expect((await load(organization.slug, cookie)).showReservationsAlerts).toBe(
			true,
		)
	})

	it('are not offered to a member the alerts are not sent to', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await setFlag(RESERVATIONS_FLAG_KEYS.enabled, organization.id)
		const user = await createTestUser()
		await addOrganizationMember(user.id, organization.id, 'org_role_member')
		const { cookie } = await createTestSession(user.id)
		expect((await load(organization.slug, cookie)).showReservationsAlerts).toBe(
			false,
		)
	})
})
