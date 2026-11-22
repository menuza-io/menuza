/**
 * #106 and #366: operator push mirrors the Notification table, devices belong to
 * the signed-in member, dead tokens go, quiet hours hold and later release, and
 * the settings the web and the phone app share.
 */
import { ALERT_SETTINGS_WORKFLOW } from '@repo/common/operator-alerts'
import {
	AlertLog,
	and,
	ConfigFlag,
	db,
	eq,
	inArray,
	Notification,
	NotificationPreference,
	OperatorPushDelivery,
	OperatorPushDevice,
	Organization,
	OrganizationLocation,
	UserOrganization,
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
vi.mock('./wake.server.ts', () => ({
	OPERATOR_ALERTS_START_PATH: '/workflows/operator-alerts/start',
	wakeOperatorAlertsAt: vi.fn(async () => true),
}))

vi.mock('@repo/email', async (importOriginal) => ({
	...(await importOriginal<typeof EmailModule>()),
	sendEmail: sendEmailMock,
}))

import {
	action as devicesAction,
	loader as devicesLoader,
} from '#app/routes/api+/push.devices.ts'
import {
	action as preferencesAction,
	loader as preferencesLoader,
} from '#app/routes/api+/push.preferences.ts'
import { action as inventoryNotify } from '#app/routes/resources+/inventory.notify.ts'
import { createTokenPair } from '#app/utils/jwt.server.ts'
import {
	addOrganizationMember,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { releaseHeldAlerts } from './held.server.ts'
import {
	getMockOperatorPushProvider,
	setOperatorPushProvider,
} from './push-provider.server.ts'
import {
	processOperatorPushReceipts,
	pushStoredNotifications,
	registerOperatorDevice,
} from './push.server.ts'
import {
	loadAlertLog,
	loadAlertSettings,
	saveAlertSetting,
} from './settings.server.ts'
import { alertLongOrderingControls } from './sweep.server.ts'
import * as wake from './wake.server.ts'

const push = getMockOperatorPushProvider()
const flagIds: string[] = []

async function setFlag(organizationId: string, key: string, value: unknown) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({ key, value, level: 'organization', organizationId })
		.returning({ id: ConfigFlag.id })
	flagIds.push(row!.id)
}

async function org(
	options: { push?: boolean; alerts?: boolean; region?: string } = {},
) {
	const made = await setupTestOrgWithUser('admin')
	if (options.push ?? true) {
		await setFlag(made.organization.id, 'notifications.operator_push', true)
	}
	if (options.alerts) {
		await setFlag(made.organization.id, 'orders.manager_alerts', true)
	}
	await setFlag(made.organization.id, 'inventory.enabled', true)
	await db
		.update(Organization)
		.set({ hasProvisionedDb: true, dataRegion: options.region ?? 'us' })
		.where(eq(Organization.id, made.organization.id))
	return made
}

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

async function location(
	organizationId: string,
	patch: Partial<typeof OrganizationLocation.$inferInsert> = {},
) {
	const [row] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId,
			name: 'Riyadh Olaya',
			slug: `loc-${crypto.randomUUID().slice(0, 8)}`,
			storeHours: ALWAYS_OPEN,
			...patch,
		})
		.returning({ id: OrganizationLocation.id })
	return row!.id
}

async function device(userId: string, token?: string) {
	const value =
		token ?? `ExponentPushToken[${crypto.randomUUID().slice(0, 14)}]`
	await registerOperatorDevice(userId, {
		token: value,
		platform: 'android',
		locale: 'ar',
	})
	return value
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
		.onConflictDoUpdate({
			target: [
				NotificationPreference.userId,
				NotificationPreference.organizationId,
				NotificationPreference.workflow,
			],
			set: values,
		})
}

async function notification(
	userId: string,
	organizationId: string,
	type = 'inventory-low-stock',
	payload: Record<string, unknown> = {},
) {
	const [row] = await db
		.insert(Notification)
		.values({
			userId,
			organizationId,
			type,
			entityId: crypto.randomUUID(),
			payload: JSON.stringify({
				kind: 'inventory_low_stock',
				count: 3,
				orgSlug: 'acme',
				...payload,
			}),
		})
		.returning()
	return row!
}

beforeEach(() => {
	push.reset()
	setOperatorPushProvider(push)
	sendEmailMock.mockReset().mockResolvedValue({ status: 'success', data: {} })
	delete process.env.OPERATOR_PUSH_ENABLED
	delete process.env.ORDERS_ALERTS_ENABLED
})

