import {
	ALERT_SETTINGS_WORKFLOW,
	ALERT_VERIFY_MAX_ATTEMPTS,
	type OrdersNotifyEvent,
} from '@repo/common/operator-alerts'
import {
	AlertLog,
	and,
	ConfigFlag,
	db,
	eq,
	inArray,
	Notification,
	NotificationPreference,
	OperatorPushDevice,
	Organization,
	OrganizationLocation,
	OrderAlertRecipient,
} from '@repo/database'
import type * as EmailModule from '@repo/email'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

// The OperatorAlertsWorkflow wake-up is jobs-cron's: never reached in a test.
vi.mock('#app/utils/alerts/wake.server.ts', () => ({
	OPERATOR_ALERTS_START_PATH: '/workflows/operator-alerts/start',
	wakeOperatorAlertsAt: vi.fn(async () => true),
}))

vi.mock('@repo/email', async (importOriginal) => ({
	...(await importOriginal<typeof EmailModule>()),
	sendEmail: sendEmailMock,
}))

import {
	getMockOperatorPushProvider,
	setOperatorPushProvider,
} from '#app/utils/alerts/push-provider.server.ts'
import { registerOperatorDevice } from '#app/utils/alerts/push.server.ts'
import {
	addLocationRecipient,
	confirmRecipientCode,
	removeLocationRecipient,
	sendRecipientCode,
} from '#app/utils/alerts/recipients.server.ts'
import {
	getMockAlertTextProvider,
	setAlertTextProvider,
} from '#app/utils/alerts/text.server.ts'
import {
	addOrganizationMember,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action } from './orders.notify.ts'

const createdFlagIds: string[] = []
const push = getMockOperatorPushProvider()
const texts = getMockAlertTextProvider()

async function setFlag(organizationId: string, key: string, value: unknown) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({ key, value, level: 'organization', organizationId })
		.returning({ id: ConfigFlag.id })
	createdFlagIds.push(row!.id)
}

async function turnOn(
	organizationId: string,
	{ push: pushOn = false }: { push?: boolean } = {},
) {
	await setFlag(organizationId, 'orders.manager_alerts', true)
	if (pushOn) await setFlag(organizationId, 'notifications.operator_push', true)
	await db
		.update(Organization)
		.set({ hasProvisionedDb: true })
		.where(eq(Organization.id, organizationId))
}

/** Open every day all day, so the hours window never gets in a test's way. */
const ALWAYS_OPEN = JSON.stringify(
	[
		'monday',
		'tuesday',
		'wednesday',
		'thursday',
		'friday',
		'saturday',
		'sunday',
	].map((day) => ({
		day,
		isOpen: true,
		slots: [{ start: '00:00', end: '23:59' }],
	})),
)

async function createLocation(
	organizationId: string,
	patch: Partial<typeof OrganizationLocation.$inferInsert> = {},
) {
	const [row] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId,
			name: 'Downtown',
			slug: `loc-${crypto.randomUUID().slice(0, 8)}`,
			storeHours: ALWAYS_OPEN,
			...patch,
		})
		.returning({ id: OrganizationLocation.id })
	return row!.id
}

function placed(
	organizationId: string,
	locationId: string,
	patch: Partial<Extract<OrdersNotifyEvent, { kind: 'order_placed' }>> = {},
): OrdersNotifyEvent {
	return {
		kind: 'order_placed',
		orgId: organizationId,
		eventId: crypto.randomUUID().replace(/-/g, ''),
		locationId,
		orderNumber: 'W-0042',
		fulfillment: 'pickup',
		scheduledForMs: null,
		totalCents: 3850,
		currency: 'SAR',
		dishCount: 3,
		large: false,
		...patch,
	}
}

