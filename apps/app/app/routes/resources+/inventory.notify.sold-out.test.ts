import {
	AlertLog,
	ConfigFlag,
	db,
	eq,
	inArray,
	Notification,
	NotificationPreference,
	Organization,
	OrganizationLocation,
	OrganizationMenuItem,
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

import { ALERT_SETTINGS_WORKFLOW } from '@repo/common/operator-alerts'
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

async function turnOn(organizationId: string, recipes = true) {
	await setFlag(organizationId, INVENTORY_FLAG_KEYS.enabled, true)
	if (recipes) await setFlag(organizationId, INVENTORY_FLAG_KEYS.recipes, true)
	await db
		.update(Organization)
		.set({ hasProvisionedDb: true })
		.where(eq(Organization.id, organizationId))
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

async function dish(organizationId: string, name: string) {
	const [row] = await db
		.insert(OrganizationMenuItem)
		.values({ organizationId, displayName: name, price: 12 })
		.returning({ id: OrganizationMenuItem.id })
	return row!.id
}

function eventFor(
	organizationId: string,
	locationId: string,
	patch: Partial<InventoryNotifyEvent>,
): InventoryNotifyEvent {
	return {
		orgId: organizationId,
		eventId: crypto.randomUUID().replace(/-/g, ''),
		kind: 'inventory_sold_out',
		locationId,
		count: 1,
		...patch,
	}
}

function call(body: unknown) {
	return action({
		request: new Request('http://localhost:3001/resources/inventory/notify', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}`,
			},
			body: JSON.stringify(body),
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

beforeEach(() => {
	sendEmailMock.mockReset().mockResolvedValue({ status: 'success', data: {} })
})

afterEach(async () => {
	if (createdFlagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, createdFlagIds))
		createdFlagIds.length = 0
	}
})

describe('POST /resources/inventory/notify: dishes off the menu by stock (#478)', () => {
	async function setup() {
		const { organization, user } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const location = await createLocation(organization.id)
		const burger = await dish(organization.id, 'Burger')
		const wrap = await dish(organization.id, 'Wrap')
		return { organization, user, location, burger, wrap }
	}

	it('tells managers once, in one alert with every dish and the ingredient', async () => {
		const { organization, user, location, burger, wrap } = await setup()
		const response = await call(
			eventFor(organization.id, location, {
				count: 2,
				soldOut: [
					{
						entityType: 'item',
						entityId: burger,
						ingredientId: 'i1',
						ingredientName: 'Chicken',
					},
					{
						entityType: 'item',
						entityId: wrap,
						ingredientId: 'i1',
						ingredientName: 'Chicken',
					},
				],
			}),
		)
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({ inApp: 1, emailed: 1 })
		const rows = await notificationsFor(user.id)
		expect(rows).toHaveLength(1)
		expect(rows[0]!.type).toBe('inventory-sold-out')
		const payload = JSON.parse(rows[0]!.payload) as Record<string, unknown>
		expect(payload).toMatchObject({
			kind: 'inventory_sold_out',
			count: 2,
			locationId: location,
			soldOut: [
				{ dish: 'Burger', ingredient: 'Chicken' },
				{ dish: 'Wrap', ingredient: 'Chicken' },
			],
		})
		// Dish and ingredient names, a count and a place: nothing about a guest.
		expect(Object.keys(payload).sort()).toEqual(
			[
				'count',
				'kind',
				'locationId',
				'orgSlug',
				'soldOut',
			].sort(),
		)
		expect(sendEmailMock).toHaveBeenCalledTimes(1)
		const mail = JSON.stringify(sendEmailMock.mock.calls[0]![0].subject)
		expect(mail).toContain('Burger')
		expect(mail).toContain('Wrap')
	})

	it('sends the same alert only once (a retried event)', async () => {
		const { organization, user, location, burger } = await setup()
		const event = eventFor(organization.id, location, {
			soldOut: [
				{
					entityType: 'item',
					entityId: burger,
					ingredientId: 'i1',
					ingredientName: 'Chicken',
				},
			],
		})
		await call(event)
		const again = await call(event)
		expect(await again.json()).toMatchObject({ inApp: 0, emailed: 0 })
		expect(await notificationsFor(user.id)).toHaveLength(1)
		expect(sendEmailMock).toHaveBeenCalledTimes(1)
	})

	it('sends a second alert when the dish comes back', async () => {
		const { organization, user, location, burger } = await setup()
		const entry = {
			entityType: 'item' as const,
			entityId: burger,
			ingredientId: 'i1',
			ingredientName: 'Chicken',
		}
		await call(eventFor(organization.id, location, { soldOut: [entry] }))
		await call(
			eventFor(organization.id, location, {
				kind: 'inventory_sold_out_back',
				soldOut: [entry],
			}),
		)
		const rows = await notificationsFor(user.id)
		expect(rows.map((row) => row.type).sort()).toEqual([
			'inventory-sold-out',
			'inventory-sold-out-back',
		])
		expect(sendEmailMock).toHaveBeenCalledTimes(2)
		expect(JSON.stringify(sendEmailMock.mock.calls[1]![0].subject)).toContain(
			'back on the menu',
		)
	})

	it('holds the email through quiet hours but keeps the in-app alert, and logs it', async () => {
		const { organization, user, location, burger } = await setup()
		await db.insert(NotificationPreference).values({
			userId: user.id,
			organizationId: organization.id,
			workflow: ALERT_SETTINGS_WORKFLOW,
			quietStart: '00:00',
			quietEnd: '23:59',
			timeZone: 'UTC',
		})
		const response = await call(
			eventFor(organization.id, location, {
				soldOut: [
					{
						entityType: 'item',
						entityId: burger,
						ingredientId: 'i1',
						ingredientName: 'Chicken',
					},
				],
			}),
		)
		expect(await response.json()).toMatchObject({ inApp: 1, emailed: 0 })
		expect(sendEmailMock).not.toHaveBeenCalled()
		expect(await notificationsFor(user.id)).toHaveLength(1)
		const [log] = await db
			.select()
			.from(AlertLog)
			.where(eq(AlertLog.userId, user.id))
		expect(log).toMatchObject({ outcome: 'held', critical: false })
		expect(JSON.parse(log!.heldChannels ?? '[]')).toEqual(['email'])
	})

	it('skips when recipes are off, when no dish is on the menu any more, and for a stranger organization', async () => {
		const { organization, user, location } = await setup()
		const unknown = await call(
			eventFor(organization.id, location, {
				soldOut: [
					{
						entityType: 'item',
						entityId: 'gone',
						ingredientId: 'i1',
						ingredientName: 'Chicken',
					},
				],
			}),
		)
		expect(await unknown.json()).toMatchObject({ skipped: 'no_dishes' })
		expect(await notificationsFor(user.id)).toHaveLength(0)

		const off = await setupTestOrgWithUser('admin')
		await turnOn(off.organization.id, false)
		const offLocation = await createLocation(off.organization.id)
		const burger = await dish(off.organization.id, 'Burger')
		const skipped = await call(
			eventFor(off.organization.id, offLocation, {
				soldOut: [
					{
						entityType: 'item',
						entityId: burger,
						ingredientId: 'i1',
						ingredientName: 'Chicken',
					},
				],
			}),
		)
		expect(await skipped.json()).toMatchObject({ skipped: 'feature_off' })
		expect(await notificationsFor(off.user.id)).toHaveLength(0)
	})

	it('refuses an event carrying a field that could name a guest', async () => {
		const { organization, location, burger } = await setup()
		const response = await call({
			...eventFor(organization.id, location, {
				soldOut: [
					{
						entityType: 'item',
						entityId: burger,
						ingredientId: 'i1',
						ingredientName: 'Chicken',
					},
				],
			}),
			guestName: 'Sara',
		})
		expect(response.status).toBe(400)
		expect(await response.text()).not.toContain('Sara')
	})
})
