import { describe, expect, it } from 'vitest'
import { createAdapter } from '../../src/pos/adapter'
import { parseRetryAfterHeader, PosError } from '../../src/pos/errors'
import {
	canOverridePosField,
	computeRemoteItemHash,
	defaultFieldOwnership,
	extractPosValues,
	getAllowlistedOverrideFields,
	OVERRIDE_ALLOWLIST,
	posOwnershipFields,
	validateFieldOwnership,
} from '../../src/pos/ownership'
import {
	getSandboxHolidayHours,
	getSandboxPauseState,
	resetPosSandbox,
} from '../../src/pos/sandbox'
import { sanitizeIntegrationErrorMessage } from '../../src/pos/service'
import {
	clearPosSyncHealthFailures,
	isSyncFailing,
	mergePosMenuCheckState,
	mergePosPauseState,
	mergePosStoreSettings,
	mergePosSyncHealth,
	parsePosConfig,
	resolveFieldOwnership,
	resolveTransport,
} from '../../src/pos/transport'
import {
	deliveryMenuLimits,
	deliveryPausePolicy,
	menuFields,
	merchantIds,
	posProviders,
	type PosProvider,
	type RemoteItem,
	type RemoteMenu,
} from '../../src/pos/types'
import {
	cloverWire,
	doordashWire,
	squareWire,
	toastWire,
	uberWire,
} from '../../src/pos/wire'

const sampleItem: RemoteItem = {
	id: 'item-1',
	name: 'Margherita Pizza',
	description: 'Tomato, basil, mozzarella',
	category: 'Pizza',
	price: 1299,
	imageUrl: null,
	available: true,
	modifierGroups: [
		{
			name: 'Extra toppings',
			min: 0,
			max: 3,
			options: [{ name: 'Olives', price: 100 }],
		},
	],
	variations: [],
	menus: [],
	allergens: ['dairy'],
	alcohol: false,
	taxRate: 8.5,
	version: 1,
}
const sampleMenus: RemoteMenu[] = [
	{ name: 'Lunch', days: [0, 1, 2, 3, 4], start: '11:00', end: '15:00' },
]

describe('POS wire codecs', () => {
	it('round-trips a Clover element', () => {
		const decoded = cloverWire.decode(cloverWire.encode(sampleItem))
		expect(decoded.name).toBe(sampleItem.name)
		expect(decoded.price).toBe(sampleItem.price)
		expect(decoded.category).toBe(sampleItem.category)
		expect(decoded.modifierGroups[0]?.options[0]?.name).toBe('Olives')
		expect(decoded.taxRate).toBeCloseTo(8.5)
	})

	it('round-trips Square catalog objects', () => {
		const objects = squareWire.encode([sampleItem], 'USD', 'LOC')
		const [decoded] = squareWire.decode(objects, 'LOC')
		expect(decoded?.name).toBe(sampleItem.name)
		expect(decoded?.price).toBe(sampleItem.price)
		expect(decoded?.category).toBe(sampleItem.category)
		expect(decoded?.modifierGroups[0]?.name).toBe('Extra toppings')
	})

	it('round-trips a Toast menu', () => {
		const payload = toastWire.encode([sampleItem], sampleMenus, 'GUID')
		const decoded = toastWire.decode(payload, [
			{ guid: 'item-1', status: 'IN_STOCK' },
		])
		expect(decoded.items).toHaveLength(1)
		expect(decoded.items[0]?.name).toBe(sampleItem.name)
		expect(decoded.menus[0]?.name).toBe('Lunch')
	})

	it('round-trips an Uber Eats menu', () => {
		const decoded = uberWire.decode(
			uberWire.encode([{ ...sampleItem, menus: ['Lunch'] }], sampleMenus),
		)
		expect(decoded.items).toHaveLength(1)
		expect(decoded.items[0]?.name).toBe(sampleItem.name)
		expect(decoded.items[0]?.menus).toEqual(['Lunch'])
	})

	it('round-trips a DoorDash menu', () => {
		const decoded = doordashWire.decode(
			doordashWire.encode([{ ...sampleItem, menus: ['Lunch'] }], sampleMenus),
		)
		expect(decoded.items).toHaveLength(1)
		expect(decoded.items[0]?.name).toBe(sampleItem.name)
	})
})

