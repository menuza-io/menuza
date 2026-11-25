import {
	and,
	db,
	desc,
	eq,
	Integration,
	IntegrationLog,
	MenuSyncOutbox,
	OrganizationLocation,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuLocationOverride,
	OrganizationMenuPosLink,
} from '@repo/database'
import { merchantIds, parsePosConfig, sandboxUrls } from '@repo/integrations'
import {
	posSandboxHandlers,
	resetPosSandbox,
} from '@repo/integrations/pos/sandbox'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INTEGRATION_FLAG_KEYS } from '#app/utils/integrations/flags.server.ts'
import {
	fixDeliveryMenuByPushing,
	loadDeliveryMenuCheckSummaries,
	runDailyDeliveryMenuChecks,
	runDeliveryMenuCheck,
} from '#app/utils/integrations/menu-check.server.ts'
import { server } from '#tests/mocks/index.ts'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'

const flags = vi.hoisted(() => ({ on: new Set<string>() }))
vi.mock('@repo/common/feature-flags', () => ({
	getFeatureFlag: vi.fn(async (key: string) => flags.on.has(key)),
}))

async function seedDeliveryFixture(options?: {
	provider?: 'ubereats' | 'doordash'
	storeMenuIds?: string[]
	includePos?: boolean
}) {
	const provider = options?.provider ?? 'ubereats'
	const { organization } = await setupTestOrgWithUser('admin')
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: organization.id,
			name: JSON.stringify({ en: 'Main' }),
			slug: `main-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			timezone: 'UTC',
			isDefault: true,
		})
		.returning()

	const [menu] = await db
		.insert(OrganizationMenu)
		.values({
			organizationId: organization.id,
			displayName: JSON.stringify({ en: 'Lunch' }),
			position: 0,
		})
		.returning()

	const [category] = await db
		.insert(OrganizationMenuCategory)
		.values({
			organizationId: organization.id,
			displayName: JSON.stringify({ en: 'Mains' }),
		})
		.returning()

	await db.insert(OrganizationMenuCategoryAssignment).values({
		menuId: menu!.id,
		categoryId: category!.id,
		position: 0,
	})

	const [item1] = await db
		.insert(OrganizationMenuItem)
		.values({
			organizationId: organization.id,
			displayName: JSON.stringify({ en: 'Garlic Bread' }),
			price: 4.99,
			availabilityStatus: 'available',
		})
		.returning()
	const [item2] = await db
		.insert(OrganizationMenuItem)
		.values({
			organizationId: organization.id,
			displayName: JSON.stringify({ en: 'Margherita Pizza' }),
			price: 12.99,
			availabilityStatus: 'available',
		})
		.returning()

	await db.insert(OrganizationMenuItemCategoryAssignment).values([
		{ categoryId: category!.id, itemId: item1!.id, position: 0 },
		{ categoryId: category!.id, itemId: item2!.id, position: 1 },
	])

	const [delivery] = await db
		.insert(Integration)
		.values({
			organizationId: organization.id,
			organizationLocationId: location!.id,
			providerName: provider,
			providerType: 'delivery',
			isActive: true,
			config: JSON.stringify({
				environment: 'sandbox',
				merchantId: merchantIds[provider],
				...(options?.storeMenuIds
					? {
							store: {
								menuIds: options.storeMenuIds,
								holidaySync: false,
								live: false,
							},
						}
					: {}),
			}),
		})
		.returning()

	let posIntegration: typeof Integration.$inferSelect | undefined
	if (options?.includePos) {
		const [pos] = await db
			.insert(Integration)
			.values({
				organizationId: organization.id,
				organizationLocationId: location!.id,
				providerName: 'square',
				providerType: 'pos',
				isActive: true,
				config: JSON.stringify({
					environment: 'sandbox',
					merchantId: merchantIds.square,
					fieldOwnership: { price: 'pos', available: 'pos' },
				}),
			})
			.returning()
		posIntegration = pos
	}

	return {
		organization,
		location: location!,
		menu: menu!,
		category: category!,
		item1: item1!,
		item2: item2!,
		delivery: delivery!,
		posIntegration,
	}
}

const menuSyncWakeHandler = http.post(
	'http://localhost:8787/workflows/menu-sync/start',
	() => HttpResponse.json({ success: true }),
)

describe('delivery menu check service (#144)', () => {
	beforeEach(() => {
		flags.on.clear()
		resetPosSandbox()
		server.use(...posSandboxHandlers, menuSyncWakeHandler)
	})

	afterEach(() => {
		server.resetHandlers()
		vi.restoreAllMocks()
	})

	it('is gated off by default when integrations.menu_check is false', async () => {
		const { organization, delivery } = await seedDeliveryFixture()
		const manual = await runDeliveryMenuCheck(delivery.id, organization.id, {
			trigger: 'manual',
		})
		expect(manual).toEqual({ ok: false, status: 404, error: 'feature_off' })

		const sweep = await runDailyDeliveryMenuChecks({
			organizationId: organization.id,
		})
		expect(sweep).toEqual({
			checked: 0,
			matched: 0,
			differing: 0,
			failed: 0,
			skipped: 1,
		})
	})

	it('detects diffs against sandbox catalog without auto-fixing, enforces 1/day auto limit, and applies location overrides', async () => {
		flags.on.add(INTEGRATION_FLAG_KEYS.menuCheck)
		const { organization, location, delivery, item1 } =
			await seedDeliveryFixture({ provider: 'ubereats' })

		// Location override lowers Garlic Bread price to 5.50 (550 cents vs sandbox 499 cents)
		await db.insert(OrganizationMenuLocationOverride).values({
			organizationId: organization.id,
			locationId: location.id,
			entityType: 'item',
			entityId: item1.id,
			isEnabled: true,
			price: 5.5,
		})

		const day1 = new Date('2026-11-24T03:00:00.000Z')
		const sweep1 = await runDailyDeliveryMenuChecks({
			organizationId: organization.id,
			now: day1,
		})
		expect(sweep1).toEqual({
			checked: 1,
			matched: 0,
			differing: 1,
			failed: 0,
			skipped: 0,
		})

		const [updated] = await db
			.select()
			.from(Integration)
			.where(eq(Integration.id, delivery.id))
		const config = parsePosConfig(updated!.config)
		expect(config.menuCheck).toMatchObject({
			lastCheckedAt: day1.toISOString(),
			lastAttemptAt: day1.toISOString(),
			lastStatus: 'diff',
			lastError: null,
			posChangedCount: 0,
		})
		expect(config.menuCheck!.diffCount).toBeGreaterThan(0)

		const logs = await db
			.select()
			.from(IntegrationLog)
			.where(
				and(
					eq(IntegrationLog.integrationId, delivery.id),
					eq(IntegrationLog.action, 'menu_check'),
				),
			)
		expect(logs).toHaveLength(1)
		expect(logs[0]!.status).toBe('success')
		// Zero tokens in IntegrationLog
		expect(logs[0]!.requestData).not.toContain('token')
		expect(logs[0]!.responseData).toBeNull()

		const summaries = await loadDeliveryMenuCheckSummaries([updated!], day1)
		const summary = summaries.get(delivery.id)!
		expect(
			summary.diffs.some(
				(d) =>
					d.kind === 'price' && d.localPrice === 550 && d.remotePrice === 499,
			),
		).toBe(true)
		expect(
			summary.diffs.some(
				(d) => d.kind === 'extra' && d.dishName === 'Veggie Burger',
			),
		).toBe(true)

		// Never auto-fixed: no pos_push log was created
		const pushLogs = await db
			.select()
			.from(IntegrationLog)
			.where(
				and(
					eq(IntegrationLog.integrationId, delivery.id),
					eq(IntegrationLog.action, 'pos_push'),
				),
			)
		expect(pushLogs).toHaveLength(0)

		// Second daily sweep on the same day skips (1/day auto limit)
		const sweep2 = await runDailyDeliveryMenuChecks({
			organizationId: organization.id,
			now: new Date('2026-11-24T15:00:00.000Z'),
		})
		expect(sweep2).toEqual({
			checked: 0,
			matched: 0,
			differing: 0,
			failed: 0,
			skipped: 1,
		})

		// Next day runs again
		const sweep3 = await runDailyDeliveryMenuChecks({
			organizationId: organization.id,
			now: new Date('2026-11-25T03:00:00.000Z'),
		})
		expect(sweep3.checked).toBe(1)
	})

	it('enforces 3 manual checks per connection per day and resets the next day', async () => {
		flags.on.add(INTEGRATION_FLAG_KEYS.menuCheck)
		const { organization, delivery } = await seedDeliveryFixture({
			provider: 'doordash',
		})

		const day1 = new Date('2026-11-24T10:00:00.000Z')
		for (let i = 1; i <= 3; i++) {
			const res = await runDeliveryMenuCheck(delivery.id, organization.id, {
				trigger: 'manual',
				now: day1,
			})
			expect(res.ok).toBe(true)
			if (res.ok) {
				expect(res.menuCheck.manualChecksCount).toBe(i)
			}
		}

		const fourth = await runDeliveryMenuCheck(delivery.id, organization.id, {
			trigger: 'manual',
			now: day1,
		})
		expect(fourth).toMatchObject({
			ok: false,
			status: 429,
			error: 'check_limit_reached',
		})

		// Next day works again
		const nextDay = await runDeliveryMenuCheck(delivery.id, organization.id, {
			trigger: 'manual',
			now: new Date('2026-11-25T10:00:00.000Z'),
		})
		expect(nextDay.ok).toBe(true)
		if (nextDay.ok) {
			expect(nextDay.menuCheck.manualChecksCount).toBe(1)
		}
	})

	it('preserves last successful check result and diffs when a subsequent platform read fails', async () => {
		flags.on.add(INTEGRATION_FLAG_KEYS.menuCheck)
		const { organization, delivery } = await seedDeliveryFixture({
			provider: 'doordash',
		})

		const t1 = new Date('2026-11-24T08:00:00.000Z')
		const first = await runDeliveryMenuCheck(delivery.id, organization.id, {
			trigger: 'manual',
			now: t1,
		})
		expect(first.ok).toBe(true)
		const initialDiffCount = first.ok ? first.errorDiffCount : 0
		expect(initialDiffCount).toBeGreaterThan(0)

		server.use(
			http.get(`${sandboxUrls.doordash}/api/v1/stores/*/menus`, () =>
				HttpResponse.json({ message: 'Upstream failure' }, { status: 503 }),
			),
		)

		const t2 = new Date('2026-11-24T09:00:00.000Z')
		const failed = await runDeliveryMenuCheck(delivery.id, organization.id, {
			trigger: 'manual',
			now: t2,
		})
		expect(failed).toMatchObject({
			ok: false,
			status: 502,
			error: 'read_failed',
			message: 'Could not check',
		})

		const [row] = await db
			.select()
			.from(Integration)
			.where(eq(Integration.id, delivery.id))
		const mc = parsePosConfig(row!.config).menuCheck!
		expect(mc.lastError).toBe('Could not check')
		expect(mc.lastAttemptAt).toBe(t2.toISOString())
		// Preserved from t1:
		expect(mc.lastCheckedAt).toBe(t1.toISOString())
		expect(mc.diffCount).toBe(initialDiffCount)

		// Latest successful menu_check log diffs remain intact
		const summaries = await loadDeliveryMenuCheckSummaries([row!], t2)
		const summary = summaries.get(delivery.id)!
		expect(summary.lastError).toBe('Could not check')
		expect(summary.lastCheckedAt).toBe(t1.toISOString())
		expect(summary.diffs.length).toBeGreaterThan(0)
	})

	it('marks POS-owned non-overridden diffs as changedInPos and not errors, while overridden fields stay errors', async () => {
		flags.on.add(INTEGRATION_FLAG_KEYS.menuCheck)
		const { organization, delivery, posIntegration, item1, item2 } =
			await seedDeliveryFixture({ provider: 'ubereats', includePos: true })

		// item1 (Garlic Bread): POS-owned price, not overridden
		// item2 (Margherita Pizza): POS-owned price, but overridden ("Use my own")
		await db.insert(OrganizationMenuPosLink).values([
			{
				organizationId: organization.id,
				integrationId: posIntegration!.id,
				providerName: 'square',
				entityType: 'item',
				remoteId: 'sq-1',
				localId: item1.id,
				overriddenFields: '[]',
			},
			{
				organizationId: organization.id,
				integrationId: posIntegration!.id,
				providerName: 'square',
				entityType: 'item',
				remoteId: 'sq-2',
				localId: item2.id,
				overriddenFields: JSON.stringify(['price']),
			},
		])

		// Remote menu matches Garlic Bread at $6.00 vs Menuza $4.99, and Margherita at $14.00 vs Menuza $12.99
		server.use(
			http.get(`${sandboxUrls.ubereats}/v2/eats/stores/*/menus`, () =>
				HttpResponse.json(
					{
						menus: [
							{
								id: 'MENU_LUNCH',
								title: { translations: { en_us: 'Lunch' } },
								service_availability: [],
								category_ids: ['LUNCH__MAINS'],
							},
						],
						categories: [
							{
								id: 'LUNCH__MAINS',
								title: { translations: { en_us: 'Mains' } },
								entities: [
									{ id: 'r1', type: 'ITEM' },
									{ id: 'r2', type: 'ITEM' },
								],
							},
						],
						items: [
							{
								id: 'r1',
								title: { translations: { en_us: 'Garlic Bread' } },
								description: { translations: { en_us: '' } },
								price_info: { price: 600 },
								modifier_group_ids: { ids: [] },
							},
							{
								id: 'r2',
								title: { translations: { en_us: 'Margherita Pizza' } },
								description: { translations: { en_us: '' } },
								price_info: { price: 1400 },
								modifier_group_ids: { ids: [] },
							},
						],
						modifier_groups: [],
					},
					{ headers: { 'x-pos-sandbox': 'true' } },
				),
			),
		)

		const res = await runDeliveryMenuCheck(delivery.id, organization.id, {
			trigger: 'manual',
		})
		expect(res.ok).toBe(true)
		if (res.ok) {
			expect(res.posChangedCount).toBe(1)
			expect(res.errorDiffCount).toBe(1)
			expect(
				res.diffs.find((d) => d.dishName === 'Garlic Bread')?.changedInPos,
			).toBe(true)
			expect(
				res.diffs.find((d) => d.dishName === 'Margherita Pizza')?.changedInPos,
			).toBe(false)
		}
	})

	it('fixDeliveryMenuByPushing pushes Menuza menu and resolves diffs (direct and via #74 outbox)', async () => {
		flags.on.add(INTEGRATION_FLAG_KEYS.menuCheck)
		const { organization, delivery } = await seedDeliveryFixture({
			provider: 'ubereats',
		})

		const before = await runDeliveryMenuCheck(delivery.id, organization.id, {
			trigger: 'manual',
		})
		expect(before.ok).toBe(true)
		expect(before.ok && before.errorDiffCount).toBeGreaterThan(0)

		// Enable auto_sync to prove #74 outbox path works too
		flags.on.add(INTEGRATION_FLAG_KEYS.autoSync)
		const fix = await fixDeliveryMenuByPushing(delivery.id, organization.id)
		expect(fix.ok).toBe(true)

		const outboxRows = await db
			.select()
			.from(MenuSyncOutbox)
			.where(eq(MenuSyncOutbox.integrationId, delivery.id))
		expect(outboxRows.length).toBeGreaterThan(0)
		expect(outboxRows[0]!.status).toBe('sent')

		// Subsequent check matches 0 diffs!
		const after = await runDeliveryMenuCheck(delivery.id, organization.id, {
			trigger: 'manual',
		})
		expect(after.ok).toBe(true)
		if (after.ok) {
			expect(after.errorDiffCount).toBe(0)
			expect(after.totalDiffCount).toBe(0)
			expect(after.menuCheck.lastStatus).toBe('match')
		}

		// Verify latest integration log history includes both menu_check and pos_push
		const allLogs = await db
			.select()
			.from(IntegrationLog)
			.where(eq(IntegrationLog.integrationId, delivery.id))
			.orderBy(desc(IntegrationLog.createdAt))
		expect(allLogs.some((l) => l.action === 'menu_check')).toBe(true)
		expect(allLogs.some((l) => l.action === 'pos_push')).toBe(true)
	})
})
