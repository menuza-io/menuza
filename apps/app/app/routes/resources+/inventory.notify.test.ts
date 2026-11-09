import {
	ConfigFlag,
	db,
	eq,
	inArray,
	Notification,
	NotificationPreference,
	Organization,
	OrganizationLocation,
	OrganizationRole,
	UserOrganization,
	_OrganizationPermissionToRole,
} from '@repo/database'
import type * as EmailModule from '@repo/email'
import { INVENTORY_FLAG_KEYS, type InventoryNotifyEvent } from '@repo/inventory'
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

vi.mock('@repo/email', async (importOriginal) => ({
	...(await importOriginal<typeof EmailModule>()),
	sendEmail: sendEmailMock,
}))

import { INVENTORY_ALERT_MARKER_TYPE } from '#app/utils/inventory/manager-alerts.ts'
import { setMemberLocationScope } from '#app/utils/staffing/restaurant/location-scope.server.ts'
import {
	addOrganizationMember,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action } from './inventory.notify.ts'

const createdFlagIds: string[] = []

async function setFlag(organizationId: string, key: string, value: unknown) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({ key, value, level: 'organization', organizationId })
		.returning({ id: ConfigFlag.id })
	createdFlagIds.push(row!.id)
}

async function turnOn(
	organizationId: string,
	{ purchasing = true, provisioned = true } = {},
) {
	await setFlag(organizationId, INVENTORY_FLAG_KEYS.enabled, true)
	if (purchasing) {
		await setFlag(organizationId, INVENTORY_FLAG_KEYS.purchasing, true)
	}
	await db
		.update(Organization)
		.set({ hasProvisionedDb: provisioned })
		.where(eq(Organization.id, organizationId))
}

async function roleWith(organizationId: string, permissionIds: string[]) {
	const [role] = await db
		.insert(OrganizationRole)
		.values({
			name: `Custom ${crypto.randomUUID().slice(0, 8)}`,
			description: '',
			level: 0,
			organizationId,
		})
		.returning({ id: OrganizationRole.id })
	await db
		.insert(_OrganizationPermissionToRole)
		.values(
			permissionIds.map((permissionId) => ({ A: role!.id, B: permissionId })),
		)
	return role!.id
}

async function memberWith(organizationId: string, permissionIds: string[]) {
	const user = await createTestUser()
	await addOrganizationMember(
		user.id,
		organizationId,
		await roleWith(organizationId, permissionIds),
	)
	return user
}

async function createLocation(organizationId: string, name = 'Downtown') {
	const [row] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId,
			name,
			slug: `loc-${crypto.randomUUID().slice(0, 8)}`,
		})
		.returning({ id: OrganizationLocation.id })
	return row!.id
}

const READ_INVENTORY = 'org_perm_read_inventory_any'
const UPDATE_INVENTORY = 'org_perm_update_inventory_any'
const READ_COST = 'org_perm_read_inventory_cost_any'
const UPDATE_PURCHASING = 'org_perm_update_inventory_purchasing_any'
const READ_RESERVATION = 'org_perm_read_reservation_any'

function eventFor(
	organizationId: string,
	locationId: string,
	patch: Partial<InventoryNotifyEvent> = {},
): InventoryNotifyEvent {
	return {
		orgId: organizationId,
		eventId: crypto.randomUUID().replace(/-/g, ''),
		kind: 'inventory_low_stock',
		locationId,
		count: 3,
		...patch,
	}
}

function call(
	body: unknown,
	options: { authorized?: boolean; method?: string } = {},
) {
	return action({
		request: new Request('http://localhost:3001/resources/inventory/notify', {
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
		unstable_pattern: '/resources/inventory/notify',
	} as never)
}

async function notificationsFor(userId: string) {
	const rows = await db
		.select()
		.from(Notification)
		.where(eq(Notification.userId, userId))
	return rows.filter((row) => row.type !== INVENTORY_ALERT_MARKER_TYPE)
}

async function markersFor(userId: string) {
	const rows = await db
		.select()
		.from(Notification)
		.where(eq(Notification.userId, userId))
	return rows.filter((row) => row.type === INVENTORY_ALERT_MARKER_TYPE)
}

async function prefer(
	userId: string,
	organizationId: string,
	workflow: string,
	channels: { inApp?: boolean; email?: boolean },
) {
	await db
		.insert(NotificationPreference)
		.values({ userId, organizationId, workflow, ...channels })
}

beforeEach(() => {
	sendEmailMock.mockReset().mockResolvedValue({ status: 'success', data: {} })
})

afterEach(async () => {
	if (createdFlagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, createdFlagIds))
		createdFlagIds.length = 0
	}
})

