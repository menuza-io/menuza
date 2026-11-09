import {
	ConfigFlag,
	db,
	eq,
	inArray,
	Organization,
	OrganizationLocation,
	OrganizationMenuItem,
	OrganizationMenuLocationOverride,
	OrganizationMenuOption,
} from '@repo/database'
import {
	INVENTORY_FLAG_KEYS,
	type InventoryAvailabilityRequest,
} from '@repo/inventory'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setupTestOrgWithUser } from '#tests/test-utils.ts'

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

import { action } from './inventory.availability.ts'

const createdFlagIds: string[] = []

async function setFlag(organizationId: string, key: string, value: unknown) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({ key, value, level: 'organization', organizationId })
		.returning({ id: ConfigFlag.id })
	createdFlagIds.push(row!.id)
}

async function turnOn(organizationId: string, { recipes = true } = {}) {
	await setFlag(organizationId, INVENTORY_FLAG_KEYS.enabled, true)
	if (recipes) await setFlag(organizationId, INVENTORY_FLAG_KEYS.recipes, true)
	await db
		.update(Organization)
		.set({ hasProvisionedDb: true })
		.where(eq(Organization.id, organizationId))
}

async function menuItem(organizationId: string, patch: object = {}) {
	const [row] = await db
		.insert(OrganizationMenuItem)
		.values({ organizationId, displayName: 'Shawarma', ...patch })
		.returning()
	return row!
}

async function menuOption(organizationId: string) {
	const [row] = await db
		.insert(OrganizationMenuOption)
		.values({ organizationId, displayName: 'Extra cheese' })
		.returning()
	return row!
}

async function location(organizationId: string) {
	const [row] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId,
			name: 'Downtown',
			slug: `loc-${crypto.randomUUID().slice(0, 8)}`,
		})
		.returning({ id: OrganizationLocation.id })
	return row!.id
}