function adapterFor(provider: PosProvider, storeId: string) {
	const transport = resolveTransport(provider, storeId, {
		environment: 'sandbox',
		merchantId: merchantIds[provider],
	})
	return createAdapter(provider, transport)
}

describe('POS sandbox adapters', () => {
	for (const provider of posProviders) {
		it(`${provider}: connects and reads a seeded catalog`, async () => {
			const adapter = adapterFor(provider, `store-${provider}`)
			const currency = await adapter.connect()
			expect(currency).toBe('USD')

			const catalog = await adapter.read()
			expect(catalog.items.length).toBeGreaterThan(0)
			expect(catalog.items.every((item) => item.name)).toBe(true)
		})
	}

	it('clover: creates and updates an item', async () => {
		const adapter = adapterFor('clover', 'store-clover-write')
		const created = await adapter.create(
			{ ...sampleItem, id: '' },
			'key-1',
			'USD',
		)
		expect(created.id).toBeTruthy()
		await adapter.update({ ...created, price: 999 }, 'key-2', 'USD')
		const catalog = await adapter.read()
		expect(catalog.items.find((item) => item.id === created.id)?.price).toBe(
			999,
		)
	})

	it('square: creates an item and returns an id', async () => {
		const adapter = adapterFor('square', 'store-square-write')
		const created = await adapter.create(
			{ ...sampleItem, id: 'draft' },
			'key-square',
			'USD',
		)
		expect(created.id).toBeTruthy()
		const catalog = await adapter.read()
		expect(catalog.items.some((item) => item.id === created.id)).toBe(true)
	})

	it('ubereats: replaces the whole menu', async () => {
		const adapter = adapterFor('ubereats', 'store-uber-write')
		const before = await adapter.read()
		await adapter.submitMenu(
			[{ ...sampleItem, menus: ['Lunch'] }],
			sampleMenus,
			0,
			'key-uber',
		)
		const after = await adapter.read()
		expect(after.items).toHaveLength(1)
		expect(after.items[0]?.id).toBe('item-1')
		expect(before.items.length).toBeGreaterThan(0)
	})

	it('doordash: replaces the whole menu through a job', async () => {
		const adapter = adapterFor('doordash', 'store-dd-write')
		const before = await adapter.read()
		await adapter.submitMenu(
			[{ ...sampleItem, menus: ['Lunch'] }],
			sampleMenus,
			before.version,
			'key-dd',
		)
		const after = await adapter.read()
		expect(after.items).toHaveLength(1)
	})

	it('toast: updates availability only', async () => {
		const adapter = adapterFor('toast', 'store-toast-write')
		const before = await adapter.read()
		const item = before.items[0]!
		await adapter.setAvailability(item, false, 'key-toast', 'USD')
		const after = await adapter.read()
		expect(after.items.find((entry) => entry.id === item.id)?.available).toBe(
			false,
		)
	})
})