describe('POST /resources/inventory/notify authentication and shape', () => {
	it('answers 401 without the internal token and does nothing', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const response = await call(eventFor(organization.id, location), {
			authorized: false,
		})
		expect(response.status).toBe(401)
		expect(await notificationsFor(user.id)).toHaveLength(0)
		expect(sendEmailMock).not.toHaveBeenCalled()
	})

	it('answers 401, not 400, for an unauthenticated malformed body', async () => {
		expect((await call('not json', { authorized: false })).status).toBe(401)
	})

	it('is a POST route only', async () => {
		expect((await call({}, { method: 'PUT' })).status).toBe(405)
		expect((await call({}, { method: 'DELETE' })).status).toBe(405)
	})

	it.each([
		['an item name', { itemName: 'Chicken thighs' }],
		['an amount', { amountMinor: 18400 }],
		['an unknown kind', { kind: 'inventory_sold_out' }],
		['a zero count', { count: 0 }],
		['a fractional count', { count: 1.5 }],
		['a short event id', { eventId: 'abc' }],
		['an upper-case event id', { eventId: 'ABCDEF0123456789ABCDEF' }],
		['a missing location', { locationId: undefined }],
	])('rejects an event with %s, without echoing it', async (_label, patch) => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const response = await call({
			...eventFor(organization.id, location),
			...patch,
		})
		expect(response.status).toBe(400)
		const text = await response.text()
		expect(text).not.toContain('Chicken')
		expect(text).not.toContain('18400')
		expect(text).not.toContain('inventory_sold_out')
		expect(text).not.toContain('ABCDEF')
	})

	it('rejects a body that is not JSON', async () => {
		expect((await call('nope')).status).toBe(400)
	})

	it('answers 404 for an organization that does not exist or has no regional database', async () => {
		expect(
			(await call(eventFor('clw9x0a12000008l00nobody', 'loc_1'))).status,
		).toBe(404)
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, { provisioned: false })
		const location = await createLocation(organization.id)
		expect((await call(eventFor(organization.id, location))).status).toBe(404)
	})
})

describe('flags', () => {
	it('tells nobody while inventory is off, and says why', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await db
			.update(Organization)
			.set({ hasProvisionedDb: true })
			.where(eq(Organization.id, organization.id))
		const location = await createLocation(organization.id)
		const response = await call(eventFor(organization.id, location))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			inApp: 0,
			emailed: 0,
			skipped: 'feature_off',
		})
		expect(await notificationsFor(user.id)).toHaveLength(0)
		expect(sendEmailMock).not.toHaveBeenCalled()
	})

	it('treats only a literal true as on', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await setFlag(organization.id, INVENTORY_FLAG_KEYS.enabled, 'true')
		await db
			.update(Organization)
			.set({ hasProvisionedDb: true })
			.where(eq(Organization.id, organization.id))
		const location = await createLocation(organization.id)
		const response = await call(eventFor(organization.id, location))
		expect(((await response.json()) as { skipped?: string }).skipped).toBe(
			'feature_off',
		)
		expect(await notificationsFor(user.id)).toHaveLength(0)
	})

	it('needs Purchasing for the kinds about orders and prices only', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, { purchasing: false })
		const location = await createLocation(organization.id)
		for (const kind of ['inventory_delivery_due', 'inventory_price_rise']) {
			const response = await call(
				eventFor(organization.id, location, { kind } as never),
			)
			expect(((await response.json()) as { skipped?: string }).skipped).toBe(
				'feature_off',
			)
		}
		expect(await notificationsFor(user.id)).toHaveLength(0)
		await call(eventFor(organization.id, location))
		await call(
			eventFor(organization.id, location, { kind: 'inventory_count_review' }),
		)
		expect(await notificationsFor(user.id)).toHaveLength(2)
	})
})

