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

const flags = vi.hoisted(() => ({
	on: new Set<string>(),
}))
vi.mock('@repo/common/feature-flags', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getFeatureFlag: vi.fn(async (key: string) =>
		flags.on.has(key) ? true : null,
	),
}))

beforeEach(() => {
	flags.on.clear()
})

async function setup(role: 'admin' | 'viewer' = 'admin') {
	const user = await createTestUser()
	const organization = await createTestOrganization(user.id, role)
	const { cookie } = await createTestSession(user.id)
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: organization.id,
			name: 'Uptown Bistro',
			slug: 'uptown-bistro',
			timezone: 'America/New_York',
			isActive: true,
			isDefault: false,
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
		load: () => loader(args()) as Promise<any>,
		save: (fields: Record<string, string>) =>
			action(
				args({
					method: 'POST',
					body: new URLSearchParams({
						name: 'Uptown Bistro',
						slug: 'uptown-bistro',
						isActive: 'true',
						isDefault: 'false',
						...fields,
					}),
				}),
			) as Promise<any>,
		row: async () => {
			const [row] = await db
				.select()
				.from(OrganizationLocation)
				.where(eq(OrganizationLocation.id, location!.id))
			return row!
		},
	}
}

const CANCEL = {
	guestCancelMinutes: '5',
	guestCancelScheduledLeadMinutes: '60',
}
const ACCEPT = {
	orderAcceptanceMode: 'manual',
	orderAcceptanceTimeoutMinutes: '10',
	orderAcceptanceMinTotal: '25.50',
	orderAcceptanceScheduledOnly: 'true',
}

describe('location order policies', () => {
	it('hides both groups while the flags are off', async () => {
		const { load } = await setup()
		expect((await load()).orderPolicies).toBeUndefined()
	})

	it('offers only the group whose flag is on', async () => {
		flags.on.add('ordering.guest_cancel')
		const { load } = await setup()
		const { orderPolicies } = await load()
		expect(orderPolicies.flags).toEqual({
			guestCancel: true,
			acceptance: false,
		})
		expect(orderPolicies.initial.guestCancelMinutes).toBe('0')
		expect(orderPolicies.initial.orderAcceptanceMode).toBe('auto')
		expect(orderPolicies.initial.orderAcceptanceTimeoutMinutes).toBe('5')
	})

	it('saves both groups with the flags on, money as cents', async () => {
		flags.on.add('ordering.guest_cancel')
		flags.on.add('ordering.manual_acceptance')
		const { save, row, load } = await setup()
		await save({ ...CANCEL, ...ACCEPT })
		expect(await row()).toMatchObject({
			guestCancelMinutes: 5,
			guestCancelScheduledLeadMinutes: 60,
			orderAcceptanceMode: 'manual',
			orderAcceptanceTimeoutMinutes: 10,
			orderAcceptanceMinTotalCents: 2550,
			orderAcceptanceScheduledOnly: true,
		})
		const { orderPolicies } = await load()
		expect(orderPolicies.initial.orderAcceptanceMinTotal).toBe('25.50')
	})

	it('saves an amount and minutes typed with Arabic-Indic digits', async () => {
		flags.on.add('ordering.guest_cancel')
		flags.on.add('ordering.manual_acceptance')
		const { save, row } = await setup()
		await save({
			...CANCEL,
			...ACCEPT,
			guestCancelScheduledLeadMinutes: '٤٥',
			orderAcceptanceMinTotal: '٢٥٫٥٠',
		})
		expect(await row()).toMatchObject({
			guestCancelScheduledLeadMinutes: 45,
			orderAcceptanceMinTotalCents: 2550,
		})
	})

	it('Off clears the scheduled lead; a blank amount means every order', async () => {
		flags.on.add('ordering.guest_cancel')
		flags.on.add('ordering.manual_acceptance')
		const { save, row } = await setup()
		await save({ ...CANCEL, ...ACCEPT })
		await save({
			...ACCEPT,
			guestCancelMinutes: '0',
			guestCancelScheduledLeadMinutes: '30',
			orderAcceptanceMinTotal: '',
		})
		expect(await row()).toMatchObject({
			guestCancelMinutes: null,
			guestCancelScheduledLeadMinutes: null,
			orderAcceptanceMinTotalCents: null,
		})
	})

	it('ignores a group whose flag is off', async () => {
		flags.on.add('ordering.guest_cancel')
		const { save, row } = await setup()
		await save({ ...CANCEL, ...ACCEPT })
		expect(await row()).toMatchObject({
			guestCancelMinutes: 5,
			orderAcceptanceMode: 'auto',
			orderAcceptanceTimeoutMinutes: 5,
			orderAcceptanceMinTotalCents: null,
			orderAcceptanceScheduledOnly: false,
		})
	})

	it('writes nothing with both flags off', async () => {
		const { save, row } = await setup()
		await save({ ...CANCEL, ...ACCEPT })
		expect(await row()).toMatchObject({
			guestCancelMinutes: null,
			orderAcceptanceMode: 'auto',
		})
	})

	it.each([
		['minutes', { guestCancelMinutes: '7' }],
		[
			'lead too long',
			{ guestCancelMinutes: '5', guestCancelScheduledLeadMinutes: '1441' },
		],
		[
			'lead negative',
			{ guestCancelMinutes: '5', guestCancelScheduledLeadMinutes: '-1' },
		],
		['mode', { orderAcceptanceMode: 'sometimes' }],
		[
			'timeout',
			{ orderAcceptanceMode: 'manual', orderAcceptanceTimeoutMinutes: '4' },
		],
		[
			'amount',
			{ orderAcceptanceMode: 'manual', orderAcceptanceMinTotal: '-3' },
		],
		[
			'amount text',
			{ orderAcceptanceMode: 'manual', orderAcceptanceMinTotal: 'abc' },
		],
	])('refuses an invalid %s without echoing it', async (_name, fields) => {
		flags.on.add('ordering.guest_cancel')
		flags.on.add('ordering.manual_acceptance')
		const { save, row } = await setup()
		const result = await save({ ...ACCEPT, ...fields })
		expect(typeof result.error).toBe('string')
		// The form words the refusal itself: a field name and a code, no text.
		expect(result.orderPolicyError).toEqual({
			field: expect.any(String),
			code: expect.stringMatching(/^invalid_(choice|minutes|amount)$/),
		})
		for (const value of Object.values(fields)) {
			expect(result.error).not.toContain(value)
		}
		expect(await row()).toMatchObject({
			guestCancelMinutes: null,
			orderAcceptanceMode: 'auto',
		})
	})

	it('refuses a save without update:settings:any', async () => {
		flags.on.add('ordering.guest_cancel')
		const { save, row } = await setup('viewer')
		await expect(save({ ...CANCEL })).rejects.toBeDefined()
		expect((await row()).guestCancelMinutes).toBeNull()
	})
})
