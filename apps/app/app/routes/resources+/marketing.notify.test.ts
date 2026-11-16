import { db, eq, Notification, Organization, User } from '@repo/database'
import type * as EmailModule from '@repo/email'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

const sendEmailMock = vi.hoisted(() => vi.fn())

vi.mock('@repo/email', async (importOriginal) => ({
	...(await importOriginal<typeof EmailModule>()),
	sendEmail: sendEmailMock,
}))

import { CAMPAIGN_ALERT_TYPE } from '#app/utils/marketing/campaign-alerts.ts'
import {
	addOrganizationMember,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action } from './marketing.notify.ts'

async function provisioned(organizationId: string) {
	await db
		.update(Organization)
		.set({ hasProvisionedDb: true })
		.where(eq(Organization.id, organizationId))
}

function call(
	body: unknown,
	options: { authorized?: boolean; method?: string } = {},
) {
	const method = options.method ?? 'POST'
	return action({
		request: new Request('http://localhost:3001/resources/marketing/notify', {
			method,
			headers: {
				'content-type': 'application/json',
				...(options.authorized === false
					? {}
					: { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` }),
			},
			body:
				method === 'GET' || method === 'HEAD'
					? undefined
					: typeof body === 'string'
						? body
						: JSON.stringify(body),
		}),
		params: {},
		context: new RouterContextProvider(),
		unstable_pattern: '/resources/marketing/notify',
	} as never)
}

const event = (orgId: string, campaignId = 'camp-1') => ({
	orgId,
	kind: 'broadcast_skipped_late',
	campaignId,
})

const notificationsFor = (userId: string) =>
	db.select().from(Notification).where(eq(Notification.userId, userId))

beforeEach(() => {
	sendEmailMock.mockReset().mockResolvedValue({ status: 'success', data: {} })
})

describe('POST /resources/marketing/notify', () => {
	it('answers 401 without the internal token and tells nobody', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await provisioned(organization.id)
		const res = await call(event(organization.id), { authorized: false })
		expect(res.status).toBe(401)
		expect(await notificationsFor(user.id)).toEqual([])
		expect(sendEmailMock).not.toHaveBeenCalled()
	})

	it('refuses other methods, malformed bodies and any extra field without echoing it', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await provisioned(organization.id)
		expect((await call(event(organization.id), { method: 'GET' })).status).toBe(
			405,
		)
		expect((await call('not json')).status).toBe(400)
		const extra = await call({
			...event(organization.id),
			name: 'Secret promo',
		})
		expect(extra.status).toBe(400)
		expect(JSON.stringify(await extra.json())).not.toContain('Secret promo')
		expect(
			(await call({ ...event(organization.id), kind: 'something_else' }))
				.status,
		).toBe(400)
	})

	it('answers 404 for an unknown or unprovisioned organization', async () => {
		expect((await call(event('nope'))).status).toBe(404)
		const { organization } = await setupTestOrgWithUser('admin')
		await db
			.update(Organization)
			.set({ hasProvisionedDb: false })
			.where(eq(Organization.id, organization.id))
		expect((await call(event(organization.id))).status).toBe(404)
	})

	it('tells the people who can reschedule, in the app and by email, once', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await provisioned(organization.id)

		const first = await call(event(organization.id))
		expect(first.status).toBe(200)
		expect(await first.json()).toEqual({ inApp: 1 })
		const rows = await notificationsFor(user.id)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			type: CAMPAIGN_ALERT_TYPE,
			entityId: 'camp-1',
			organizationId: organization.id,
		})
		// Ids only: no name, subject or count in the notification.
		expect(JSON.parse(rows[0]!.payload)).toEqual({
			orgSlug: organization.slug,
			campaignId: 'camp-1',
		})
		expect(sendEmailMock).toHaveBeenCalledTimes(1)
		expect(sendEmailMock.mock.calls[0]![0].to).toBe(
			(await db.select().from(User).where(eq(User.id, user.id)))[0]!.email,
		)
		// Plain English: a request from the region has no locale to translate to.
		expect(sendEmailMock.mock.calls[0]![0].subject).toBe(
			'A broadcast was not sent: too late',
		)

		// A retried delivery tells nobody twice.
		const again = await call(event(organization.id))
		expect(await again.json()).toEqual({ inApp: 0 })
		expect(await notificationsFor(user.id)).toHaveLength(1)
		expect(sendEmailMock).toHaveBeenCalledTimes(1)

		// Another broadcast is another notice.
		expect(await (await call(event(organization.id, 'camp-2'))).json()).toEqual(
			{
				inApp: 1,
			},
		)
	})

	it('leaves out members who cannot change broadcasts and banned members', async () => {
		const { organization, user: admin } = await setupTestOrgWithUser('admin')
		await provisioned(organization.id)
		const viewer = await createTestUser()
		await addOrganizationMember(viewer.id, organization.id, 'org_role_viewer')
		const banned = await createTestUser()
		await addOrganizationMember(banned.id, organization.id, 'org_role_admin')
		await db
			.update(User)
			.set({ isBanned: true, bannedAt: new Date(Date.now() - 1000) })
			.where(eq(User.id, banned.id))

		const res = await call(event(organization.id))
		expect(await res.json()).toEqual({ inApp: 1 })
		expect(await notificationsFor(admin.id)).toHaveLength(1)
		expect(await notificationsFor(viewer.id)).toEqual([])
		expect(await notificationsFor(banned.id)).toEqual([])
	})

	it('does not tell members of another organization', async () => {
		const a = await setupTestOrgWithUser('admin')
		const b = await setupTestOrgWithUser('admin')
		await provisioned(a.organization.id)
		await provisioned(b.organization.id)
		await call(event(a.organization.id))
		expect(await notificationsFor(b.user.id)).toEqual([])
	})
})