describe('who is told', () => {
	it('tells members with any inventory grant, in the app and by email, and nobody else', async () => {
		const { organization, user: admin } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const reader = await memberWith(organization.id, [READ_INVENTORY])
		const editor = await memberWith(organization.id, [UPDATE_INVENTORY])
		const buyer = await memberWith(organization.id, [UPDATE_PURCHASING])
		const outsider = await memberWith(organization.id, [READ_RESERVATION])
		const event = eventFor(organization.id, location)

		const response = await call(event)
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ inApp: 4, emailed: 4 })

		for (const member of [admin, reader, editor, buyer]) {
			const rows = await notificationsFor(member.id)
			expect(rows).toHaveLength(1)
			expect(rows[0]).toMatchObject({
				type: 'inventory-low-stock',
				entityId: event.eventId,
				organizationId: organization.id,
				isRead: false,
			})
		}
		expect(await notificationsFor(outsider.id)).toHaveLength(0)
		expect(sendEmailMock.mock.calls.map(([arg]) => arg.to).sort()).toEqual(
			[admin.email, reader.email, editor.email, buyer.email].sort(),
		)
	})

	it('tells only members with the cost grant about a price rise', async () => {
		const { organization, user: admin } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const reader = await memberWith(organization.id, [READ_INVENTORY])
		const buyer = await memberWith(organization.id, [UPDATE_PURCHASING])
		const costReader = await memberWith(organization.id, [READ_COST])
		const response = await call(
			eventFor(organization.id, location, { kind: 'inventory_price_rise' }),
		)
		expect(await response.json()).toEqual({ inApp: 2, emailed: 2 })
		expect(await notificationsFor(admin.id)).toHaveLength(1)
		expect(await notificationsFor(costReader.id)).toHaveLength(1)
		expect(await notificationsFor(reader.id)).toHaveLength(0)
		expect(await notificationsFor(buyer.id)).toHaveLength(0)
	})

	it('does not tell a deactivated member or one of another organization', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const gone = await memberWith(organization.id, [READ_INVENTORY])
		await db
			.update(UserOrganization)
			.set({ active: false })
			.where(eq(UserOrganization.userId, gone.id))
		const { organization: other, user: otherAdmin } =
			await setupTestOrgWithUser('admin')
		await turnOn(other.id)
		await call(eventFor(organization.id, location))
		expect(await notificationsFor(gone.id)).toHaveLength(0)
		expect(await notificationsFor(otherAdmin.id)).toHaveLength(0)
	})

	it('answers a skipped reason for a location the organization does not have', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		await createLocation(organization.id)
		const { organization: other } = await setupTestOrgWithUser('admin')
		const foreign = await createLocation(other.id)
		const response = await call(eventFor(organization.id, foreign))
		expect(await response.json()).toEqual({
			inApp: 0,
			emailed: 0,
			skipped: 'unknown_location',
		})
		expect(await notificationsFor(user.id)).toHaveLength(0)
	})

	it('answers a skipped reason when nobody is entitled to hear it', async () => {
		const { organization, user } = await setupTestOrgWithUser('viewer')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const response = await call(eventFor(organization.id, location))
		expect(await response.json()).toEqual({
			inApp: 0,
			emailed: 0,
			skipped: 'no_recipients',
		})
		expect(await notificationsFor(user.id)).toHaveLength(0)
		expect(sendEmailMock).not.toHaveBeenCalled()
	})

	it('uses the implicit location `main` of an organization with no locations', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const response = await call(eventFor(organization.id, 'main'))
		expect(await response.json()).toEqual({ inApp: 1, emailed: 1 })
		const [row] = await notificationsFor(user.id)
		expect(JSON.parse(row!.payload)).toEqual({
			kind: 'inventory_low_stock',
			locationId: 'main',
			count: 3,
			orgSlug: organization.slug,
		})
		const other = await call(eventFor(organization.id, 'somewhere'))
		expect(((await other.json()) as { skipped?: string }).skipped).toBe(
			'unknown_location',
		)
	})

	it('does not accept `main` once the organization has real locations', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		await createLocation(organization.id)
		const response = await call(eventFor(organization.id, 'main'))
		expect(((await response.json()) as { skipped?: string }).skipped).toBe(
			'unknown_location',
		)
	})
})

describe('the notification and the email', () => {
	it('writes an in-app notification with only a kind, a location id and a count', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		await call(eventFor(organization.id, location, { count: 4 }))
		const [row] = await notificationsFor(user.id)
		const payload = JSON.parse(row!.payload) as Record<string, unknown>
		expect(Object.keys(payload).sort()).toEqual(
			['count', 'kind', 'locationId', 'orgSlug'].sort(),
		)
		expect(payload).toMatchObject({ count: 4, locationId: location })
	})

	it('names the location when the organization has several, resolving a language map', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		await createLocation(organization.id, 'Uptown')
		const downtown = await createLocation(
			organization.id,
			JSON.stringify({ en: 'Downtown Flagship', ar: 'وسط المدينة' }),
		)
		await call(eventFor(organization.id, downtown, { count: 1 }))
		const [row] = await notificationsFor(user.id)
		const payload = JSON.parse(row!.payload) as { locationName?: string }
		expect(payload.locationName).toBe('Downtown Flagship')
		expect(sendEmailMock.mock.calls[0]![0].subject).toBe(
			'1 item is below the level you order at at Downtown Flagship',
		)
	})

	it('sends an email that names the count and nothing else', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		await call(eventFor(organization.id, location, { count: 3 }))
		expect(sendEmailMock).toHaveBeenCalledTimes(1)
		const [arg] = sendEmailMock.mock.calls[0]!
		expect(arg.to).toBe(user.email)
		expect(arg.subject).toBe('3 items are below the level you order at')
		expect(JSON.stringify(arg.react.props)).toContain('/inventory/stock?low=1')
	})
})