describe('POS field ownership & override allowlist (#93)', () => {
	it('maps all Who owns what fields cleanly to canonical MenuField', () => {
		expect(posOwnershipFields).toEqual([
			'name',
			'description',
			'price',
			'available',
			'category',
			'modifiers',
			'photo',
			'tax',
		])
		for (const field of posOwnershipFields) {
			expect(menuFields).toContain(field)
		}
	})

	it('defaults ownership from readFields per provider and forbids POS ownership on unreadable fields', () => {
		expect(defaultFieldOwnership('square')).toEqual({
			name: 'pos',
			description: 'pos',
			price: 'pos',
			available: 'pos',
			category: 'pos',
			modifiers: 'pos',
			photo: 'pos',
			tax: 'pos',
		})
		expect(defaultFieldOwnership('clover')).toEqual({
			name: 'pos',
			description: 'menuza',
			price: 'pos',
			available: 'pos',
			category: 'pos',
			modifiers: 'pos',
			photo: 'menuza',
			tax: 'pos',
		})
		expect(defaultFieldOwnership('toast').tax).toBe('menuza')

		const parsed = parsePosConfig(
			JSON.stringify({
				environment: 'sandbox',
				merchantId: 'M1',
				fieldOwnership: { price: 'menuza', description: 'pos' },
			}),
		)
		expect(parsed.fieldOwnership).toEqual({
			price: 'menuza',
			description: 'pos',
		})
		// Clover cannot read description, so resolveFieldOwnership keeps it menuza.
		const cloverResolved = resolveFieldOwnership('clover', parsed)
		expect(cloverResolved.price).toBe('menuza')
		expect(cloverResolved.description).toBe('menuza')

		expect(
			validateFieldOwnership('clover', { description: 'pos' }),
		).toMatchObject({
			ok: false,
			invalidFields: ['description'],
		})
		expect(validateFieldOwnership('square', { price: 'menuza' })).toMatchObject(
			{
				ok: true,
				fieldOwnership: expect.objectContaining({
					price: 'menuza',
					name: 'pos',
				}),
			},
		)
	})

	it('enforces declarative per-integration override allowlist (AC #7)', () => {
		expect(OVERRIDE_ALLOWLIST.square.honoursPriceOverride).toBe(false)
		expect(OVERRIDE_ALLOWLIST.clover.honoursPriceOverride).toBe(false)
		expect(OVERRIDE_ALLOWLIST.toast.honoursPriceOverride).toBe(false)

		expect(getAllowlistedOverrideFields('square', 'item')).toEqual([
			'name',
			'description',
			'photo',
			'modifiers',
		])
		expect(canOverridePosField('square', 'item', 'description')).toBe(true)
		expect(canOverridePosField('square', 'item', 'name')).toBe(true)
		expect(canOverridePosField('square', 'item', 'photo')).toBe(true)
		expect(canOverridePosField('square', 'item', 'modifiers')).toBe(true)
		expect(canOverridePosField('square', 'item', 'price')).toBe(false)
		expect(canOverridePosField('square', 'item', 'tax')).toBe(false)
		expect(canOverridePosField('square', 'item', 'category')).toBe(false)
		expect(canOverridePosField('square', 'item', 'available')).toBe(false)

		expect(canOverridePosField('square', 'modifier_group', 'name')).toBe(true)
		expect(canOverridePosField('square', 'modifier_group', 'modifiers')).toBe(
			false,
		)
		expect(canOverridePosField('square', 'modifier_option', 'name')).toBe(true)
		expect(canOverridePosField('square', 'modifier_option', 'price')).toBe(
			false,
		)

		// Providers with honoursPriceOverride: true allow price override.
		expect(OVERRIDE_ALLOWLIST.ubereats.honoursPriceOverride).toBe(true)
		expect(canOverridePosField('ubereats', 'item', 'price')).toBe(true)
	})

	it('computes deterministic remote item hashes and extracts local-unit POS values', () => {
		const hash1 = computeRemoteItemHash(sampleItem)
		const hash2 = computeRemoteItemHash({ ...sampleItem, version: 99 })
		expect(hash1).toBe(hash2)

		const changedHash = computeRemoteItemHash({ ...sampleItem, price: 1599 })
		expect(changedHash).not.toBe(hash1)

		const values = extractPosValues(sampleItem)
		expect(values).toMatchObject({
			name: 'Margherita Pizza',
			description: 'Tomato, basil, mozzarella',
			price: 12.99,
			available: true,
			category: 'Pizza',
			photo: null,
			tax: 8.5,
		})
		expect(values.modifiers[0]?.options[0]?.price).toBe(1)
	})
})

