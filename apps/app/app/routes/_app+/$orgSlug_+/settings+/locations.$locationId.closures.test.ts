import { db, eq, LocationOrderingPause, OrganizationLocation } from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import {
	createAuthenticatedRequest,
	createTestOrganization,
	createTestSession,
	createTestUser,
} from '#tests/test-utils.ts'
import { action } from './locations.$locationId.tsx'

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(),
}))
vi.mock('#app/utils/phone-agent/phone-agent.server.ts', () => ({
	deleteScopeData: vi.fn(),
}))
vi.mock('#app/utils/reservations/regional-internal.server.ts', () => ({
	postRegionalReservationsInternal: vi.fn(),
}))
vi.mock('#app/utils/location/geocoder.server.ts', () => ({
	ensureLocationCoordinates: async (address: unknown) => ({ address }),
}))
vi.mock('@repo/common/feature-flags', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getFeatureFlag: vi.fn(async () => null),
}))

const DAYS = [
	'sunday',
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
]
// Open round the clock, so "the next 36 hours" is always inside the hours.
const allDay = JSON.stringify(
	DAYS.map((day) => ({ day, isOpen: true, slots: [{ start: '00:00', end: '23:59' }] })),
)
const closedWeek = JSON.stringify(
	DAYS.map((day) => ({ day, isOpen: false, slots: [] })),
)

async function setup(storeHours: string | null) {
	const user = await createTestUser()
	const organization = await createTestOrganization(user.id, 'admin')
	const { cookie } = await createTestSession(user.id)
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: organization.id,
			name: 'Olaya Branch',
			slug: `olaya-${crypto.randomUUID().slice(0, 8)}`,
			timezone: 'Asia/Riyadh',
			isActive: true,
			isDefault: true,
			storeHours,
		})
		.returning()
	const url = new URL(
		`http://localhost:3001/${organization.slug}/settings/locations/${location!.id}`,
	)
	const save = (fields: Record<string, string>) =>
		action({
			request: createAuthenticatedRequest(
				url.toString(),
				{
					method: 'POST',
					body: new URLSearchParams({
						name: location!.name,
						slug: location!.slug,
						timezone: 'Asia/Riyadh',
						isActive: 'true',
						isDefault: 'true',
						...fields,
					}),
				},
				cookie,
			),
			params: { orgSlug: organization.slug, locationId: location!.id },
			context: new RouterContextProvider(),
			url,
			pattern: '/:orgSlug/settings/locations/:locationId',
		} as never) as Promise<unknown>
	const closures = () =>
		db
			.select()
			.from(LocationOrderingPause)
			.where(eq(LocationOrderingPause.locationId, location!.id))
	return { save, closures, location: location! }
}

describe('hours edits that take scheduled time away (#405)', () => {
	it('records the lost hours as closures, with the member and the source', async () => {
		const { save, closures } = await setup(allDay)
		await save({ storeHours: closedWeek })
		const rows = await closures()
		expect(rows.length).toBeGreaterThan(0)
		for (const row of rows) {
			expect(row).toMatchObject({
				kind: 'closure',
				source: 'hours_edit',
				endedBy: 'window',
			})
			expect(row.endedAt!.getTime()).toBeGreaterThan(row.startedAt.getTime())
		}
		// All lost time lies within 36 hours from the edit.
		const latest = Math.max(...rows.map((row) => row.endedAt!.getTime()))
		expect(latest).toBeLessThanOrEqual(Date.now() + 36 * 3_600_000 + 5_000)
	})

	it('records nothing for an edit that keeps or widens the hours, or for a location with no hours', async () => {
		const same = await setup(allDay)
		await same.save({ storeHours: allDay })
		expect(await same.closures()).toHaveLength(0)
		const none = await setup(null)
		await none.save({ storeHours: closedWeek })
		expect(await none.closures()).toHaveLength(0)
	})
})
