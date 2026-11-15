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

import { defaultTipSettings, type TipSettings } from '@repo/common/location-types'
import { serviceFeeSettingsSchema } from '@repo/common/service-fee'
import {
	emptyFeeForm,
	tipFormFromSettings,
	type FeeFormValues,
	type TipFormValues,
} from '#app/utils/orders/checkout-settings.ts'

const tips = (patch: (form: TipFormValues) => void = () => {}) => {
	const form = tipFormFromSettings(defaultTipSettings('USD'), 'USD')
	patch(form)
	return JSON.stringify(form)
}
const fee = (patch: Partial<FeeFormValues> = {}) =>
	JSON.stringify({ ...emptyFeeForm('USD'), enabled: true, percent: '3', ...patch })

describe('location tip choices (#118)', () => {
	it('shows the default buttons until something is saved', async () => {
		const { load } = await setup()
		const { checkoutSettings } = await load()
		expect(checkoutSettings.currency).toBe('USD')
		expect(checkoutSettings.tips.pickup.choices).toEqual([
			{ kind: 'percent', value: '10' },
			{ kind: 'percent', value: '15' },
			{ kind: 'percent', value: '18' },
			{ kind: 'percent', value: '20' },
		])
		expect(checkoutSettings.tips.pickup.defaultIndex).toBe('1')
		expect(checkoutSettings.tips.pickup.allowCustom).toBe(false)
	})

	it('saves the choices, the default and the custom switch as shared settings', async () => {
		const { save, row, load } = await setup()
		await save({
			checkoutTips: tips((form) => {
				form.delivery = {
					choices: [
						{ kind: 'percent', value: '12' },
						{ kind: 'amount', value: '2.50' },
					],
					defaultIndex: '',
					allowCustom: true,
				}
			}),
		})
		const saved = JSON.parse((await row()).tipSettings!) as TipSettings
		expect(saved.delivery).toEqual({
			choices: [{ percent: 12 }, { amountMinor: 250 }],
			defaultIndex: null,
			allowCustom: true,
		})
		expect(saved.pickup).toEqual(defaultTipSettings('USD').pickup)
		const { checkoutSettings } = await load()
		expect(checkoutSettings.tips.delivery).toEqual({
			choices: [
				{ kind: 'percent', value: '12' },
				{ kind: 'amount', value: '2.50' },
			],
			defaultIndex: '',
			allowCustom: true,
		})
	})

	it('refuses a bad choice with its field and saves nothing', async () => {
		const { save, row } = await setup()
		const result = await save({
			checkoutTips: tips((form) => {
				form.pickup.choices[0] = { kind: 'percent', value: '45' }
			}),
		})
		expect(result.checkoutIssue).toEqual({
			section: 'tips',
			field: 'pickup.choice.0',
			code: 'invalid_percent',
		})
		expect((await row()).tipSettings).toBeNull()
	})

	it('needs update:settings:any to save', async () => {
		const { save, row } = await setup('viewer')
		await expect(save({ checkoutTips: tips() })).rejects.toBeDefined()
		expect((await row()).tipSettings).toBeNull()
	})
})

describe('location service fee (#123)', () => {
	it('hides the fee group while the flag is off, and never writes it', async () => {
		const { save, row, load } = await setup()
		expect((await load()).checkoutSettings.serviceFeeEnabled).toBe(false)
		await save({ checkoutFee: fee() })
		expect((await row()).serviceFee).toBeNull()
	})

	it('saves the fee with the flag on, amounts as minor units', async () => {
		flags.on.add('ordering.service_fee')
		const { save, row, load } = await setup()
		expect((await load()).checkoutSettings.serviceFeeEnabled).toBe(true)
		await save({
			checkoutFee: fee({
				cap: '2.00',
				fixed: '0.25',
				dineIn: true,
				explanation: 'Covers card and ordering costs.',
				label: 'Online order fee',
			}),
		})
		const saved = serviceFeeSettingsSchema.parse(JSON.parse((await row()).serviceFee!))
		expect(saved).toMatchObject({
			enabled: true,
			percentBp: 300,
			capMinor: 200,
			fixedMinor: 25,
			fulfillments: ['pickup', 'delivery', 'dine_in'],
			label: 'Online order fee',
			explanation: 'Covers card and ordering costs.',
			taxable: false,
		})
		const { checkoutSettings } = await load()
		expect(checkoutSettings.fee).toMatchObject({
			enabled: true,
			percent: '3',
			cap: '2.00',
			fixed: '0.25',
			dineIn: true,
		})
	})

	it('refuses a cap of 0, more than 10 % and a fixed fee over the limit', async () => {
		flags.on.add('ordering.service_fee')
		const { save, row } = await setup()
		for (const [patch, field] of [
			[{ cap: '0' }, 'cap'],
			[{ percent: '11' }, 'percent'],
			[{ fixed: '30' }, 'fixed'],
		] as const) {
			const result = await save({ checkoutFee: fee(patch) })
			expect(result.checkoutIssue).toMatchObject({ section: 'fee', field })
		}
		expect((await row()).serviceFee).toBeNull()
	})

	it('turning the fee off keeps the settings but marks it off', async () => {
		flags.on.add('ordering.service_fee')
		const { save, row } = await setup()
		await save({ checkoutFee: fee() })
		await save({ checkoutFee: fee({ enabled: false }) })
		expect(JSON.parse((await row()).serviceFee!)).toMatchObject({
			enabled: false,
			percentBp: 300,
		})
	})
})