describe('POS Retry-After, syncHealth & redaction helpers (#74)', () => {
	it('parses Retry-After header seconds and HTTP-dates and attaches retryAfterSeconds on 429 PosError', async () => {
		const baseNow = Date.UTC(2026, 10, 24, 12, 0, 0)
		expect(parseRetryAfterHeader('120', baseNow)).toBe(120)
		expect(
			parseRetryAfterHeader(new Date(baseNow + 90_000).toUTCString(), baseNow),
		).toBe(90)
		expect(
			parseRetryAfterHeader(new Date(baseNow - 5_000).toUTCString(), baseNow),
		).toBeUndefined()
		expect(parseRetryAfterHeader(null, baseNow)).toBeUndefined()

		const adapter429Sec = createAdapter('doordash', {
			baseUrl: 'https://sandbox.example.test',
			token: 'tok',
			merchantId: 'D-1',
			fetch: async () =>
				new Response(JSON.stringify({ message: 'Too Many Requests' }), {
					status: 429,
					headers: { 'Retry-After': '180' },
				}),
		})
		await expect(adapter429Sec.read()).rejects.toMatchObject({
			name: 'PosError',
			status: 429,
			retryAfterSeconds: 180,
		})

		const futureDate = new Date(Date.now() + 75_000).toUTCString()
		const adapter429Date = createAdapter('ubereats', {
			baseUrl: 'https://sandbox.example.test',
			token: 'tok',
			merchantId: 'U-1',
			fetch: async () =>
				new Response('rate limited', {
					status: 429,
					headers: { 'Retry-After': futureDate },
				}),
		})
		try {
			await adapter429Date.pause(null)
			expect.unreachable('Expected 429 PosError')
		} catch (err) {
			expect(err).toBeInstanceOf(PosError)
			const posErr = err as PosError
			expect(posErr.status).toBe(429)
			expect(posErr.retryAfterSeconds).toBeGreaterThanOrEqual(60)
			expect(posErr.retryAfterSeconds).toBeLessThanOrEqual(80)
		}
	})

	it('tracks syncHealth without clobbering fieldOwnership and flags Sync failing after 24 hours', () => {
		const initial = JSON.stringify({
			environment: 'sandbox',
			merchantId: 'M1',
			fieldOwnership: { price: 'menuza' },
		})
		const t0 = new Date('2026-11-24T00:00:00.000Z')
		const failingConfig = mergePosSyncHealth(initial, {
			firstFailedAt: t0.toISOString(),
			lastFailedAt: t0.toISOString(),
			lastError: 'The provider is temporarily unavailable.',
			alertedAt: null,
		})
		const parsed = parsePosConfig(failingConfig)
		expect(parsed.fieldOwnership).toEqual({ price: 'menuza' })
		expect(parsed.syncHealth).toMatchObject({
			firstFailedAt: t0.toISOString(),
			lastError: 'The provider is temporarily unavailable.',
			alertedAt: null,
		})

		// 23h59m: not yet marked Sync failing
		expect(
			isSyncFailing(
				failingConfig,
				new Date(t0.getTime() + 24 * 3600_000 - 1_000),
			),
		).toBe(false)
		// >= 24h: marked Sync failing
		expect(
			isSyncFailing(failingConfig, new Date(t0.getTime() + 24 * 3600_000)),
		).toBe(true)

		// Recovery clears failure fields while preserving lastMenuPushAt and fieldOwnership
		const pushTime = new Date(t0.getTime() + 25 * 3600_000).toISOString()
		const recovered = clearPosSyncHealthFailures(failingConfig, {
			lastMenuPushAt: pushTime,
		})
		expect(
			isSyncFailing(recovered, new Date(t0.getTime() + 26 * 3600_000)),
		).toBe(false)
		const parsedRecovered = parsePosConfig(recovered)
		expect(parsedRecovered.fieldOwnership).toEqual({ price: 'menuza' })
		expect(parsedRecovered.syncHealth?.lastMenuPushAt).toBe(pushTime)
		expect(parsedRecovered.syncHealth?.firstFailedAt).toBeNull()
	})

	it('redacts tokens and secrets from integration error strings', () => {
		const msg = sanitizeIntegrationErrorMessage(
			new Error(
				'Upstream failed with Authorization: Bearer secret-oauth-token-123 and access_token=tok_live_999',
			),
		)
		expect(msg).not.toContain('secret-oauth-token-123')
		expect(msg).not.toContain('tok_live_999')
		expect(msg).toContain('Bearer [REDACTED]')
		expect(msg).toContain('access_token=[REDACTED]')
	})
})