describe('location scope', () => {
	it('never tells a member whose location scope excludes the location', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const a = await createLocation(organization.id, 'A')
		const b = await createLocation(organization.id, 'B')
		const scoped = await memberWith(organization.id, [READ_INVENTORY])
		await setMemberLocationScope({
			organizationId: organization.id,
			userId: scoped.id,
			value: { scope: 'selected', locationIds: [a] },
		})
		await call(eventFor(organization.id, b))
		expect(await notificationsFor(scoped.id)).toHaveLength(0)
		await call(eventFor(organization.id, a))
		expect(await notificationsFor(scoped.id)).toHaveLength(1)
	})
})

describe('notification preferences', () => {
	it('honours an email-off and an in-app-off choice independently', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const quiet = await memberWith(organization.id, [READ_INVENTORY])
		const mailOnly = await memberWith(organization.id, [READ_INVENTORY])
		await prefer(quiet.id, organization.id, 'inventory.low_stock', {
			inApp: false,
			email: false,
		})
		await prefer(mailOnly.id, organization.id, 'inventory.low_stock', {
			inApp: false,
			email: true,
		})
		await prefer(user.id, organization.id, 'inventory.low_stock', {
			inApp: true,
			email: false,
		})
		const response = await call(eventFor(organization.id, location))
		expect(await response.json()).toEqual({ inApp: 1, emailed: 1 })
		expect(await notificationsFor(quiet.id)).toHaveLength(0)
		expect(await notificationsFor(mailOnly.id)).toHaveLength(0)
		expect(await notificationsFor(user.id)).toHaveLength(1)
		expect(sendEmailMock.mock.calls.map(([a]) => a.to)).toEqual([
			mailOnly.email,
		])
	})

	it('keeps the preference of each kind separate', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		await prefer(user.id, organization.id, 'inventory.count_review', {
			inApp: false,
			email: false,
		})
		await call(
			eventFor(organization.id, location, { kind: 'inventory_count_review' }),
		)
		expect(await notificationsFor(user.id)).toHaveLength(0)
		await call(eventFor(organization.id, location))
		expect(await notificationsFor(user.id)).toHaveLength(1)
	})

	it('survives a mail provider that fails or throws', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const second = await memberWith(organization.id, [READ_INVENTORY])
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
		sendEmailMock
			.mockResolvedValueOnce({ status: 'error', error: {} })
			.mockRejectedValueOnce(new Error('boom'))
		const response = await call(eventFor(organization.id, location))
		expect(await response.json()).toEqual({ inApp: 2, emailed: 0 })
		expect(await notificationsFor(user.id)).toHaveLength(1)
		expect(await notificationsFor(second.id)).toHaveLength(1)
		expect(JSON.stringify(consoleError.mock.calls)).not.toContain('@')
		consoleError.mockRestore()
	})
})

describe('idempotency', () => {
	it('repeats neither the notification nor the email when an event is delivered twice', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const event = eventFor(organization.id, location)
		await call(event)
		const second = await call(event)
		expect(await second.json()).toEqual({ inApp: 0, emailed: 0 })
		expect(await notificationsFor(user.id)).toHaveLength(1)
		expect(sendEmailMock).toHaveBeenCalledTimes(1)
	})

	it('does not email an email-only member twice', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		await prefer(user.id, organization.id, 'inventory.low_stock', {
			inApp: false,
			email: true,
		})
		const event = eventFor(organization.id, location)
		await call(event)
		await call(event)
		expect(sendEmailMock).toHaveBeenCalledTimes(1)
		expect(await notificationsFor(user.id)).toHaveLength(0)
		const markers = await markersFor(user.id)
		expect(markers).toHaveLength(1)
		expect(markers[0]).toMatchObject({ isRead: true, isSeen: true })
	})

	it('completes the members a half-finished delivery missed', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const event = eventFor(organization.id, location)
		await call(event)
		const late = await memberWith(organization.id, [READ_INVENTORY])
		const response = await call(event)
		expect(await response.json()).toEqual({ inApp: 1, emailed: 1 })
		expect(await notificationsFor(user.id)).toHaveLength(1)
		expect(await notificationsFor(late.id)).toHaveLength(1)
	})

	it('treats different events as different notifications', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		await call(eventFor(organization.id, location))
		await call(eventFor(organization.id, location))
		expect(await notificationsFor(user.id)).toHaveLength(2)
	})
})
