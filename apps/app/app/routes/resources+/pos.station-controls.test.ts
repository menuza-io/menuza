import {
	db,
	eq,
	Organization,
	OrganizationLocation,
	OrganizationMenuItem,
	OrganizationMenuOption,
} from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { describe, expect, it, vi } from 'vitest'

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

import { action } from './pos.station-controls.ts'

const ACTOR = { deviceId: 'dev-1', staffId: 'staff-1' }

async function provisioned(organizationId: string) {
	await db
		.update(Organization)
		.set({ hasProvisionedDb: true })
		.where(eq(Organization.id, organizationId))
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

async function menuItem(organizationId: string) {
	const [row] = await db
		.insert(OrganizationMenuItem)
		.values({ organizationId, displayName: 'Shawarma' })
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

function call(body: unknown, options: { authorized?: boolean } = {}) {
	return action({
		request: new Request(
			'http://localhost:3001/resources/pos/station-controls',
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					...(options.authorized === false
						? {}
						: { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` }),
				},
				body: JSON.stringify(body),
			},
		),
		params: {},
		context: new RouterContextProvider(),
		unstable_pattern: '/resources/pos/station-controls',
	} as never)
}

async function overrideOf(locationId: string, entityId: string) {
	return db.query.OrganizationMenuLocationOverride.findFirst({
		where: (table, { and, eq: same }) =>
			and(same(table.locationId, locationId), same(table.entityId, entityId)),
	})
}

async function pauseOf(locationId: string) {
	const [row] = await db
		.select({
			at: OrganizationLocation.orderingPausedAt,
			until: OrganizationLocation.orderingPausedUntil,
		})
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.id, locationId))
	return row!
}

describe('POST /resources/pos/station-controls', () => {
	it('answers 401 without the internal token and changes nothing', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await provisioned(organization.id)
		const here = await location(organization.id)
		const response = await call(
			{
				kind: 'pause',
				orgId: organization.id,
				locationId: here,
				duration: '15m',
				actor: ACTOR,
			},
			{ authorized: false },
		)
		expect(response.status).toBe(401)
		expect((await pauseOf(here)).at).toBeNull()
	})

	it('refuses a body with names in it, and a location of another organization', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await provisioned(organization.id)
		const here = await location(organization.id)
		const named = await call({
			kind: 'state',
			orgId: organization.id,
			locationId: here,
			staffName: 'Mona',
		})
		expect(named.status).toBe(400)
		const { organization: other } = await setupTestOrgWithUser('admin')
		const theirs = await location(other.id)
		const response = await call({
			kind: 'pause',
			orgId: organization.id,
			locationId: theirs,
			duration: '15m',
			actor: ACTOR,
		})
		expect(response.status).toBe(404)
		expect((await pauseOf(theirs)).at).toBeNull()
	})

	it('pauses one location with the App’s preset math and resumes it', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await provisioned(organization.id)
		const here = await location(organization.id)
		const elsewhere = await location(organization.id)
		const before = Date.now()
		const paused = await call({
			kind: 'pause',
			orgId: organization.id,
			locationId: here,
			duration: '30m',
			actor: ACTOR,
		})
		expect(paused.status).toBe(200)
		const body = (await paused.json()) as {
			pause: { pausedAt: number; until: number }
		}
		expect(body.pause.until - body.pause.pausedAt).toBe(30 * 60_000)
		expect(body.pause.pausedAt).toBeGreaterThanOrEqual(before)
		expect((await pauseOf(here)).at).not.toBeNull()
		expect((await pauseOf(elsewhere)).at).toBeNull()

		const state = await call({
			kind: 'state',
			orgId: organization.id,
			locationId: here,
		})
		expect(await state.json()).toEqual({ pause: body.pause })

		const resumed = await call({
			kind: 'resume',
			orgId: organization.id,
			locationId: here,
			actor: ACTOR,
		})
		expect(await resumed.json()).toEqual({ pause: null })
		expect((await pauseOf(here)).at).toBeNull()
	})

	it('marks a dish and an option sold out at one location by hand, and brings them back', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await provisioned(organization.id)
		const here = await location(organization.id)
		const elsewhere = await location(organization.id)
		const item = await menuItem(organization.id)
		const option = await menuOption(organization.id)
		const set = (
			entityType: 'item' | 'modifier_option',
			entityId: string,
			available: boolean,
		) =>
			call({
				kind: 'availability',
				orgId: organization.id,
				locationId: here,
				entityType,
				entityId,
				available,
				actor: ACTOR,
			}).then((response) => response.json())

		expect(await set('item', item.id, false)).toMatchObject({ changed: true })
		expect(await set('modifier_option', option.id, false)).toMatchObject({
			changed: true,
		})
		expect((await overrideOf(here, item.id))?.availabilityStatus).toBe(
			'unavailable',
		)
		expect(await overrideOf(elsewhere, item.id)).toBeUndefined()
		const [dish] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, item.id))
		expect(dish?.availabilityStatus).toBe('available')
		// Again: already off, nothing changes.
		expect(await set('item', item.id, false)).toMatchObject({ changed: false })

		expect(await set('item', item.id, true)).toMatchObject({ changed: true })
		expect(await overrideOf(here, item.id)).toBeUndefined()
		expect(await set('item', item.id, true)).toMatchObject({ changed: false })
	})

	it('never touches a dish of another organization', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await provisioned(organization.id)
		const here = await location(organization.id)
		const { organization: other } = await setupTestOrgWithUser('admin')
		const theirs = await menuItem(other.id)
		const response = await call({
			kind: 'availability',
			orgId: organization.id,
			locationId: here,
			entityType: 'item',
			entityId: theirs.id,
			available: false,
			actor: ACTOR,
		})
		expect(await response.json()).toMatchObject({ changed: false })
		expect(await overrideOf(here, theirs.id)).toBeUndefined()
	})
})