function call(
	body: unknown,
	options: { authorized?: boolean; method?: string } = {},
) {
	return action({
		request: new Request('http://localhost:3001/resources/orders/notify', {
			method: options.method ?? 'POST',
			headers: {
				'content-type': 'application/json',
				...(options.authorized === false
					? {}
					: { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` }),
			},
			...(options.method === 'GET'
				? {}
				: { body: typeof body === 'string' ? body : JSON.stringify(body) }),
		}),
		params: {},
		context: new RouterContextProvider(),
		unstable_pattern: '/resources/orders/notify',
	} as never)
}

async function bellFor(userId: string) {
	return (
		await db.select().from(Notification).where(eq(Notification.userId, userId))
	).filter((row) => row.type !== 'orders-marker')
}

async function logFor(userId: string) {
	return db.select().from(AlertLog).where(eq(AlertLog.userId, userId))
}

async function prefer(
	userId: string,
	organizationId: string,
	workflow: string,
	values: Partial<typeof NotificationPreference.$inferInsert>,
) {
	await db
		.insert(NotificationPreference)
		.values({ userId, organizationId, workflow, ...values })
}

async function phone(
	userId: string,
	token = `ExponentPushToken[${crypto.randomUUID().slice(0, 12)}]`,
) {
	await registerOperatorDevice(userId, {
		token,
		platform: 'ios',
		locale: 'en',
	})
	return token
}

const GUEST_STRINGS = [
	'Layla Hassan',
	'+966501234567',
	'layla@example.com',
	'Olaya Street',
]

beforeEach(() => {
	sendEmailMock.mockReset().mockResolvedValue({ status: 'success', data: {} })
	push.reset()
	texts.reset()
	setOperatorPushProvider(push)
	setAlertTextProvider(texts)
	delete process.env.ORDERS_ALERTS_ENABLED
	delete process.env.ORDERS_EMAIL_ENABLED
	delete process.env.ORDER_ALERT_SMS_ENABLED
	delete process.env.OPERATOR_PUSH_ENABLED
})

afterEach(async () => {
	if (createdFlagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, createdFlagIds))
		createdFlagIds.length = 0
	}
	setOperatorPushProvider(null)
	setAlertTextProvider(null)
})

describe('POST /resources/orders/notify shape and access', () => {
	it('answers 401 without the internal token and does nothing', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const response = await call(placed(organization.id, location), {
			authorized: false,
		})
		expect(response.status).toBe(401)
		expect(await bellFor(user.id)).toHaveLength(0)
	})

	it('refuses a method other than POST', async () => {
		const response = await call({}, { method: 'GET' })
		expect(response.status).toBe(405)
	})

	it.each([
		['contactName', 'Layla Hassan'],
		['contactPhone', '+966501234567'],
		['deliveryAddress', 'Olaya Street'],
		['items', ['Burger']],
		['notes', 'no onions'],
	])(
		'rejects an event with a %s field and does not echo it',
		async (field, value) => {
			const { organization, user } = await setupTestOrgWithUser('admin')
			await turnOn(organization.id)
			const location = await createLocation(organization.id)
			const response = await call({
				...placed(organization.id, location),
				[field]: value,
			})
			expect(response.status).toBe(400)
			const text = await response.text()
			for (const guest of GUEST_STRINGS) expect(text).not.toContain(guest)
			expect(await bellFor(user.id)).toHaveLength(0)
		},
	)

	it('rejects an order number that is not an order number', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const response = await call(
			placed(organization.id, location, { orderNumber: 'Layla Hassan' }),
		)
		expect(response.status).toBe(400)
		expect(await bellFor(user.id)).toHaveLength(0)
	})

	it('answers 404 for an organization it does not know', async () => {
		const response = await call(placed('org_missing', 'loc'))
		expect(response.status).toBe(404)
	})
})

describe('flag and kill switch', () => {
	it('does nothing while the organization flag is off', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		const location = await createLocation(organization.id)
		await db
			.update(Organization)
			.set({ hasProvisionedDb: true })
			.where(eq(Organization.id, organization.id))
		const response = await call(placed(organization.id, location))
		expect(response.status).toBe(200)
		expect((await response.json()) as { skipped?: string }).toMatchObject({
			skipped: 'feature_off',
		})
		expect(await bellFor(user.id)).toHaveLength(0)
	})

	it('with ORDERS_ALERTS_ENABLED=false nothing is sent, and nothing is sent later', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, { push: true })
		const location = await createLocation(organization.id)
		await phone(user.id)
		process.env.ORDERS_ALERTS_ENABLED = 'false'
		const dropped = await call(placed(organization.id, location))
		expect(((await dropped.json()) as { skipped?: string }).skipped).toBe(
			'feature_off',
		)
		expect(await bellFor(user.id)).toHaveLength(0)
		expect(await logFor(user.id)).toHaveLength(0)
		expect(push.sent).toHaveLength(0)
		expect(sendEmailMock).not.toHaveBeenCalled()

		// Switching it back on sends no backlog: the dropped event is gone.
		delete process.env.ORDERS_ALERTS_ENABLED
		expect(await bellFor(user.id)).toHaveLength(0)
		expect(push.sent).toHaveLength(0)
	})
})

describe('a new online order', () => {
	it('reaches an owner in the bell and as a push, with no guest details anywhere', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, { push: true })
		const location = await createLocation(organization.id)
		await phone(user.id)
		const response = await call(placed(organization.id, location))
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({ inApp: 1, pushed: 1 })

		const bell = await bellFor(user.id)
		expect(bell).toHaveLength(1)
		expect(bell[0]!.type).toBe('orders-new')
		expect(push.sent).toHaveLength(1)
		const everything = JSON.stringify([bell, push.sent])
		for (const guest of GUEST_STRINGS) expect(everything).not.toContain(guest)
		expect(push.sent[0]!.title).toBe('New order W-0042')
		expect(push.sent[0]!.data).toEqual({
			kind: 'orders-new',
			url: expect.stringContaining('/orders'),
			notificationId: bell[0]!.id,
		})
		// Order alerts do not email every manager for every order by default.
		expect(sendEmailMock).not.toHaveBeenCalled()
	})

	it('does not push to a member who is not a manager unless they switch it on', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, { push: true })
		const location = await createLocation(organization.id)
		const cook = await createTestUser()
		await addOrganizationMember(cook.id, organization.id, 'org_role_member')
		await phone(cook.id)
		await call(placed(organization.id, location))
		expect(push.sent).toHaveLength(0)
		expect(await bellFor(cook.id)).toHaveLength(1)

		await prefer(cook.id, organization.id, 'orders_new', { push: true })
		await call(placed(organization.id, location, { orderNumber: 'W-0043' }))
		expect(push.sent).toHaveLength(1)
	})

	it('does not push when the organization has push off', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		await phone(user.id)
		await call(placed(organization.id, location))
		expect(push.sent).toHaveLength(0)
		expect(await bellFor(user.id)).toHaveLength(1)
	})

	it('sends one alert per event however many times it is delivered', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, { push: true })
		const location = await createLocation(organization.id)
		await phone(user.id)
		const event = placed(organization.id, location)
		await call(event)
		await call(event)
		expect(await bellFor(user.id)).toHaveLength(1)
		expect(push.sent).toHaveLength(1)
		expect(await logFor(user.id)).toHaveLength(1)
	})

	it('only alerts members whose location scope covers the location', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const downtown = await createLocation(organization.id)
		const airport = await createLocation(organization.id, { name: 'Airport' })
		const airportCook = await createTestUser()
		await addOrganizationMember(
			airportCook.id,
			organization.id,
			'org_role_member',
		)
		const { setMemberLocationScope } =
			await import('#app/utils/staffing/restaurant/location-scope.server.ts')
		await setMemberLocationScope({
			userId: airportCook.id,
			organizationId: organization.id,
			value: { scope: 'selected', locationIds: [airport] },
		})
		await call(placed(organization.id, downtown))
		expect(await bellFor(user.id)).toHaveLength(1)
		expect(await bellFor(airportCook.id)).toHaveLength(0)
		await call(placed(organization.id, airport, { orderNumber: 'W-9' }))
		expect(await bellFor(airportCook.id)).toHaveLength(1)
	})

	it('stops alerting a member who is removed', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, { push: true })
		const location = await createLocation(organization.id)
		const manager = await createTestUser()
		await addOrganizationMember(manager.id, organization.id, 'org_role_admin')
		await phone(manager.id)
		await call(placed(organization.id, location))
		expect(push.sent).toHaveLength(1)
		const { UserOrganization } = await import('@repo/database')
		await db
			.update(UserOrganization)
			.set({ active: false })
			.where(
				and(
					eq(UserOrganization.userId, manager.id),
					eq(UserOrganization.organizationId, organization.id),
				),
			)
		await call(placed(organization.id, location, { orderNumber: 'W-2' }))
		expect(push.sent).toHaveLength(1)
		expect(await bellFor(manager.id)).toHaveLength(1)
	})
})

describe('quiet hours, snooze, thresholds and the log (#366)', () => {
	it('a snooze stops delivery for that person and the log says snoozed', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, { push: true })
		const location = await createLocation(organization.id)
		await phone(user.id)
		await prefer(user.id, organization.id, ALERT_SETTINGS_WORKFLOW, {
			snoozedUntil: new Date(Date.now() + 60 * 60 * 1000),
		})
		await call(placed(organization.id, location))
		expect(push.sent).toHaveLength(0)
		const log = await logFor(user.id)
		expect(log).toHaveLength(1)
		expect(log[0]!.outcome).toBe('snoozed')
		// The alert still sits in the bell: snoozing quiets the phone.
		expect(await bellFor(user.id)).toHaveLength(1)
	})

	it('quiet hours hold a non-critical alert and keep it for when they end', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, { push: true })
		const location = await createLocation(organization.id)
		await phone(user.id)
		// A window that is always on: 00:00 to 23:59 UTC.
		await prefer(user.id, organization.id, ALERT_SETTINGS_WORKFLOW, {
			quietStart: '00:00',
			quietEnd: '23:59',
			timeZone: 'UTC',
		})
		await prefer(user.id, organization.id, 'orders_waiting', { email: true })
		await call(placed(organization.id, location))
		expect(push.sent).toHaveLength(0)
		const [row] = await logFor(user.id)
		expect(row!.outcome).toBe('held')
		expect(row!.heldUntil).toBeInstanceOf(Date)
		expect(JSON.parse(row!.heldChannels ?? '[]')).toEqual(['push'])
		expect(await bellFor(user.id)).toHaveLength(1)
	})

	it('never holds or snoozes a payment that needs review', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, { push: true })
		const location = await createLocation(organization.id)
		await phone(user.id)
		await prefer(user.id, organization.id, ALERT_SETTINGS_WORKFLOW, {
			quietStart: '00:00',
			quietEnd: '23:59',
			timeZone: 'UTC',
			snoozedUntil: new Date(Date.now() + 60 * 60 * 1000),
		})
		const response = await call({
			kind: 'orders_payment_review',
			orgId: organization.id,
			eventId: 'review-1',
			locationId: location,
			orderNumber: 'W-0077',
		})
		expect(await response.json()).toMatchObject({ pushed: 1, emailed: 1 })
		expect(push.sent).toHaveLength(1)
		expect(push.sent[0]!.title).toBe('Payment needs review')
		const [row] = await logFor(user.id)
		expect(row).toMatchObject({ outcome: 'critical', critical: true })
	})

	it('applies a threshold: the third order in an hour alerts, the first two do not', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, { push: true })
		const location = await createLocation(organization.id)
		await phone(user.id)
		await prefer(user.id, organization.id, 'orders_new', { threshold: 3 })
		for (const number of ['W-1', 'W-2', 'W-3']) {
			await call(placed(organization.id, location, { orderNumber: number }))
		}
		expect(push.sent).toHaveLength(1)
		expect(push.sent[0]!.title).toBe('New order W-3')
		const outcomes = (await logFor(user.id))
			.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
			.map((row) => row.outcome)
		expect(outcomes.filter((o) => o === 'below_threshold')).toHaveLength(2)
		expect(outcomes.filter((o) => o === 'delivered')).toHaveLength(1)
		// Below the threshold nothing reaches the bell either.
		expect(await bellFor(user.id)).toHaveLength(1)
	})

	it('keeps the alert log inside the organization', async () => {
		const first = await setupTestOrgWithUser('admin')
		const second = await setupTestOrgWithUser('admin')
		await turnOn(first.organization.id)
		await turnOn(second.organization.id)
		const location = await createLocation(first.organization.id)
		await call(placed(first.organization.id, location))
		expect(await logFor(first.user.id)).toHaveLength(1)
		expect(await logFor(second.user.id)).toHaveLength(0)
	})
})

describe('waiting orders (#131)', () => {
	function waiting(
		organizationId: string,
		locationId: string,
		patch: Partial<Extract<OrdersNotifyEvent, { kind: 'orders_waiting' }>> = {},
	): OrdersNotifyEvent {
		return {
			kind: 'orders_waiting',
			orgId: organizationId,
			eventId: `waiting:${crypto.randomUUID().slice(0, 8)}`,
			locationId,
			orderNumbers: ['W-0042'],
			...patch,
		}
	}

	it('tells subscribed managers of the location once, by email and in the bell, naming the order and place', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const event = waiting(organization.id, location)
		await call(event)
		await call(event)
		expect(await bellFor(user.id)).toHaveLength(1)
		expect(sendEmailMock).toHaveBeenCalledTimes(1)
		const mail = sendEmailMock.mock.calls[0]![0] as { subject: string }
		expect(mail.subject).toContain('Order W-0042 is waiting')
		expect(mail.subject).toContain('Downtown')
		const everything = JSON.stringify([await bellFor(user.id), mail.subject])
		for (const guest of GUEST_STRINGS) expect(everything).not.toContain(guest)
	})

	it('several waiting orders make one alert', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		await call(
			waiting(organization.id, location, {
				orderNumbers: ['W-1', 'W-2', 'W-3'],
			}),
		)
		const bell = await bellFor(user.id)
		expect(bell).toHaveLength(1)
		expect(bell[0]!.payload).toContain('W-1')
	})

	it('does not alert a member who switched the alert off', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		await prefer(user.id, organization.id, 'orders_waiting', {
			inApp: false,
			email: false,
		})
		await call(waiting(organization.id, location))
		expect(await bellFor(user.id)).toHaveLength(0)
		expect(sendEmailMock).not.toHaveBeenCalled()
	})

	it('sends no email with ORDERS_EMAIL_ENABLED=false, but the bell still shows it', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		process.env.ORDERS_EMAIL_ENABLED = 'false'
		await call(waiting(organization.id, location))
		expect(sendEmailMock).not.toHaveBeenCalled()
		expect(await bellFor(user.id)).toHaveLength(1)
	})

	it('stays quiet outside opening hours plus an hour', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const closedAllWeek = JSON.stringify(
			[
				'monday',
				'tuesday',
				'wednesday',
				'thursday',
				'friday',
				'saturday',
				'sunday',
			].map((day) => ({ day, isOpen: false, slots: [] })),
		)
		const location = await createLocation(organization.id, {
			storeHours: closedAllWeek,
		})
		const response = await call(waiting(organization.id, location))
		expect(((await response.json()) as { skipped?: string }).skipped).toBe(
			'outside_hours',
		)
		expect(await bellFor(user.id)).toHaveLength(0)
	})
})

describe('large orders (#300)', () => {
	it('tells large orders once, as large, and a normal order as a normal one', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, { push: true })
		const location = await createLocation(organization.id)
		await phone(user.id)
		await call(
			placed(organization.id, location, {
				large: true,
				dishCount: 22,
				totalCents: 98000,
			}),
		)
		const bell = await bellFor(user.id)
		expect(bell.map((row) => row.type)).toEqual(['orders-large'])
		expect(push.sent[0]!.title).toBe('Large order W-0042')
		expect(push.sent[0]!.body).toContain('22 dishes')

		await call(placed(organization.id, location, { orderNumber: 'W-0043' }))
		expect((await bellFor(user.id)).map((row) => row.type).sort()).toEqual([
			'orders-large',
			'orders-new',
		])
	})

	it('falls back to the new-order alert for a member who has large alerts off', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		await prefer(user.id, organization.id, 'orders_large', {
			inApp: false,
			email: false,
			push: false,
		})
		await call(placed(organization.id, location, { large: true }))
		expect((await bellFor(user.id)).map((row) => row.type)).toEqual([
			'orders-new',
		])
	})

	it('tells a scheduled large order again shortly before it starts', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, { push: true })
		const location = await createLocation(organization.id)
		await phone(user.id)
		await call({
			kind: 'large_order_soon',
			orgId: organization.id,
			eventId: 'large-soon-1',
			locationId: location,
			orderNumber: 'W-0050',
			fulfillment: 'pickup',
			scheduledForMs: Date.now() + 3_600_000,
			totalCents: 120000,
			currency: 'SAR',
			dishCount: 30,
		})
		expect(push.sent[0]!.title).toBe('Large order W-0050 starts soon')
	})
})

describe('chosen recipients (#241)', () => {
	async function recipient(
		organizationId: string,
		locationId: string,
		address: string,
		{
			verify = true,
			region = 'us',
		}: { verify?: boolean; region?: string } = {},
	) {
		const added = await addLocationRecipient({
			organizationId,
			locationId,
			rawAddress: address,
			dataRegion: region,
			createdBy: null,
		})
		if (!added.ok) throw new Error(added.error)
		if (verify) {
			await db
				.update(OrderAlertRecipient)
				.set({ verifiedAt: new Date() })
				.where(eq(OrderAlertRecipient.id, added.recipient.id))
		}
		return added.recipient
	}

	it('emails a verified recipient and texts a verified number, with no guest name or phone', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		await recipient(organization.id, location, 'Owner@Example.com')
		await recipient(organization.id, location, '(415) 555-0100')
		const response = await call(placed(organization.id, location))
		expect(await response.json()).toMatchObject({ emailed: 1, texted: 1 })
		const mail = sendEmailMock.mock.calls.find(
			([args]) => (args as { to: string }).to === 'owner@example.com',
		)
		expect(mail).toBeTruthy()
		expect(texts.sent).toHaveLength(1)
		expect(texts.sent[0]!.to).toBe('+14155550100')
		expect(texts.sent[0]!.text).toContain('New order W-0042')
		expect(texts.sent[0]!.text.endsWith('Reply STOP to opt out.')).toBe(true)
		const everything = JSON.stringify([
			texts.sent,
			sendEmailMock.mock.calls.map(([a]) => (a as { subject: string }).subject),
		])
		for (const guest of GUEST_STRINGS) expect(everything).not.toContain(guest)
	})

	it('does not alert a recipient who has not confirmed', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		await recipient(organization.id, location, 'unverified@example.com', {
			verify: false,
		})
		await call(placed(organization.id, location))
		expect(
			sendEmailMock.mock.calls.some(
				([args]) => (args as { to: string }).to === 'unverified@example.com',
			),
		).toBe(false)
	})

	it('sends one alert per order per recipient', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		await recipient(organization.id, location, '(415) 555-0100')
		const event = placed(organization.id, location)
		await call(event)
		await call(event)
		expect(texts.sent).toHaveLength(1)
	})

	it('an unaccepted order triggers one reminder to a recipient', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		await recipient(organization.id, location, '(415) 555-0100')
		const reminder: OrdersNotifyEvent = {
			kind: 'orders_waiting',
			orgId: organization.id,
			eventId: 'waiting:abc',
			locationId: location,
			orderNumbers: ['W-0042'],
		}
		await call(reminder)
		await call(reminder)
		expect(texts.sent).toHaveLength(1)
		expect(texts.sent[0]!.text).toContain('Order W-0042 is waiting')
	})

	it('removing a recipient stops alerts at once', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const saved = await recipient(organization.id, location, '(415) 555-0100')
		await call(placed(organization.id, location))
		expect(texts.sent).toHaveLength(1)
		await db
			.delete(OrderAlertRecipient)
			.where(eq(OrderAlertRecipient.id, saved.id))
		await call(placed(organization.id, location, { orderNumber: 'W-2' }))
		expect(texts.sent).toHaveLength(1)
	})

	it('respects the per-recipient switches for ASAP and scheduled orders', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const saved = await recipient(organization.id, location, '(415) 555-0100')
		await db
			.update(OrderAlertRecipient)
			.set({ scheduledOrders: false })
			.where(eq(OrderAlertRecipient.id, saved.id))
		await call(
			placed(organization.id, location, {
				scheduledForMs: Date.now() + 86_400_000,
			}),
		)
		expect(texts.sent).toHaveLength(0)
		await call(placed(organization.id, location, { orderNumber: 'W-2' }))
		expect(texts.sent).toHaveLength(1)
	})

	it('drops texts with the SMS kill switch off, and sends no backlog when it is back on', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		await recipient(organization.id, location, '(415) 555-0100')
		process.env.ORDER_ALERT_SMS_ENABLED = 'false'
		const event = placed(organization.id, location)
		await call(event)
		expect(texts.sent).toHaveLength(0)
		delete process.env.ORDER_ALERT_SMS_ENABLED
		expect(texts.sent).toHaveLength(0)
		// The dropped occurrence is in the log and is not retried by a redelivery.
		await call(event)
		expect(texts.sent).toHaveLength(0)
	})

	it('never texts a recipient of a Saudi organization, but still emails', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		await db
			.update(Organization)
			.set({ dataRegion: 'ksa' })
			.where(eq(Organization.id, organization.id))
		const location = await createLocation(organization.id)
		const refused = await addLocationRecipient({
			organizationId: organization.id,
			locationId: location,
			rawAddress: '+966501234567',
			dataRegion: 'ksa',
			createdBy: null,
		})
		expect(refused).toEqual({ ok: false, error: 'sms_unavailable' })
		await recipient(organization.id, location, 'riyadh@example.com', {
			region: 'ksa',
		})
		const response = await call(
			placed(organization.id, location, { currency: 'SAR' }),
		)
		expect(await response.json()).toMatchObject({ emailed: 1, texted: 0 })
		expect(texts.sent).toHaveLength(0)
	})

	it('confirms a recipient only with the right code', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const added = await recipient(
			organization.id,
			location,
			'confirm@example.com',
			{
				verify: false,
			},
		)
		const { sendRecipientCode } =
			await import('#app/utils/alerts/recipients.server.ts')
		const sent = await sendRecipientCode({
			organizationId: organization.id,
			recipientId: added.id,
			organizationName: 'Acme',
			dataRegion: 'us',
			settingsUrl: 'https://app.example/acme/settings/locations',
		})
		expect(sent).toEqual({ ok: true })
		const subject = (sendEmailMock.mock.calls.at(-1)![0] as { subject: string })
			.subject
		const code = /(\d{6})/.exec(subject)![1]!
		expect(
			await confirmRecipientCode({
				organizationId: organization.id,
				recipientId: added.id,
				code: code === '000000' ? '111111' : '000000',
			}),
		).toEqual({ ok: false, error: 'wrong_code' })
		expect(
			await confirmRecipientCode({
				organizationId: organization.id,
				recipientId: added.id,
				code,
			}),
		).toEqual({ ok: true })
	})

	async function emailCode(organizationId: string, recipientId: string) {
		const sent = await sendRecipientCode({
			organizationId,
			recipientId,
			organizationName: 'Acme',
			dataRegion: 'us',
			settingsUrl: 'https://app.example/acme/settings/locations',
		})
		return sent
	}

	it('counts every guess before it compares, so parallel guesses cannot beat the limit', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const added = await recipient(
			organization.id,
			location,
			`race-${crypto.randomUUID()}@example.com`,
			{ verify: false },
		)
		expect(await emailCode(organization.id, added.id)).toEqual({ ok: true })
		const subject = (sendEmailMock.mock.calls.at(-1)![0] as { subject: string })
			.subject
		const code = /(\d{6})/.exec(subject)![1]!
		const wrong = code === '000000' ? '111111' : '000000'
		const results = await Promise.all(
			Array.from({ length: 12 }, () =>
				confirmRecipientCode({
					organizationId: organization.id,
					recipientId: added.id,
					code: wrong,
				}),
			),
		)
		expect(
			results.filter((r) => !r.ok && r.error === 'wrong_code'),
		).toHaveLength(ALERT_VERIFY_MAX_ATTEMPTS)
		expect(
			results.filter((r) => !r.ok && r.error === 'too_many_tries'),
		).toHaveLength(12 - ALERT_VERIFY_MAX_ATTEMPTS)
		const [row] = await db
			.select({ attempts: OrderAlertRecipient.verifyAttempts })
			.from(OrderAlertRecipient)
			.where(eq(OrderAlertRecipient.id, added.id))
		expect(row?.attempts).toBe(ALERT_VERIFY_MAX_ATTEMPTS)
		// Even the right code is refused once the tries are gone.
		expect(
			await confirmRecipientCode({
				organizationId: organization.id,
				recipientId: added.id,
				code,
			}),
		).toEqual({ ok: false, error: 'too_many_tries' })
	})

	it('limits codes to one destination even when its recipient is removed and added again', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const address = `victim-${crypto.randomUUID()}@example.com`
		const results: string[] = []
		for (let i = 0; i < 5; i++) {
			const added = await addLocationRecipient({
				organizationId: organization.id,
				locationId: location,
				rawAddress: address,
				dataRegion: 'us',
				createdBy: null,
			})
			if (!added.ok) throw new Error(added.error)
			const sent = await emailCode(organization.id, added.recipient.id)
			results.push(sent.ok ? 'sent' : sent.error)
			await removeLocationRecipient({
				organizationId: organization.id,
				recipientId: added.recipient.id,
			})
		}
		expect(results).toEqual([
			'sent',
			'sent',
			'sent',
			'rate_limited',
			'rate_limited',
		])
	})

	it('limits verification messages for one organization a day', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		let refused: string | null = null
		let sentCount = 0
		for (let i = 0; i < 32; i++) {
			const added = await addLocationRecipient({
				organizationId: organization.id,
				locationId: location,
				rawAddress: `bulk-${i}-${crypto.randomUUID()}@example.com`,
				dataRegion: 'us',
				createdBy: null,
			})
			if (!added.ok) throw new Error(added.error)
			const sent = await emailCode(organization.id, added.recipient.id)
			if (sent.ok) sentCount++
			else refused ??= sent.error
			await removeLocationRecipient({
				organizationId: organization.id,
				recipientId: added.recipient.id,
			})
		}
		expect(sentCount).toBe(30)
		expect(refused).toBe('rate_limited')
	})
})

describe('a tablet going offline (#190)', () => {
	const offline = (
		organizationId: string,
		locationId: string,
		patch: Partial<
			Extract<OrdersNotifyEvent, { kind: 'station_offline' }>
		> = {},
	): OrdersNotifyEvent => ({
		kind: 'station_offline',
		orgId: organizationId,
		eventId: `dev1:${Date.now()}`,
		locationId,
		deviceId: 'dev1',
		deviceLabel: 'Kitchen',
		state: 'offline',
		minutes: 5,
		allKitchenOffline: false,
		waitingOrderNumber: null,
		...patch,
	})

	it('alerts managers (settings permission) during opening hours', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, { push: true })
		const location = await createLocation(organization.id)
		const cook = await createTestUser()
		await addOrganizationMember(cook.id, organization.id, 'org_role_member')
		await phone(user.id)
		await prefer(user.id, organization.id, 'station_offline', { push: true })
		await call(offline(organization.id, location))
		expect((await bellFor(user.id)).map((row) => row.type)).toEqual([
			'station-offline',
		])
		expect(await bellFor(cook.id)).toHaveLength(0)
		expect(push.sent[0]!.title).toBe('Kitchen has been offline for 5 minutes')
		expect(sendEmailMock).toHaveBeenCalledTimes(1)
	})

	it('stays quiet outside opening hours plus half an hour', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const closed = JSON.stringify(
			[
				'monday',
				'tuesday',
				'wednesday',
				'thursday',
				'friday',
				'saturday',
				'sunday',
			].map((day) => ({ day, isOpen: false, slots: [] })),
		)
		const location = await createLocation(organization.id, {
			storeHours: closed,
		})
		const response = await call(offline(organization.id, location))
		expect(((await response.json()) as { skipped?: string }).skipped).toBe(
			'outside_hours',
		)
		expect(await bellFor(user.id)).toHaveLength(0)
	})

	it('never calls a tablet offline when the location has no opening hours', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id, { storeHours: null })
		const response = await call(offline(organization.id, location))
		expect(((await response.json()) as { skipped?: string }).skipped).toBe(
			'outside_hours',
		)
		expect(await bellFor(user.id)).toHaveLength(0)
	})

	it('says when it is back online, whatever the hour', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id, { storeHours: null })
		await call(
			offline(organization.id, location, { state: 'back_online', minutes: 9 }),
		)
		expect(await bellFor(user.id)).toHaveLength(1)
	})

	it('treats every kitchen tablet offline with an order waiting as critical', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, { push: true })
		const location = await createLocation(organization.id)
		await phone(user.id)
		await prefer(user.id, organization.id, ALERT_SETTINGS_WORKFLOW, {
			quietStart: '00:00',
			quietEnd: '23:59',
			timeZone: 'UTC',
		})
		await call(
			offline(organization.id, location, {
				allKitchenOffline: true,
				waitingOrderNumber: 'W-0042',
				eventId: 'kitchen-offline:W-0042:1',
			}),
		)
		expect(push.sent).toHaveLength(1)
		expect(push.sent[0]!.title).toBe('Every kitchen tablet is offline')
		expect((await logFor(user.id))[0]).toMatchObject({ outcome: 'critical' })
	})
})

describe('push devices', () => {
	it('moves a token to the next member who signs in on that phone', async () => {
		const first = await createTestUser()
		const second = await createTestUser()
		const token = await phone(first.id)
		await phone(second.id, token)
		const rows = await db
			.select()
			.from(OperatorPushDevice)
			.where(eq(OperatorPushDevice.token, token))
		expect(rows).toHaveLength(1)
		expect(rows[0]!.userId).toBe(second.id)
	})

	it('deletes a device the push service reports dead', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, { push: true })
		const location = await createLocation(organization.id)
		const token = await phone(user.id)
		push.invalidTokens.add(token)
		await call(placed(organization.id, location))
		const left = await db
			.select()
			.from(OperatorPushDevice)
			.where(eq(OperatorPushDevice.userId, user.id))
		expect(left).toHaveLength(0)
		expect(push.sent).toHaveLength(0)
	})
})