afterEach(async () => {
	if (flagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds))
		flagIds.length = 0
	}
	setOperatorPushProvider(null)
})

describe('push mirrors the Notification table (#106)', () => {
	it('pushes a stored notification once the member turned its category on, with fixed words and no guest', async () => {
		const { organization, user } = await org({ region: 'ksa' })
		await device(user.id)
		await prefer(user.id, organization.id, 'push.inventory', { push: true })
		const row = await notification(
			user.id,
			organization.id,
			'inventory-low-stock',
			{
				locationName: 'Riyadh Olaya',
			},
		)
		const pushed = await pushStoredNotifications([row])
		expect(pushed).toBe(1)
		expect(push.sent).toHaveLength(1)
		const message = push.sent[0]!
		// The device is Arabic.
		expect(message.title).toBe('تنبيه المخزون')
		expect(message.body).toContain('Riyadh Olaya')
		expect(Object.keys(message.data).sort()).toEqual([
			'kind',
			'notificationId',
			'url',
		])
		expect(message.data.notificationId).toBe(row.id)
		// A second call for the same notification sends nothing more.
		await pushStoredNotifications([row])
		expect(push.sent).toHaveLength(1)
	})

	it('sends nothing until the member switches the category on', async () => {
		const { organization, user } = await org()
		await device(user.id)
		const row = await notification(user.id, organization.id)
		expect(await pushStoredNotifications([row])).toBe(0)
		await prefer(user.id, organization.id, 'push.inventory', { push: false })
		expect(await pushStoredNotifications([row])).toBe(0)
		expect(push.sent).toHaveLength(0)
	})

	it('does nothing while the organization has push off or the node switch is off', async () => {
		const off = await org({ push: false })
		await device(off.user.id)
		await prefer(off.user.id, off.organization.id, 'push.inventory', {
			push: true,
		})
		expect(
			await pushStoredNotifications([
				await notification(off.user.id, off.organization.id),
			]),
		).toBe(0)

		const on = await org()
		await device(on.user.id)
		await prefer(on.user.id, on.organization.id, 'push.inventory', {
			push: true,
		})
		process.env.OPERATOR_PUSH_ENABLED = 'false'
		expect(
			await pushStoredNotifications([
				await notification(on.user.id, on.organization.id),
			]),
		).toBe(0)
		expect(push.sent).toHaveLength(0)
	})

	it('stops pushing to a member who left the organization', async () => {
		const { organization, user } = await org()
		await device(user.id)
		await prefer(user.id, organization.id, 'push.inventory', { push: true })
		const row = await notification(user.id, organization.id)
		await db
			.update(UserOrganization)
			.set({ active: false })
			.where(
				and(
					eq(UserOrganization.userId, user.id),
					eq(UserOrganization.organizationId, organization.id),
				),
			)
		expect(await pushStoredNotifications([row])).toBe(0)
		expect(push.sent).toHaveLength(0)
	})

	it('mirrors the inventory notify route end to end', async () => {
		const { organization, user } = await org()
		const place = await location(organization.id)
		await device(user.id)
		await prefer(user.id, organization.id, 'push.inventory', { push: true })
		const response = await inventoryNotify({
			request: new Request('http://localhost:3001/resources/inventory/notify', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}`,
				},
				body: JSON.stringify({
					orgId: organization.id,
					eventId: 'abcdef0123456789abcdef',
					kind: 'inventory_low_stock',
					locationId: place,
					count: 2,
				}),
			}),
			params: {},
			context: new RouterContextProvider(),
			unstable_pattern: '/resources/inventory/notify',
		} as never)
		expect(response.status).toBe(200)
		expect(push.sent).toHaveLength(1)
		expect(push.sent[0]!.data.kind).toBe('inventory-low-stock')
	})
})

describe('devices (#106)', () => {
	async function bearer(user: { id: string; email: string; username: string }) {
		const tokens = await createTokenPair(user, {})
		return `Bearer ${tokens.accessToken}`
	}

	function call(
		fn: typeof devicesAction,
		method: string,
		auth: string | null,
		body?: unknown,
	) {
		return fn({
			request: new Request('http://localhost:3001/api/push/devices', {
				method,
				headers: {
					'content-type': 'application/json',
					...(auth ? { Authorization: auth } : {}),
				},
				...(body === undefined || method === 'GET'
					? {}
					: { body: JSON.stringify(body) }),
			}),
			params: {},
			context: new RouterContextProvider(),
		} as never)
	}

	it('registers, lists and removes a phone for the signed-in member', async () => {
		const user = await createTestUser()
		const auth = await bearer(user)
		const token = 'ExponentPushToken[abcdefgh12345678]'
		const registered = await call(devicesAction, 'POST', auth, {
			token,
			platform: 'ios',
			locale: 'en',
			deviceName: 'iPhone',
		})
		expect(registered.status).toBe(200)
		const { data: registeredData } = (await registered.json()) as {
			data: { deviceId: string }
		}
		const deviceId = registeredData.deviceId
		const listed = await devicesLoader({
			request: new Request('http://localhost:3001/api/push/devices', {
				headers: { Authorization: auth },
			}),
			params: {},
			context: new RouterContextProvider(),
		} as never)
		const body = (await listed.json()) as {
			data: { devices: Array<{ id: string }> }
		}
		expect(body.data.devices.map((d) => d.id)).toEqual([deviceId])
		const removed = await call(devicesAction, 'DELETE', auth, { deviceId })
		expect(await removed.json()).toMatchObject({ data: { removed: 1 } })
		expect(
			await db
				.select()
				.from(OperatorPushDevice)
				.where(eq(OperatorPushDevice.userId, user.id)),
		).toHaveLength(0)
	})

	it('refuses a missing, forged or expired token, and a bad registration', async () => {
		const user = await createTestUser()
		expect((await call(devicesAction, 'POST', null, {})).status).toBe(401)
		expect(
			(await call(devicesAction, 'POST', 'Bearer not-a-token', {})).status,
		).toBe(401)
		const jwt = await import('jsonwebtoken')
		const expired = jwt.default.sign(
			{ sub: user.id, email: user.email, username: user.username },
			process.env.JWT_SECRET!,
			{
				expiresIn: -10,
				issuer: process.env.BASE_URL || 'menuza',
				audience: process.env.BASE_URL || 'menuza-client',
			},
		)
		expect(
			(await call(devicesAction, 'POST', `Bearer ${expired}`, {})).status,
		).toBe(401)
		const auth = await bearer(user)
		const bad = await call(devicesAction, 'POST', auth, {
			token: 'x',
			platform: 'ios',
		})
		expect(bad.status).toBe(400)
		// A guest customer-app token is not an operator push token shape either.
		const extra = await call(devicesAction, 'POST', auth, {
			token: 'ExponentPushToken[abcdefgh12345678]',
			platform: 'ios',
			customerId: 'x',
		})
		expect(extra.status).toBe(400)
	})

	it("never removes another member's phone", async () => {
		const owner = await createTestUser()
		const other = await createTestUser()
		const token = await device(owner.id)
		const removed = await call(devicesAction, 'DELETE', await bearer(other), {
			token,
		})
		expect(await removed.json()).toMatchObject({ data: { removed: 0 } })
		expect(
			await db
				.select()
				.from(OperatorPushDevice)
				.where(eq(OperatorPushDevice.token, token)),
		).toHaveLength(1)
	})

	it('removes dead tokens when the receipts sweep learns they are dead', async () => {
		const { organization, user } = await org()
		const token = await device(user.id)
		await prefer(user.id, organization.id, 'push.inventory', { push: true })
		await pushStoredNotifications([
			await notification(user.id, organization.id),
		])
		const [delivery] = await db.select().from(OperatorPushDelivery)
		expect(delivery!.status).toBe('sent')
		push.receiptStatus.set(delivery!.ticketId!, 'invalid_token')
		// Receipts are read 15 minutes after the send.
		const result = await processOperatorPushReceipts(Date.now() + 20 * 60_000)
		expect(result.removedDevices).toBeGreaterThanOrEqual(1)
		expect(
			await db
				.select()
				.from(OperatorPushDevice)
				.where(eq(OperatorPushDevice.token, token)),
		).toHaveLength(0)
	})
})

describe('quiet hours release (#366)', () => {
	// The sweep reads every held alert, so start from none.
	beforeEach(async () => {
		await db.delete(AlertLog)
	})

	async function heldNotification() {
		const { organization, user } = await org()
		await device(user.id)
		await prefer(user.id, organization.id, 'push.inventory', { push: true })
		await prefer(user.id, organization.id, ALERT_SETTINGS_WORKFLOW, {
			quietStart: '00:00',
			quietEnd: '23:59',
			timeZone: 'UTC',
		})
		const row = await notification(user.id, organization.id)
		await pushStoredNotifications([row])
		const [log] = await db
			.select()
			.from(AlertLog)
			.where(eq(AlertLog.userId, user.id))
		// jobs-cron is asked to wake the App when quiet hours end.
		expect(wake.wakeOperatorAlertsAt).toHaveBeenCalledWith(log!.heldUntil)
		return { organization, user, row, log: log! }
	}

	it('holds the push and keeps the in-app alert, then sends it when quiet hours end', async () => {
		const { organization, user, row, log } = await heldNotification()
		expect(push.sent).toHaveLength(0)
		expect(log.outcome).toBe('held')
		// Quiet hours end: the member turned them off.
		await prefer(user.id, organization.id, ALERT_SETTINGS_WORKFLOW, {
			quietStart: null,
			quietEnd: null,
		})
		const released = await releaseHeldAlerts(log.heldUntil!.getTime() + 1_000)
		expect(released.released).toBeGreaterThanOrEqual(1)
		expect(push.sent).toHaveLength(1)
		expect(push.sent[0]!.data.notificationId).toBe(row.id)
		const [after] = await db
			.select()
			.from(AlertLog)
			.where(eq(AlertLog.id, log.id))
		expect(after!.releasedAt).toBeInstanceOf(Date)
		expect(JSON.parse(after!.channels)).toContain('push')
		// A second sweep sends nothing again.
		await releaseHeldAlerts(log.heldUntil!.getTime() + 2_000)
		expect(push.sent).toHaveLength(1)
	})

	it('sends nothing for an alert the member already saw', async () => {
		const { organization, user, row, log } = await heldNotification()
		await db
			.update(Notification)
			.set({ isRead: true })
			.where(eq(Notification.id, row.id))
		await prefer(user.id, organization.id, ALERT_SETTINGS_WORKFLOW, {
			quietStart: null,
			quietEnd: null,
		})
		const released = await releaseHeldAlerts(log.heldUntil!.getTime() + 1_000)
		expect(released.skipped).toBeGreaterThanOrEqual(1)
		expect(push.sent).toHaveLength(0)
	})

	it('waits again when the member has quiet hours on once more', async () => {
		const { log } = await heldNotification()
		// The earlier end has come, but the window covers now as well.
		const now = Date.now()
		await db
			.update(AlertLog)
			.set({ heldUntil: new Date(now - 1_000) })
			.where(eq(AlertLog.id, log.id))
		const released = await releaseHeldAlerts(now)
		expect(released.deferred).toBeGreaterThanOrEqual(1)
		expect(push.sent).toHaveLength(0)
		const [after] = await db
			.select()
			.from(AlertLog)
			.where(eq(AlertLog.id, log.id))
		expect(after!.releasedAt).toBeNull()
		expect(after!.heldUntil!.getTime()).toBeGreaterThan(now)
	})

	it('drops a held push when the node switch is off, and sends no backlog when it is back on', async () => {
		const { organization, user, log } = await heldNotification()
		await prefer(user.id, organization.id, ALERT_SETTINGS_WORKFLOW, {
			quietStart: null,
			quietEnd: null,
		})
		process.env.OPERATOR_PUSH_ENABLED = 'false'
		const released = await releaseHeldAlerts(log.heldUntil!.getTime() + 1_000)
		expect(released.dropped).toBeGreaterThanOrEqual(1)
		delete process.env.OPERATOR_PUSH_ENABLED
		await releaseHeldAlerts(log.heldUntil!.getTime() + 2_000)
		expect(push.sent).toHaveLength(0)
		const [after] = await db
			.select()
			.from(AlertLog)
			.where(eq(AlertLog.id, log.id))
		expect(after!.outcome).toBe('dropped')
	})
})

describe('ordering paused too long (#131)', () => {
	const HOUR = 3_600_000

	it('alerts once per pause after two hours, and once per busy spell after three', async () => {
		const { organization, user } = await org({ alerts: true })
		const now = Date.now()
		const place = await location(organization.id, {
			orderingPausedAt: new Date(now - 3 * HOUR),
			orderingPausedUntil: null,
		})
		expect(await alertLongOrderingControls(now)).toBeGreaterThan(0)
		const bell = await db
			.select()
			.from(Notification)
			.where(
				and(
					eq(Notification.userId, user.id),
					eq(Notification.type, 'orders-paused-long'),
				),
			)
		expect(bell).toHaveLength(1)
		// The next sweep finds the same pause and says nothing new.
		await alertLongOrderingControls(now + HOUR)
		expect(
			await db
				.select()
				.from(Notification)
				.where(
					and(
						eq(Notification.userId, user.id),
						eq(Notification.type, 'orders-paused-long'),
					),
				),
		).toHaveLength(1)
		// A new pause is a new alert.
		await db
			.update(OrganizationLocation)
			.set({ orderingPausedAt: new Date(now + 2 * HOUR) })
			.where(eq(OrganizationLocation.id, place))
		await alertLongOrderingControls(now + 5 * HOUR)
		expect(
			await db
				.select()
				.from(Notification)
				.where(
					and(
						eq(Notification.userId, user.id),
						eq(Notification.type, 'orders-paused-long'),
					),
				),
		).toHaveLength(2)
	})

	it('says nothing for a pause under two hours, an ended pause, busy mode under three hours, or with the flag off', async () => {
		const { organization, user } = await org({ alerts: true })
		const now = Date.now()
		await location(organization.id, { orderingPausedAt: new Date(now - HOUR) })
		await location(organization.id, {
			orderingPausedAt: new Date(now - 5 * HOUR),
			orderingPausedUntil: new Date(now - HOUR),
		})
		await location(organization.id, {
			busyExtraPrepMinutes: 15,
			busyStartedAt: new Date(now - 2 * HOUR),
		})
		await alertLongOrderingControls(now)
		expect(
			await db
				.select()
				.from(Notification)
				.where(eq(Notification.userId, user.id)),
		).toHaveLength(0)

		const off = await org({ alerts: false })
		await location(off.organization.id, {
			orderingPausedAt: new Date(now - 4 * HOUR),
		})
		await alertLongOrderingControls(now)
		expect(
			await db
				.select()
				.from(Notification)
				.where(eq(Notification.userId, off.user.id)),
		).toHaveLength(0)
	})

	it('alerts for busy mode left on over three hours', async () => {
		const { organization, user } = await org({ alerts: true })
		const now = Date.now()
		await location(organization.id, {
			busyExtraPrepMinutes: 15,
			busyUntil: null,
			busyStartedAt: new Date(now - 4 * HOUR),
		})
		await alertLongOrderingControls(now)
		const rows = await db
			.select()
			.from(Notification)
			.where(
				and(
					eq(Notification.userId, user.id),
					eq(Notification.type, 'orders-paused-long'),
				),
			)
		expect(rows).toHaveLength(1)
		expect(rows[0]!.payload).toContain('"mode":"busy"')
	})

	it('honors ORDERS_ALERTS_ENABLED=false', async () => {
		const { organization, user } = await org({ alerts: true })
		await location(organization.id, {
			orderingPausedAt: new Date(Date.now() - 4 * HOUR),
		})
		process.env.ORDERS_ALERTS_ENABLED = 'false'
		await alertLongOrderingControls()
		expect(
			await db
				.select()
				.from(Notification)
				.where(eq(Notification.userId, user.id)),
		).toHaveLength(0)
	})
})

describe('settings shared by the web and the phone app (#106, #366)', () => {
	it('offers only the categories the member can be told about', async () => {
		const { organization } = await org({ alerts: true })
		const cook = await createTestUser()
		await addOrganizationMember(cook.id, organization.id, 'org_role_member')
		const view = await loadAlertSettings(cook.id, organization.id)
		const categories = view.categories.map((c) => c.category)
		expect(categories).toContain('new_orders')
		expect(categories).toContain('chat_mentions')
		// Tablets need the settings permission.
		expect(categories).not.toContain('station_offline')
		expect(view.categories.find((c) => c.category === 'new_orders')!.push).toBe(
			false,
		)
		expect(
			view.categories.find((c) => c.category === 'payment_review'),
		).toMatchObject({
			push: true,
			locked: true,
		})
	})

	it('defaults new-order push on for a manager and saves a change', async () => {
		const { organization, user } = await org({ alerts: true })
		const before = await loadAlertSettings(user.id, organization.id)
		expect(
			before.categories.find((c) => c.category === 'new_orders')!.push,
		).toBe(true)
		expect(
			await saveAlertSetting(user.id, organization.id, {
				intent: 'push',
				category: 'new_orders',
				enabled: false,
			}),
		).toEqual({ ok: true })
		const after = await loadAlertSettings(user.id, organization.id)
		expect(
			after.categories.find((c) => c.category === 'new_orders')!.push,
		).toBe(false)
	})

	it('refuses a category the member cannot receive, and a half-set quiet window', async () => {
		const { organization } = await org({ alerts: true })
		const cook = await createTestUser()
		await addOrganizationMember(cook.id, organization.id, 'org_role_member')
		expect(
			await saveAlertSetting(cook.id, organization.id, {
				intent: 'push',
				category: 'station_offline',
				enabled: true,
			}),
		).toMatchObject({ ok: false, status: 403 })
		expect(
			await saveAlertSetting(cook.id, organization.id, {
				intent: 'quiet_hours',
				quiet: { quietStart: '22:00', quietEnd: null, timeZone: 'UTC' },
			}),
		).toMatchObject({ ok: false, status: 400 })
	})

	it('saves quiet hours, a one-hour snooze and a threshold, and clears the snooze', async () => {
		const { organization, user } = await org({ alerts: true })
		const now = Date.now()
		await saveAlertSetting(user.id, organization.id, {
			intent: 'quiet_hours',
			quiet: {
				quietStart: '22:00',
				quietEnd: '07:00',
				timeZone: 'Asia/Riyadh',
			},
		})
		await saveAlertSetting(
			user.id,
			organization.id,
			{ intent: 'snooze', option: '1h' },
			now,
		)
		await saveAlertSetting(user.id, organization.id, {
			intent: 'threshold',
			kind: 'orders_new',
			threshold: 3,
		})
		const view = await loadAlertSettings(user.id, organization.id, now)
		expect(view.quiet).toEqual({
			quietStart: '22:00',
			quietEnd: '07:00',
			timeZone: 'Asia/Riyadh',
		})
		expect(view.snoozedUntil).toBe(now + 3_600_000)
		expect(view.thresholds.orders_new).toBe(3)
		await saveAlertSetting(user.id, organization.id, {
			intent: 'snooze',
			option: 'clear',
		})
		expect(
			(await loadAlertSettings(user.id, organization.id, now)).snoozedUntil,
		).toBeNull()
	})

	it('shows each member their own log, and a manager the organization', async () => {
		const { organization, user } = await org({ alerts: true })
		const cook = await createTestUser()
		await addOrganizationMember(cook.id, organization.id, 'org_role_member')
		await db.insert(AlertLog).values([
			{
				organizationId: organization.id,
				userId: user.id,
				kind: 'orders_new',
				entityId: 'a',
				outcome: 'snoozed',
			},
			{
				organizationId: organization.id,
				userId: cook.id,
				kind: 'orders_new',
				entityId: 'a',
				outcome: 'delivered',
			},
		])
		const mine = await loadAlertLog(cook.id, organization.id)
		expect(mine.scope).toBe('mine')
		expect(mine.entries.map((e) => e.outcome)).toEqual(['delivered'])
		const all = await loadAlertLog(user.id, organization.id)
		expect(all.scope).toBe('organization')
		expect(all.entries.map((e) => e.outcome).sort()).toEqual([
			'delivered',
			'snoozed',
		])
	})

	it('keeps one organization from reading or changing another’s settings over the phone API', async () => {
		const mine = await org({ alerts: true })
		const theirs = await org({ alerts: true })
		const tokens = await createTokenPair(mine.user, {})
		const auth = `Bearer ${tokens.accessToken}`
		const read = await preferencesLoader({
			request: new Request(
				`http://localhost:3001/api/push/preferences?organizationId=${theirs.organization.id}`,
				{ headers: { Authorization: auth } },
			),
			params: {},
			context: new RouterContextProvider(),
		} as never)
		expect(read.status).toBe(404)
		const write = await preferencesAction({
			request: new Request('http://localhost:3001/api/push/preferences', {
				method: 'PUT',
				headers: { 'content-type': 'application/json', Authorization: auth },
				body: JSON.stringify({
					organizationId: theirs.organization.id,
					change: { intent: 'snooze', option: '1h' },
				}),
			}),
			params: {},
			context: new RouterContextProvider(),
		} as never)
		expect(write.status).toBe(404)
		const own = await preferencesLoader({
			request: new Request(
				`http://localhost:3001/api/push/preferences?organizationId=${mine.organization.id}`,
				{ headers: { Authorization: auth } },
			),
			params: {},
			context: new RouterContextProvider(),
		} as never)
		expect(own.status).toBe(200)
	})
})