function call(
	body: unknown,
	options: { authorized?: boolean; method?: string } = {},
) {
	return action({
		request: new Request(
			'http://localhost:3001/resources/inventory/availability',
			{
				method: options.method ?? 'POST',
				headers: {
					'content-type': 'application/json',
					...(options.authorized === false
						? {}
						: { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` }),
				},
				body:
					options.method === 'GET'
						? undefined
						: typeof body === 'string'
							? body
							: JSON.stringify(body),
			},
		),
		params: {},
		context: new RouterContextProvider(),
		unstable_pattern: '/resources/inventory/availability',
	} as never)
}

const request = (
	orgId: string,
	locationId: string,
	changes: InventoryAvailabilityRequest['changes'],
): InventoryAvailabilityRequest => ({ orgId, locationId, changes })

async function overrideOf(locationId: string, entityId: string) {
	return db.query.OrganizationMenuLocationOverride.findFirst({
		where: (table, { and, eq: same }) =>
			and(same(table.locationId, locationId), same(table.entityId, entityId)),
	})
}

afterEach(async () => {
	if (createdFlagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, createdFlagIds))
		createdFlagIds.length = 0
	}
})

describe('POST /resources/inventory/availability authentication and shape', () => {
	it('answers 401 without the internal token and changes nothing', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const item = await menuItem(organization.id)
		const response = await call(
			request(organization.id, 'main', [
				{ entityType: 'item', entityId: item.id, available: false },
			]),
			{ authorized: false },
		)
		expect(response.status).toBe(401)
		const [after] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, item.id))
		expect(after?.availabilityStatus).toBe('available')
	})

	it('is a POST route only and refuses a body with extra fields', async () => {
		expect((await call({}, { method: 'GET' })).status).toBe(405)
		const { organization } = await setupTestOrgWithUser('admin')
		const response = await call({
			...request(organization.id, 'main', [
				{ entityType: 'item', entityId: 'x', available: false },
			]),
			name: 'Shawarma',
		})
		expect(response.status).toBe(400)
	})

	it('answers 404 for an organization it does not know', async () => {
		const response = await call(
			request('org_unknown_zzz', 'main', [
				{ entityType: 'item', entityId: 'x', available: false },
			]),
		)
		expect(response.status).toBe(404)
	})
})

describe('an organization with locations', () => {
	it('takes a dish off at one location through its override, and gives it back', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const downtown = await location(organization.id)
		const other = await location(organization.id)
		const item = await menuItem(organization.id)
		const option = await menuOption(organization.id)

		const off = await call(
			request(organization.id, downtown, [
				{ entityType: 'item', entityId: item.id, available: false },
				{
					entityType: 'modifier_option',
					entityId: option.id,
					available: false,
				},
			]),
		)
		expect(await off.json()).toEqual({ applied: [item.id, option.id] })
		expect((await overrideOf(downtown, item.id))?.availabilityStatus).toBe(
			'unavailable',
		)
		// The other location and the dish itself are untouched.
		expect(await overrideOf(other, item.id)).toBeUndefined()
		const [stored] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, item.id))
		expect(stored?.availabilityStatus).toBe('available')

		const back = await call(
			request(organization.id, downtown, [
				{
					entityType: 'item',
					entityId: item.id,
					available: true,
					since: Date.now(),
				},
			]),
		)
		expect(await back.json()).toEqual({ applied: [item.id] })
		// The override held nothing else, so it is gone.
		expect(await overrideOf(downtown, item.id)).toBeUndefined()
	})

	it('never overrules what a person set by hand, in either direction', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const downtown = await location(organization.id)
		const item = await menuItem(organization.id)
		await db.insert(OrganizationMenuLocationOverride).values({
			organizationId: organization.id,
			locationId: downtown,
			entityType: 'item',
			entityId: item.id,
			availabilityStatus: 'hidden',
		})
		const off = await call(
			request(organization.id, downtown, [
				{ entityType: 'item', entityId: item.id, available: false },
			]),
		)
		expect(await off.json()).toEqual({ applied: [] })
		expect((await overrideOf(downtown, item.id))?.availabilityStatus).toBe(
			'hidden',
		)

		// Unavailable by hand long after the region's moment: not given back.
		await db
			.update(OrganizationMenuLocationOverride)
			.set({ availabilityStatus: 'unavailable' })
			.where(eq(OrganizationMenuLocationOverride.locationId, downtown))
		const back = await call(
			request(organization.id, downtown, [
				{
					entityType: 'item',
					entityId: item.id,
					available: true,
					since: Date.now() - 10 * 60_000,
				},
			]),
		)
		expect(await back.json()).toEqual({ applied: [] })
		expect((await overrideOf(downtown, item.id))?.availabilityStatus).toBe(
			'unavailable',
		)
	})

	it('keeps the rest of an override that has a price when the dish comes back', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const downtown = await location(organization.id)
		const item = await menuItem(organization.id)
		await db.insert(OrganizationMenuLocationOverride).values({
			organizationId: organization.id,
			locationId: downtown,
			entityType: 'item',
			entityId: item.id,
			price: 12,
			availabilityStatus: 'unavailable',
		})
		const back = await call(
			request(organization.id, downtown, [
				{ entityType: 'item', entityId: item.id, available: true },
			]),
		)
		expect(await back.json()).toEqual({ applied: [item.id] })
		expect(await overrideOf(downtown, item.id)).toMatchObject({
			price: 12,
			availabilityStatus: null,
		})
	})

	it('ignores another organization menu and an unknown location', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const { organization: other } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const downtown = await location(organization.id)
		const foreign = await menuItem(other.id)
		const response = await call(
			request(organization.id, downtown, [
				{ entityType: 'item', entityId: foreign.id, available: false },
			]),
		)
		expect(await response.json()).toEqual({ applied: [] })
		expect(await overrideOf(downtown, foreign.id)).toBeUndefined()

		const unknown = await call(
			request(organization.id, 'loc_nope', [
				{ entityType: 'item', entityId: foreign.id, available: false },
			]),
		)
		expect(await unknown.json()).toEqual({
			applied: [],
			skipped: 'unknown_location',
		})
	})
})

describe('flags and an organization without locations', () => {
	it('takes nothing off while recipes are off, but still gives back', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id, { recipes: false })
		const downtown = await location(organization.id)
		const item = await menuItem(organization.id)
		const off = await call(
			request(organization.id, downtown, [
				{ entityType: 'item', entityId: item.id, available: false },
			]),
		)
		expect(await off.json()).toEqual({ applied: [] })

		await db.insert(OrganizationMenuLocationOverride).values({
			organizationId: organization.id,
			locationId: downtown,
			entityType: 'item',
			entityId: item.id,
			availabilityStatus: 'unavailable',
		})
		const back = await call(
			request(organization.id, downtown, [
				{ entityType: 'item', entityId: item.id, available: true },
			]),
		)
		expect(await back.json()).toEqual({ applied: [item.id] })
	})

	it('uses the dish itself when there are no locations, and only for the implicit location', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await turnOn(organization.id)
		const item = await menuItem(organization.id)
		const wrong = await call(
			request(organization.id, 'somewhere', [
				{ entityType: 'item', entityId: item.id, available: false },
			]),
		)
		expect(await wrong.json()).toEqual({
			applied: [],
			skipped: 'unknown_location',
		})

		const off = await call(
			request(organization.id, 'main', [
				{ entityType: 'item', entityId: item.id, available: false },
			]),
		)
		expect(await off.json()).toEqual({ applied: [item.id] })
		const status = async () =>
			(
				await db
					.select()
					.from(OrganizationMenuItem)
					.where(eq(OrganizationMenuItem.id, item.id))
			)[0]?.availabilityStatus
		expect(await status()).toBe('unavailable')

		// Already unavailable: nothing to change.
		const again = await call(
			request(organization.id, 'main', [
				{ entityType: 'item', entityId: item.id, available: false },
			]),
		)
		expect(await again.json()).toEqual({ applied: [] })

		const back = await call(
			request(organization.id, 'main', [
				{
					entityType: 'item',
					entityId: item.id,
					available: true,
					since: Date.now(),
				},
			]),
		)
		expect(await back.json()).toEqual({ applied: [item.id] })
		expect(await status()).toBe('available')
	})
})