describe('POS sandbox store pause & config state (#95)', () => {
	it('declares deliveryPausePolicy for delivery providers', () => {
		expect(deliveryPausePolicy.ubereats).toEqual({
			supportsOpenEnded: true,
			maxPauseMinutes: null,
		})
		expect(deliveryPausePolicy.doordash).toEqual({
			supportsOpenEnded: false,
			maxPauseMinutes: 1440,
		})
		expect(deliveryPausePolicy.square).toBeUndefined()
	})

	it('tracks pausedUntil per sandbox store across pause and resume', async () => {
		resetPosSandbox()
		const uberStoreId = 'store-uber-pause-1'
		const ddStoreId = 'store-dd-pause-1'
		const uber = adapterFor('ubereats', uberStoreId)
		const dd = adapterFor('doordash', ddStoreId)

		expect(getSandboxPauseState(uberStoreId)).toBeNull()

		const until = '2026-11-25T01:30:00.000Z'
		await uber.pause(until)
		expect(getSandboxPauseState(uberStoreId)).toEqual({ pausedUntil: until })
		expect(getSandboxPauseState(ddStoreId)).toBeNull()

		await dd.pause('2026-11-26T00:00:00.000Z')
		expect(getSandboxPauseState(ddStoreId)).toEqual({
			pausedUntil: '2026-11-26T00:00:00.000Z',
		})

		await uber.pause(null)
		expect(getSandboxPauseState(uberStoreId)).toEqual({ pausedUntil: null })
		expect(getSandboxPauseState(ddStoreId)).toEqual({
			pausedUntil: '2026-11-26T00:00:00.000Z',
		})
	})

	it('parses and merges pause state without clobbering fieldOwnership or syncHealth', () => {
		const initial = JSON.stringify({
			environment: 'sandbox',
			merchantId: 'D-8241937',
			fieldOwnership: { price: 'menuza' },
			syncHealth: {
				firstFailedAt: null,
				lastFailedAt: null,
				lastError: null,
				alertedAt: null,
				lastMenuPushAt: '2026-11-24T12:00:00.000Z',
			},
		})
		const pausedConfig = mergePosPauseState(initial, {
			pausedUntil: '2026-11-24T13:00:00.000Z',
			openEnded: false,
			platformPausedUntil: '2026-11-24T13:00:00.000Z',
			lastPauseError: null,
			lastAttemptAt: '2026-11-24T12:30:00.000Z',
		})
		const parsed = parsePosConfig(pausedConfig)
		expect(parsed.fieldOwnership).toEqual({ price: 'menuza' })
		expect(parsed.syncHealth?.lastMenuPushAt).toBe('2026-11-24T12:00:00.000Z')
		expect(parsed.pause).toEqual({
			pausedUntil: '2026-11-24T13:00:00.000Z',
			openEnded: false,
			platformPausedUntil: '2026-11-24T13:00:00.000Z',
			lastPauseError: null,
			lastAttemptAt: '2026-11-24T12:30:00.000Z',
		})

		const failedConfig = mergePosPauseState(pausedConfig, {
			lastPauseError: 'The provider is temporarily unavailable.',
		})
		expect(parsePosConfig(failedConfig).pause?.pausedUntil).toBe(
			'2026-11-24T13:00:00.000Z',
		)
		expect(parsePosConfig(failedConfig).pause?.lastPauseError).toBe(
			'The provider is temporarily unavailable.',
		)
	})

	it('submits holiday hours to Uber Eats and DoorDash sandboxes', async () => {
		resetPosSandbox()
		const uberStoreId = 'int_holiday_uber'
		const ddStoreId = 'int_holiday_dd'
		const uber = adapterFor('ubereats', uberStoreId)
		const dd = adapterFor('doordash', ddStoreId)

		const hours = [
			{
				date: '2026-11-26',
				isOpen: false,
				intervals: [],
				timezone: 'America/New_York',
			},
			{
				date: '2026-12-24',
				isOpen: true,
				intervals: [{ start: '10:00', end: '15:00' }],
				timezone: 'America/New_York',
			},
		]

		await uber.submitHolidayHours(hours)
		await dd.submitHolidayHours(hours)

		expect(getSandboxHolidayHours(uberStoreId)).toEqual(hours)
		expect(getSandboxHolidayHours(ddStoreId)).toEqual(hours)
	})

	it('parses and merges store settings and feedsDelivery without clobbering other config keys', () => {
		expect(deliveryMenuLimits.ubereats).toBe(5)
		expect(deliveryMenuLimits.doordash).toBe(5)

		const initial = JSON.stringify({
			environment: 'sandbox',
			merchantId: 'M_SANDBOX_CLOVER',
			fieldOwnership: { price: 'pos' },
			feedsDelivery: ['ubereats', 'invalid_provider'],
		})
		const merged = mergePosStoreSettings(initial, {
			menuIds: ['m1', 'm2', 'm1'],
			holidaySync: true,
			live: true,
		})
		const parsed = parsePosConfig(merged)
		expect(parsed.fieldOwnership).toEqual({ price: 'pos' })
		expect(parsed.feedsDelivery).toEqual(['ubereats'])
		expect(parsed.store).toEqual({
			menuIds: ['m1', 'm2'],
			holidaySync: true,
			live: true,
			lastHolidaySyncAt: null,
		})
	})

	it('parses and merges menuCheck state without clobbering fieldOwnership, syncHealth, pause, or store', () => {
		const initial = JSON.stringify({
			environment: 'sandbox',
			merchantId: 'D-8241937',
			fieldOwnership: { price: 'pos' },
			syncHealth: {
				firstFailedAt: null,
				lastFailedAt: null,
				lastError: null,
				alertedAt: null,
				lastMenuPushAt: '2026-11-24T12:00:00.000Z',
			},
			pause: {
				pausedUntil: '2026-11-24T15:00:00.000Z',
				openEnded: false,
				platformPausedUntil: '2026-11-24T15:00:00.000Z',
				lastPauseError: null,
				lastAttemptAt: '2026-11-24T14:00:00.000Z',
			},
			store: {
				menuIds: ['menu_1'],
				holidaySync: true,
				live: true,
			},
		})
		const checked = mergePosMenuCheckState(initial, {
			lastCheckedAt: '2026-11-24T16:00:00.000Z',
			lastAttemptAt: '2026-11-24T16:00:00.000Z',
			lastStatus: 'diff',
			diffCount: 3,
			posChangedCount: 1,
			lastError: null,
			manualChecksDate: '2026-11-24',
			manualChecksCount: 1,
		})
		const parsed = parsePosConfig(checked)
		expect(parsed.fieldOwnership).toEqual({ price: 'pos' })
		expect(parsed.syncHealth?.lastMenuPushAt).toBe('2026-11-24T12:00:00.000Z')
		expect(parsed.pause?.pausedUntil).toBe('2026-11-24T15:00:00.000Z')
		expect(parsed.store?.menuIds).toEqual(['menu_1'])
		expect(parsed.menuCheck).toEqual({
			lastCheckedAt: '2026-11-24T16:00:00.000Z',
			lastAttemptAt: '2026-11-24T16:00:00.000Z',
			lastStatus: 'diff',
			diffCount: 3,
			posChangedCount: 1,
			lastError: null,
			manualChecksDate: '2026-11-24',
			manualChecksCount: 1,
		})

		// Error attempt preserves lastCheckedAt, diffCount, posChangedCount
		const errored = mergePosMenuCheckState(checked, {
			lastAttemptAt: '2026-11-25T03:00:00.000Z',
			lastStatus: 'error',
			lastError: 'Could not check',
		})
		const parsedError = parsePosConfig(errored)
		expect(parsedError.menuCheck).toEqual({
			lastCheckedAt: '2026-11-24T16:00:00.000Z',
			lastAttemptAt: '2026-11-25T03:00:00.000Z',
			lastStatus: 'error',
			diffCount: 3,
			posChangedCount: 1,
			lastError: 'Could not check',
			manualChecksDate: '2026-11-24',
			manualChecksCount: 1,
		})
	})
})
