import { db, eq, OrganizationLocation } from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createAuthenticatedRequest,
	createTestOrganization,
	createTestSession,
	createTestUser,
} from '#tests/test-utils.ts'
import { action, loader } from './locations.$locationId.tsx'

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

const days = [
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
	'sunday',
]
const week = (mondayEnd: string) =>
	JSON.stringify(
		days.map((day) => ({
			day,
			isOpen: true,
			slots: [{ start: '10:00', end: day === 'monday' ? mondayEnd : '22:00' }],
		})),
	)

async function setup(role: 'admin' | 'viewer' = 'admin') {
	const user = await createTestUser()
	const organization = await createTestOrganization(user.id, role)
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
			storeHours: week('12:00'),
		})
		.returning()
	const url = new URL(
		`http://localhost:3001/${organization.slug}/settings/locations/${location!.id}`,
	)
	const args = (init?: RequestInit) => ({
		request: createAuthenticatedRequest(url.toString(), init ?? {}, cookie),
		params: { orgSlug: organization.slug, locationId: location!.id },
		context: new RouterContextProvider(),
		url,
		pattern: '/:orgSlug/settings/locations/:locationId',
	})
	return {
		location: location!,
		load: async () =>
			(
				(await loader(args())) as unknown as {
					location: Record<string, unknown>
				}
			).location,
		dismiss: (fingerprint: string) =>
			action(
				args({
					method: 'POST',
					body: new URLSearchParams({
						intent: 'dismiss-hours-warnings',
						fingerprint,
					}),
				}),
			) as Promise<Response>,
		row: async () => {
			const [row] = await db
				.select()
				.from(OrganizationLocation)
				.where(eq(OrganizationLocation.id, location!.id))
			return row!
		},
	}
}

describe('dismissing hours warnings (#275)', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('stores the dismissal against the saved hours and shows warnings again once the hours change', async () => {
		const ctx = await setup()
		const before = await ctx.load()
		expect(before.hoursWarningsDismissed).toBe(false)
		const fingerprint = before.savedHoursFingerprint as string

		const response = await ctx.dismiss(fingerprint)
		expect(response.status).toBe(200)
		expect((await ctx.row()).hoursWarningsDismissedFor).toBe(fingerprint)
		expect((await ctx.load()).hoursWarningsDismissed).toBe(true)

		// Any change to the hours brings the warnings back.
		await db
			.update(OrganizationLocation)
			.set({ storeHours: week('11:00') })
			.where(eq(OrganizationLocation.id, ctx.location.id))
		const after = await ctx.load()
		expect(after.hoursWarningsDismissed).toBe(false)
		expect(after.savedHoursFingerprint).not.toBe(fingerprint)
	})

	it('refuses to dismiss warnings for hours the editor did not show', async () => {
		const ctx = await setup()
		const response = await ctx.dismiss('not-the-saved-hours')
		expect(response.status).toBe(409)
		expect((await ctx.row()).hoursWarningsDismissedFor).toBeNull()
	})

	it('needs the settings permission', async () => {
		const ctx = await setup('viewer')
		await expect(ctx.dismiss('any')).rejects.toMatchObject({
			status: 403,
		})
		expect((await ctx.row()).hoursWarningsDismissedFor).toBeNull()
	})
})
