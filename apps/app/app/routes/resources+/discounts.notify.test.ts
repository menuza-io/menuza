import { db, Discount, eq, Notification, Organization } from '@repo/database'
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

import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import { action } from './discounts.notify.ts'

/**
 * `POST /resources/discounts/notify` (#392): the region tells the people who
 * change discounts that a weekly budget ran out. Ids and a week only, once per
 * discount and week, and only for a discount of that organization.
 */

async function discountFor(
	organizationId: string,
	overrides: Partial<typeof Discount.$inferInsert> = {},
) {
	const [row] = await db
		.insert(Discount)
		.values({
			organizationId,
			name: 'Happy hour',
			application: 'automatic',
			valueType: 'percent',
			percentBp: 1000,
			currency: 'USD',
			weeklyBudgetMinor: 10_000,
			target: JSON.stringify({
				scope: 'order',
				itemIds: [],
				categoryIds: [],
				excludeItemIds: [],
				excludeCategoryIds: [],
			}),
			...overrides,
		})
		.returning({ id: Discount.id })
	return row!.id
}

async function ready(organizationId: string) {
	await db
		.update(Organization)
		.set({ hasProvisionedDb: true })
		.where(eq(Organization.id, organizationId))
}

function call(
	body: unknown,
	options: { authorized?: boolean; method?: string } = {},
) {
	return action({
		request: new Request('http://localhost:3001/resources/discounts/notify', {
			method: options.method ?? 'POST',
			headers: {
				'content-type': 'application/json',
				...(options.authorized === false
					? {}
					: { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` }),
			},
			body: typeof body === 'string' ? body : JSON.stringify(body),
		}),
		params: {},
		context: new RouterContextProvider(),
		unstable_pattern: '/resources/discounts/notify',
	} as never)
}

const event = (orgId: string, discountId: string, week = '2026-W46') => ({
	orgId,
	kind: 'budget_reached' as const,
	discountId,
	week,
})

const notificationsFor = (userId: string) =>
	db.select().from(Notification).where(eq(Notification.userId, userId))

beforeEach(() => {
	sendEmailMock.mockReset().mockResolvedValue({ status: 'success', data: {} })
})

describe('POST /resources/discounts/notify', () => {
	it('answers 401 without the internal token and does nothing', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await ready(organization.id)
		const id = await discountFor(organization.id)
		const response = await call(event(organization.id, id), {
			authorized: false,
		})
		expect(response.status).toBe(401)
		expect(await notificationsFor(user.id)).toHaveLength(0)
		expect(sendEmailMock).not.toHaveBeenCalled()
	})

	it('is a POST route only', async () => {
		expect((await call({}, { method: 'PUT' })).status).toBe(405)
	})

	it.each([
		['an amount', { amountMinor: 10_000 }],
		['a guest name', { guest: 'Rana' }],
		['another kind', { kind: 'paused' }],
		['a bad week', { week: 'next week' }],
		['no discount', { discountId: undefined }],
	])('rejects an event with %s, without echoing it', async (_label, patch) => {
		const { organization } = await setupTestOrgWithUser('admin')
		await ready(organization.id)
		const id = await discountFor(organization.id)
		const response = await call({ ...event(organization.id, id), ...patch })
		expect(response.status).toBe(400)
		const text = await response.text()
		expect(text).not.toContain('10000')
		expect(text).not.toContain('Rana')
		expect(text).not.toContain('next week')
	})

	it('answers 404 for an organization that does not exist', async () => {
		expect(
			(await call(event('clw9x0a12000008l00nobody', 'whatever'))).status,
		).toBe(404)
	})

	it('tells the members who change discounts, in the app and by email', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await ready(organization.id)
		const id = await discountFor(organization.id)
		const response = await call(event(organization.id, id))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ inApp: 1 })
		const [row] = await notificationsFor(user.id)
		expect(row).toMatchObject({
			type: 'discount_budget_reached',
			entityId: `${id}:2026-W46`,
		})
		// No amount, no guest, only where to go.
		expect(JSON.parse(String(row!.payload))).toEqual({
			orgSlug: organization.slug,
			discountId: id,
			kind: 'budget_reached',
		})
		expect(sendEmailMock).toHaveBeenCalledTimes(1)
		expect(sendEmailMock.mock.calls[0]![0].subject).toContain('Happy hour')
	})

	it('says it once for a discount and a week, however often it is sent', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await ready(organization.id)
		const id = await discountFor(organization.id)
		await call(event(organization.id, id))
		const again = await call(event(organization.id, id))
		expect(await again.json()).toEqual({ inApp: 0 })
		expect(await notificationsFor(user.id)).toHaveLength(1)
		expect(sendEmailMock).toHaveBeenCalledTimes(1)
		// The next week is a new notice.
		await call(event(organization.id, id, '2026-W47'))
		expect(await notificationsFor(user.id)).toHaveLength(2)
	})

	it('does not tell members who cannot change discounts', async () => {
		const { organization, user } = await setupTestOrgWithUser('viewer')
		await ready(organization.id)
		const id = await discountFor(organization.id)
		const response = await call(event(organization.id, id))
		expect(await response.json()).toMatchObject({ skipped: 'no_recipients' })
		expect(await notificationsFor(user.id)).toHaveLength(0)
	})

	it('ignores a discount of another organization, and one whose budget was removed', async () => {
		const first = await setupTestOrgWithUser('admin')
		const second = await setupTestOrgWithUser('admin')
		await ready(first.organization.id)
		await ready(second.organization.id)
		const other = await discountFor(second.organization.id)
		const elsewhere = await call(event(first.organization.id, other))
		expect(await elsewhere.json()).toMatchObject({
			skipped: 'unknown_discount',
		})
		const removed = await discountFor(first.organization.id, {
			weeklyBudgetMinor: null,
		})
		expect(
			await (await call(event(first.organization.id, removed))).json(),
		).toMatchObject({ skipped: 'no_budget' })
		expect(await notificationsFor(first.user.id)).toHaveLength(0)
		expect(sendEmailMock).not.toHaveBeenCalled()
	})
})
