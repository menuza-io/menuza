import { ConfigFlag, db, inArray } from '@repo/database'
import {
	RESERVATIONS_FLAG_KEYS,
	RESERVATIONS_PERMISSIONS,
} from '@repo/reservations'
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

import { loader as indexLoader } from '#app/routes/_app+/$orgSlug_+/reservations+/_index.tsx'
import { loader as layoutLoader } from '#app/routes/_app+/$orgSlug_+/reservations+/_layout.tsx'
import { loader as bookLoader } from '#app/routes/_app+/$orgSlug_+/reservations+/book.tsx'
import { loader as experiencesLoader } from '#app/routes/_app+/$orgSlug_+/reservations+/experiences.tsx'
import { loader as guestsLoader } from '#app/routes/_app+/$orgSlug_+/reservations+/guests.tsx'
import { loader as reportsLoader } from '#app/routes/_app+/$orgSlug_+/reservations+/reports.tsx'
import { loader as settingsLoader } from '#app/routes/_app+/$orgSlug_+/reservations+/settings.tsx'
import { loader as todayLoader } from '#app/routes/_app+/$orgSlug_+/reservations+/today.tsx'
import { loader as waitlistLoader } from '#app/routes/_app+/$orgSlug_+/reservations+/waitlist.tsx'
import {
	createAuthenticatedRequest,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { getReservationsNavAccess } from './access.server.ts'
import {
	computeReservationsNavAccess,
	firstVisibleReservationsPath,
	HIDDEN_RESERVATIONS_NAV,
} from './nav.ts'

const flagIds: string[] = []

afterEach(async () => {
	if (flagIds.length > 0) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds.splice(0)))
	}
})

describe('Reservations navigation and route gating (VAL-FND-021, VAL-FND-022)', () => {
	it('hides Reservations in sidebar and returns 404 on every Reservations route when reservations.enabled is false (VAL-FND-021)', async () => {
		const { organization, user, cookie } = await setupTestOrgWithUser('admin')

		const nav = await getReservationsNavAccess(user.id, organization.id)
		expect(nav).toEqual(HIDDEN_RESERVATIONS_NAV)

		const loaders = [
			{ path: '', fn: layoutLoader },
			{ path: '', fn: indexLoader },
			{ path: '/today', fn: todayLoader },
			{ path: '/book', fn: bookLoader },
			{ path: '/waitlist', fn: waitlistLoader },
			{ path: '/guests', fn: guestsLoader },
			{ path: '/experiences', fn: experiencesLoader },
			{ path: '/reports', fn: reportsLoader },
			{ path: '/settings', fn: settingsLoader },
		]

		for (const entry of loaders) {
			const req = createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/reservations${entry.path}`,
				{},
				cookie,
			)
			await expect(
				entry.fn({
					request: req,
					params: { orgSlug: organization.slug },
					context: {},
				} as never),
			).rejects.toSatisfy(
				(err: unknown) => err instanceof Response && err.status === 404,
			)
		}
	})

	it('computes visible sections from sub-flags and permissions and redirects /reservations to /today (VAL-FND-022)', async () => {
		const { organization, user, cookie } = await setupTestOrgWithUser('admin')

		const inserted = await db
			.insert(ConfigFlag)
			.values([
				{
					key: RESERVATIONS_FLAG_KEYS.enabled,
					value: true,
					level: 'organization',
					organizationId: organization.id,
				},
				{
					key: RESERVATIONS_FLAG_KEYS.waitlist,
					value: true,
					level: 'organization',
					organizationId: organization.id,
				},
			])
			.returning({ id: ConfigFlag.id })
		flagIds.push(...inserted.map((f) => f.id))

		const nav = await getReservationsNavAccess(user.id, organization.id)
		expect(nav).toEqual({
			visible: true,
			today: true,
			book: true,
			waitlist: true,
			guests: true,
			experiences: false,
			reports: true,
			settings: true,
		})

		// Direct navigation to /<orgSlug>/reservations redirects to /<orgSlug>/reservations/today
		const indexRes = await indexLoader({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/reservations`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: {},
		} as never)
		expect(indexRes.status).toBe(302)
		expect(indexRes.headers.get('Location')).toBe(
			`/${organization.slug}/reservations/today`,
		)

		// The old Reports screen is a redirect to the generic Reports page on the
		// Reservations category, keeping the location and the language.
		const reportsRes = await reportsLoader({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/reservations/reports?locationId=loc_1&lng=ar`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: {},
		} as never).then(
			() => null,
			(thrown: unknown) => thrown as Response,
		)
		expect(reportsRes?.status).toBe(302)
		expect(reportsRes?.headers.get('Location')).toBe(
			`/${organization.slug}/reports?category=Reservations&location=loc_1&lng=ar`,
		)

		// Layout loader succeeds and provides orgSlug, locations, nav, todayDate
		const layoutData = await layoutLoader({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/reservations/today`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: {},
		} as never)
		expect(layoutData.orgSlug).toBe(organization.slug)
		expect(layoutData.nav.visible).toBe(true)

		// Experiences is still 404 because reservations.experiences is false
		await expect(
			experiencesLoader({
				request: createAuthenticatedRequest(
					`http://localhost:3000/${organization.slug}/reservations/experiences`,
					{},
					cookie,
				),
				params: { orgSlug: organization.slug },
				context: {},
			} as never),
		).rejects.toSatisfy(
			(err: unknown) => err instanceof Response && err.status === 404,
		)
	})

	it('lands on the first visible section when a role only holds settings or reports access', () => {
		const settingsOnlyInput = {
			enabled: true,
			features: {
				enabled: true,
				online: false,
				waitlist: false,
				payments: false,
				experiences: false,
				voice: false,
			},
			grants: [RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS],
		}
		expect(computeReservationsNavAccess(settingsOnlyInput)).toEqual({
			visible: true,
			today: false,
			book: false,
			waitlist: false,
			guests: false,
			experiences: false,
			reports: false,
			settings: true,
		})
		expect(firstVisibleReservationsPath('acme', settingsOnlyInput)).toBe(
			'/acme/reservations/settings',
		)
	})
})
