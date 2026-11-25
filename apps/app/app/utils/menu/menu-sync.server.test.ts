import {
	and,
	db,
	eq,
	Integration,
	IntegrationLog,
	MenuSyncOutbox,
	Notification,
	OrganizationLocation,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuLocationOverride,
	OrganizationMenuModifierGroup,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationMenuOption,
	OrganizationMenuPosLink,
} from '@repo/database'
import {
	createAdapter,
	importCatalog,
	merchantIds,
	parsePosConfig,
	pushMenu,
	resolveTransport,
	sandboxUrls,
	type PosProvider,
} from '@repo/integrations'
import {
	posSandboxHandlers,
	resetPosSandbox,
} from '@repo/integrations/pos/sandbox'
import { http, HttpResponse } from 'msw'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loader as integrationsLoader } from '#app/routes/_app+/$orgSlug_+/settings+/integrations.tsx'
import { action as menuSyncJobAction } from '#app/routes/resources+/jobs.menu-sync.ts'
import { INTEGRATION_FLAG_KEYS } from '#app/utils/integrations/flags.server.ts'
import { MENU_SYNC_FAILING_NOTIFICATION_TYPE } from '#app/utils/integrations/sync-alerts.ts'
import { server } from '#tests/mocks/index.ts'
import {
	createAuthenticatedRequest,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { applyBulkItemEdit } from './bulk-apply.server.ts'
import { applyMenuAvailability } from './location-availability.server.ts'
import {
	computeMenuSyncBackoffMs,
	drainMenuSyncOutbox,
	enqueueMenuSync,
	MENU_PUSH_MIN_INTERVAL_MS,
} from './menu-sync.server.ts'
import {
	setMenuItemAvailability,
	updateMenuItemText,
} from './menu-updates.server.ts'
import { overridePosField } from './pos-ownership.server.ts'

const flags = vi.hoisted(() => ({ on: new Set<string>() }))
vi.mock('@repo/common/feature-flags', () => ({
	getFeatureFlag: vi.fn(async (key: string) =>
		flags.on.has(key) ? true : false,
	),
}))

const purge = vi.hoisted(() => vi.fn(async () => true))
vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: purge,
}))

const snapshotStore = vi.hoisted(() => new Map<string, string>())
vi.mock(
	'#app/utils/storage.server.ts',
	async (importOriginal: () => Promise<Record<string, unknown>>) => ({
		...(await importOriginal()),
		uploadMenuSnapshotJson: vi.fn(
			async (orgId: string, snapshotId: string, body: string) => {
				const key = `menu-snapshots/${orgId}/${snapshotId}.json`
				snapshotStore.set(key, body)
				return key
			},
		),
		readMenuSnapshotJson: vi.fn(
			async (contentKey: string) => snapshotStore.get(contentKey) ?? null,
		),
	}),
)

function sandboxAdapterFor(provider: PosProvider, integrationId: string) {
	return createAdapter(
		provider,
		resolveTransport(provider, integrationId, {
			environment: 'sandbox',
			merchantId: merchantIds[provider],
		}),
	)
}

async function createSandboxIntegration(
	organizationId: string,
	locationId: string,
	providerName: PosProvider,
	extraConfig: Record<string, unknown> = {},
) {
	const [integration] = await db
		.insert(Integration)
		.values({
			organizationId,
			organizationLocationId: locationId,
			providerName,
			providerType:
				providerName === 'doordash' || providerName === 'ubereats'
					? 'delivery'
					: 'pos',
			isActive: true,
			config: JSON.stringify({
				environment: 'sandbox',
				merchantId: merchantIds[providerName],
				...extraConfig,
			}),
		})
		.returning()
	return integration!
}

async function seedOrgWithMenu(options?: { secondLocation?: boolean }) {
	const ctx = await setupTestOrgWithUser('admin')
	const [locationA] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: ctx.organization.id,
			name: 'Downtown',
			slug: `downtown-${Math.random().toString(36).slice(2, 8)}`,
			isDefault: true,
		})
		.returning()

	let locationB: typeof OrganizationLocation.$inferSelect | null = null
	if (options?.secondLocation) {
		const [createdB] = await db
			.insert(OrganizationLocation)
			.values({
				organizationId: ctx.organization.id,
				name: 'Uptown',
				slug: `uptown-${Math.random().toString(36).slice(2, 8)}`,
				isDefault: false,
			})
			.returning()
		locationB = createdB!
	}

	const [menu] = await db
		.insert(OrganizationMenu)
		.values({
			organizationId: ctx.organization.id,
			displayName: 'All Day',
			position: 0,
		})
		.returning()

	const [category] = await db
		.insert(OrganizationMenuCategory)
		.values({
			organizationId: ctx.organization.id,
			displayName: 'Mains',
			position: 0,
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
			organizationId: ctx.organization.id,
			displayName: 'Margherita Pizza',
			description: 'San Marzano tomato, mozzarella, basil',
			price: 12.99,
			availabilityStatus: 'available',
			position: 0,
		})
		.returning()

	const [item2] = await db
		.insert(OrganizationMenuItem)
		.values({
			organizationId: ctx.organization.id,
			displayName: 'Truffle Fries',
			description: 'Parmesan and herbs',
			price: 8.5,
			availabilityStatus: 'available',
			position: 1,
		})
		.returning()

	await db.insert(OrganizationMenuItemCategoryAssignment).values([
		{ categoryId: category!.id, itemId: item1!.id, position: 0 },
		{ categoryId: category!.id, itemId: item2!.id, position: 1 },
	])

	const [group] = await db
		.insert(OrganizationMenuModifierGroup)
		.values({
			organizationId: ctx.organization.id,
			name: 'Toppings',
			selectionType: 'multiple',
			minSelections: 0,
			maxSelections: 2,
			position: 0,
		})
		.returning()

	const [option] = await db
		.insert(OrganizationMenuOption)
		.values({
			organizationId: ctx.organization.id,
			displayName: 'Extra Cheese',
			price: 1.5,
			availabilityStatus: 'available',
			position: 0,
		})
		.returning()

	await db.insert(OrganizationMenuItemModifierGroupAssignment).values({
		itemId: item1!.id,
		modifierGroupId: group!.id,
		position: 0,
	})
	await db.insert(OrganizationMenuModifierGroupOptionAssignment).values({
		modifierGroupId: group!.id,
		optionId: option!.id,
		position: 0,
	})

	return {
		...ctx,
		locationA: locationA!,
		locationB,
		menu: menu!,
		category: category!,
		item1: item1!,
		item2: item2!,
		group: group!,
		option: option!,
	}
}

const workflowWakes = vi.hoisted(() => [] as string[])

beforeEach(() => {
	delete process.env.MENU_AUTO_SYNC_ENABLED
	workflowWakes.length = 0
	flags.on.clear()
	flags.on.add(INTEGRATION_FLAG_KEYS.autoSync)
	purge.mockClear()
	resetPosSandbox()
	server.use(
		...posSandboxHandlers,
		http.post('*/workflows/menu-sync/start', async ({ request }) => {
			const body = (await request.json().catch(() => ({}))) as {
				runAt?: string
			}
			if (body.runAt) workflowWakes.push(body.runAt)
			return HttpResponse.json({ success: true, instanceId: 'ms-1' })
		}),
		http.post('*/workflows/operator-alerts/start', () =>
			HttpResponse.json({ success: true, instanceId: 'oa-1' }),
		),
	)
})

afterEach(() => {
	delete process.env.MENU_AUTO_SYNC_ENABLED
	resetPosSandbox()
})

describe('Automatic POS & delivery menu sync per location (#74)', () => {
	it('AC #1: marking a dish unavailable by hand, in bulk, or via inventory auto sold out sends availability updates to connected platforms within a minute (sandbox)', async () => {
		const { organization, user, locationA, menu, item1, item2 } =
			await seedOrgWithMenu()

		const doorDash = await createSandboxIntegration(
			organization.id,
			locationA.id,
			'doordash',
		)
		const uberEats = await createSandboxIntegration(
			organization.id,
			locationA.id,
			'ubereats',
		)
		const toast = await createSandboxIntegration(
			organization.id,
			locationA.id,
			'toast',
		)

		// Push initial menu to DoorDash & Uber Eats, and link item1/item2 to Toast's seeded sandbox items
		await pushMenu(doorDash.id, organization.id, menu.id, {
			respectPosOwnership: false,
		})
		await pushMenu(uberEats.id, organization.id, menu.id, {
			respectPosOwnership: false,
		})
		await db.insert(OrganizationMenuPosLink).values([
			{
				organizationId: organization.id,
				integrationId: toast.id,
				providerName: 'toast',
				entityType: 'item',
				remoteId: 'main-1',
				localId: item1.id,
			},
			{
				organizationId: organization.id,
				integrationId: toast.id,
				providerName: 'toast',
				entityType: 'item',
				remoteId: 'main-2',
				localId: item2.id,
			},
		])

		const t0 = new Date()

		// 1) Manual sold out (by hand / Station / Dashboard)
		const changedByHand = await applyMenuAvailability({
			organizationId: organization.id,
			locationId: locationA.id,
			change: { entityType: 'item', entityId: item1.id, available: false },
			by: 'hand',
		})
		expect(changedByHand).toBe(true)

		// Queued immediately (nextAttemptAt <= t0 + 60s)
		const queuedRows = await db
			.select()
			.from(MenuSyncOutbox)
			.where(
				and(
					eq(MenuSyncOutbox.organizationId, organization.id),
					eq(MenuSyncOutbox.status, 'queued'),
				),
			)
		expect(queuedRows).toHaveLength(3)
		for (const row of queuedRows) {
			expect(row.kind).toBe('availability')
			expect(row.nextAttemptAt.getTime()).toBeLessThanOrEqual(
				t0.getTime() + 60_000,
			)
		}

		const drain1 = await drainMenuSyncOutbox({
			organizationId: organization.id,
		})
		expect(drain1.availabilitySent).toBe(3)

		const ddCatalog1 = await sandboxAdapterFor('doordash', doorDash.id).read()
		const uberCatalog1 = await sandboxAdapterFor('ubereats', uberEats.id).read()
		const toastCatalog1 = await sandboxAdapterFor('toast', toast.id).read()
		expect(ddCatalog1.items.find((i) => i.id === item1.id)?.available).toBe(
			false,
		)
		expect(uberCatalog1.items.find((i) => i.id === item1.id)?.available).toBe(
			false,
		)
		expect(toastCatalog1.items.find((i) => i.id === 'main-1')?.available).toBe(
			false,
		)

		// 2) Inventory auto sold out (`by: 'stock'`) on item2, then stock restore
		const stockSince = Date.now()
		const changedByStock = await applyMenuAvailability({
			organizationId: organization.id,
			locationId: locationA.id,
			change: { entityType: 'item', entityId: item2.id, available: false },
			by: 'stock',
		})
		expect(changedByStock).toBe(true)
		const drain2 = await drainMenuSyncOutbox({
			organizationId: organization.id,
		})
		expect(drain2.availabilitySent).toBe(3)
		expect(
			(await sandboxAdapterFor('doordash', doorDash.id).read()).items.find(
				(i) => i.id === item2.id,
			)?.available,
		).toBe(false)
		expect(
			(await sandboxAdapterFor('toast', toast.id).read()).items.find(
				(i) => i.id === 'main-2',
			)?.available,
		).toBe(false)

		// Restore item1 by hand & item2 by stock so we can test bulk sold-out edit
		await applyMenuAvailability({
			organizationId: organization.id,
			locationId: locationA.id,
			change: { entityType: 'item', entityId: item1.id, available: true },
			by: 'hand',
		})
		await applyMenuAvailability({
			organizationId: organization.id,
			locationId: locationA.id,
			change: {
				entityType: 'item',
				entityId: item2.id,
				available: true,
				since: stockSince,
			},
			by: 'stock',
		})
		await drainMenuSyncOutbox({ organizationId: organization.id })
		expect(
			(await sandboxAdapterFor('doordash', doorDash.id).read()).items.find(
				(i) => i.id === item1.id,
			)?.available,
		).toBe(true)

		// 3) Bulk availability edit marking both items unavailable at locationA
		const freshItems = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.organizationId, organization.id))
		const expectedUpdatedAt = Object.fromEntries(
			freshItems.map((row) => [row.id, row.updatedAt.toISOString()]),
		)
		const bulkRes = await applyBulkItemEdit({
			organizationId: organization.id,
			organizationSlug: organization.slug,
			userId: user.id,
			itemIds: [item1.id, item2.id],
			locationId: locationA.id,
			operation: {
				type: 'availability',
				status: 'unavailable',
				unavailableUntil: null,
			},
			expectedUpdatedAt,
		})
		expect(bulkRes.status).toBe(200)

		const drain3 = await drainMenuSyncOutbox({
			organizationId: organization.id,
		})
		expect(drain3.availabilitySent).toBe(6)
		expect(
			(await sandboxAdapterFor('doordash', doorDash.id).read()).items.find(
				(i) => i.id === item1.id,
			)?.available,
		).toBe(false)
		expect(
			(await sandboxAdapterFor('ubereats', uberEats.id).read()).items.find(
				(i) => i.id === item2.id,
			)?.available,
		).toBe(false)
		expect(
			(await sandboxAdapterFor('toast', toast.id).read()).items.find(
				(i) => i.id === 'main-1',
			)?.available,
		).toBe(false)

		// 4) Global dish availability write via setMenuItemAvailability (after clearing locationA overrides)
		await db
			.delete(OrganizationMenuLocationOverride)
			.where(
				eq(OrganizationMenuLocationOverride.organizationId, organization.id),
			)
		await setMenuItemAvailability({
			organization: { id: organization.id, slug: organization.slug },
			userId: user.id,
			itemId: item1.id,
			availability: {
				availabilityStatus: 'available',
				unavailableUntil: null,
			},
			reason: 'back_in_stock',
		})
		const drain4 = await drainMenuSyncOutbox({
			organizationId: organization.id,
		})
		expect(drain4.availabilitySent).toBe(3)
		expect(
			(await sandboxAdapterFor('doordash', doorDash.id).read()).items.find(
				(i) => i.id === item1.id,
			)?.available,
		).toBe(true)
		expect(workflowWakes.length).toBeGreaterThan(0)

		// Verify IntegrationLog entries carry no tokens or credentials
		const logs = await db
			.select()
			.from(IntegrationLog)
			.where(eq(IntegrationLog.integrationId, doorDash.id))
		expect(logs.some((l) => l.action === 'pos_availability')).toBe(true)
		for (const log of logs) {
			expect(log.requestData ?? '').not.toContain('sandbox-token')
			expect(log.requestData ?? '').not.toContain('Bearer')
		}
	})

	it('AC #2: pushes per-location price overrides and omits disabled (isEnabled = false) items/options per location', async () => {
		const { organization, locationA, locationB, menu, item1, item2, option } =
			await seedOrgWithMenu({ secondLocation: true })

		const ddLocA = await createSandboxIntegration(
			organization.id,
			locationA.id,
			'doordash',
		)
		const uberLocB = await createSandboxIntegration(
			organization.id,
			locationB!.id,
			'ubereats',
		)

		// At Location A: override item1 price to $16.50, option price to $2.25, and hide item2 (isEnabled: false)
		await db.insert(OrganizationMenuLocationOverride).values([
			{
				organizationId: organization.id,
				locationId: locationA.id,
				entityType: 'item',
				entityId: item1.id,
				isEnabled: true,
				price: 16.5,
			},
			{
				organizationId: organization.id,
				locationId: locationA.id,
				entityType: 'modifier_option',
				entityId: option.id,
				isEnabled: true,
				price: 2.25,
			},
			{
				organizationId: organization.id,
				locationId: locationA.id,
				entityType: 'item',
				entityId: item2.id,
				isEnabled: false,
			},
		])

		await enqueueMenuSync(organization.id, {
			kind: 'menu',
			entityType: 'all',
			menuId: menu.id,
		})
		const drained = await drainMenuSyncOutbox({
			organizationId: organization.id,
		})
		expect(drained.menuSent).toBe(2)

		// Location A (DoorDash) gets $16.50 (1650 cents), option $2.25 (225 cents), and item2 is omitted!
		const locACatalog = await sandboxAdapterFor('doordash', ddLocA.id).read()
		expect(locACatalog.items.map((i) => i.id)).toEqual([item1.id])
		const locAPizza = locACatalog.items[0]!
		expect(locAPizza.price).toBe(1650)
		expect(locAPizza.modifierGroups[0]?.options[0]?.price).toBe(225)

		// Location B (Uber Eats) keeps base $12.99 (1299 cents), option $1.50 (150 cents), and includes item2!
		const locBCatalog = await sandboxAdapterFor('ubereats', uberLocB.id).read()
		expect(locBCatalog.items.map((i) => i.id).sort()).toEqual(
			[item1.id, item2.id].sort(),
		)
		const locBPizza = locBCatalog.items.find((i) => i.id === item1.id)!
		expect(locBPizza.price).toBe(1299)
		expect(locBPizza.modifierGroups[0]?.options[0]?.price).toBe(150)
	})

	it('AC #3: ten quick edits coalesce into ONE menu push, and subsequent bursts throttle to at most every 15 minutes (+ nightly job)', async () => {
		const { organization, user, locationA, item1, item2 } =
			await seedOrgWithMenu()

		const doorDash = await createSandboxIntegration(
			organization.id,
			locationA.id,
			'doordash',
		)
		// Also connect Toast to verify Toast does NOT get queued for full-menu edits
		await createSandboxIntegration(organization.id, locationA.id, 'toast')

		let menuPutCalls = 0
		server.use(
			http.put(
				`${sandboxUrls.doordash}/api/v1/stores/${merchantIds.doordash}/menus`,
				async ({ request }) => {
					if (request.headers.get('x-pos-store') === doorDash.id) {
						menuPutCalls++
					}
					const body = (await request.json()) as { base_version?: number }
					return HttpResponse.json(
						{
							job_id: `DD_JOB_COALESCE_${menuPutCalls}_${body.base_version ?? 0}`,
							status: 'PROCESSING',
						},
						{ status: 202, headers: { 'x-pos-sandbox': 'true' } },
					)
				},
			),
		)

		// Fire 10 rapid menu edits across dishes, text, categories, and options
		for (let i = 1; i <= 10; i++) {
			await updateMenuItemText({
				organization: { id: organization.id, slug: organization.slug },
				userId: user.id,
				itemId: i % 2 === 0 ? item1.id : item2.id,
				changes: [
					{
						field: 'description',
						locale: 'en',
						value: `Freshly baked edit #${i}`,
					},
				],
				defaultLocale: 'en',
				reason: 'manual_edit',
			})
		}

		const t0 = new Date(Date.now() + 1_000)

		const queuedBeforeDrain = await db
			.select()
			.from(MenuSyncOutbox)
			.where(
				and(
					eq(MenuSyncOutbox.organizationId, organization.id),
					eq(MenuSyncOutbox.status, 'queued'),
				),
			)
		// Coalesced onto ONE single queued row for DoorDash (0 for Toast!)
		expect(queuedBeforeDrain).toHaveLength(1)
		expect(queuedBeforeDrain[0]).toMatchObject({
			integrationId: doorDash.id,
			kind: 'menu',
			entityType: 'all',
			entityId: '',
		})

		const drainResult = await drainMenuSyncOutbox({
			organizationId: organization.id,
			now: t0,
		})
		expect(drainResult.menuSent).toBe(1)
		expect(menuPutCalls).toBe(1)

		// Editing again 2 minutes later schedules nextAttemptAt at t0 + 15 minutes
		const twoMinLater = new Date(t0.getTime() + 2 * 60_000)
		for (let i = 0; i < 5; i++) {
			await enqueueMenuSync(organization.id, {
				kind: 'menu',
				entityType: 'item',
				entityId: item1.id,
				now: twoMinLater,
			})
		}
		const throttledRows = await db
			.select()
			.from(MenuSyncOutbox)
			.where(
				and(
					eq(MenuSyncOutbox.integrationId, doorDash.id),
					eq(MenuSyncOutbox.status, 'queued'),
				),
			)
		expect(throttledRows).toHaveLength(1)
		expect(throttledRows[0]!.nextAttemptAt.getTime()).toBe(
			t0.getTime() + MENU_PUSH_MIN_INTERVAL_MS,
		)

		// Draining at t0 + 5 minutes sends nothing because the 15-minute window hasn't elapsed
		const earlyDrain = await drainMenuSyncOutbox({
			organizationId: organization.id,
			now: new Date(t0.getTime() + 5 * 60_000),
		})
		expect(earlyDrain.menuSent).toBe(0)
		expect(menuPutCalls).toBe(1)

		// Draining at t0 + 15 minutes sends the single coalesced push
		const dueDrain = await drainMenuSyncOutbox({
			organizationId: organization.id,
			now: new Date(t0.getTime() + MENU_PUSH_MIN_INTERVAL_MS),
		})
		expect(dueDrain.menuSent).toBe(1)
		expect(menuPutCalls).toBe(2)

		// Nightly `/resources/jobs/menu-sync?nightly=1` endpoint requires internal auth and triggers nightly delivery push
		const jobUrl = new URL(
			'http://localhost/resources/jobs/menu-sync?nightly=1',
		)
		await expect(
			menuSyncJobAction({
				request: new Request(jobUrl, { method: 'POST' }),
				params: {},
				context: new RouterContextProvider(),
				url: jobUrl,
				pattern: '/resources/jobs/menu-sync',
			}),
		).rejects.toMatchObject({ status: 401 })

		const nightlyRes = await menuSyncJobAction({
			request: new Request(jobUrl, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}`,
				},
			}),
			params: {},
			context: new RouterContextProvider(),
			url: jobUrl,
			pattern: '/resources/jobs/menu-sync',
		})
		expect(nightlyRes.status).toBe(200)
		const nightlyJson = (await nightlyRes.json()) as {
			success: boolean
			nightlyQueued: number
			menuSent: number
		}
		expect(nightlyJson.success).toBe(true)
		expect(nightlyJson.nightlyQueued).toBeGreaterThanOrEqual(1)
		expect(menuPutCalls).toBe(3)
	})

	it('AC #4: retries failing platform with 30s..1h backoff (and 429 Retry-After), marks "Sync failing" + notifies manager after 24h, and clears on recovery', async () => {
		// Verify exact exponential backoff curve: 30s -> 60s -> 120s -> ... -> 3600s cap + 429 Retry-After
		expect(computeMenuSyncBackoffMs(1)).toBe(30_000)
		expect(computeMenuSyncBackoffMs(2)).toBe(60_000)
		expect(computeMenuSyncBackoffMs(3)).toBe(120_000)
		expect(computeMenuSyncBackoffMs(8)).toBe(3_600_000)
		expect(computeMenuSyncBackoffMs(12)).toBe(3_600_000)
		expect(computeMenuSyncBackoffMs(1, 240)).toBe(240_000)

		const { organization, user, cookie, locationA } = await seedOrgWithMenu()
		const doorDash = await createSandboxIntegration(
			organization.id,
			locationA.id,
			'doordash',
		)

		let failureMode: '429' | '503' | 'ok' = '429'
		server.use(
			http.put(
				`${sandboxUrls.doordash}/api/v1/stores/${merchantIds.doordash}/menus`,
				async () => {
					if (failureMode === '429') {
						return new HttpResponse('Rate limited', {
							status: 429,
							headers: {
								'x-pos-sandbox': 'true',
								'Retry-After': '180',
							},
						})
					}
					if (failureMode === '503') {
						return HttpResponse.json(
							{ message: 'Upstream down' },
							{ status: 503, headers: { 'x-pos-sandbox': 'true' } },
						)
					}
					return HttpResponse.json(
						{ job_id: 'DD_RECOVERED', status: 'PROCESSING' },
						{ status: 202, headers: { 'x-pos-sandbox': 'true' } },
					)
				},
			),
		)

		const t0 = new Date('2026-11-24T00:00:00.000Z')
		await enqueueMenuSync(organization.id, {
			kind: 'menu',
			entityType: 'all',
			now: t0,
		})

		// Attempt 1 at t0: hits 429 with Retry-After: 180s (> 30s base backoff)
		const attempt1 = await drainMenuSyncOutbox({
			organizationId: organization.id,
			now: t0,
		})
		expect(attempt1.menuFailed).toBe(1)
		expect(attempt1.alerted).toBe(0)

		const [outboxAfter1] = await db
			.select()
			.from(MenuSyncOutbox)
			.where(eq(MenuSyncOutbox.integrationId, doorDash.id))
		expect(outboxAfter1!.attempts).toBe(1)
		expect(outboxAfter1!.firstFailedAt?.getTime()).toBe(t0.getTime())
		expect(outboxAfter1!.nextAttemptAt.getTime()).toBe(t0.getTime() + 180_000)

		// Attempt 2 at t0 + 3m: hits 503 -> attempt 2 backoff = 60s, still < 24h so NOT Sync failing yet
		failureMode = '503'
		const t2 = new Date(t0.getTime() + 180_000)
		const attempt2 = await drainMenuSyncOutbox({
			organizationId: organization.id,
			now: t2,
		})
		expect(attempt2.menuFailed).toBe(1)
		expect(attempt2.alerted).toBe(0)

		const [outboxAfter2] = await db
			.select()
			.from(MenuSyncOutbox)
			.where(eq(MenuSyncOutbox.integrationId, doorDash.id))
		expect(outboxAfter2!.attempts).toBe(2)
		expect(outboxAfter2!.nextAttemptAt.getTime()).toBe(t2.getTime() + 60_000)

		// Before 24h: no manager Notification yet, and integrations loader has syncFailing = false
		const earlyNotifs = await db
			.select()
			.from(Notification)
			.where(
				and(
					eq(Notification.organizationId, organization.id),
					eq(Notification.type, MENU_SYNC_FAILING_NOTIFICATION_TYPE),
				),
			)
		expect(earlyNotifs).toHaveLength(0)

		// At t0 + 24h + 1m: continuous failure crosses 24 hours -> marks "Sync failing" & notifies manager!
		const t24h = new Date(t0.getTime() + 24 * 3600_000 + 60_000)
		const attempt24h = await drainMenuSyncOutbox({
			organizationId: organization.id,
			now: t24h,
		})
		expect(attempt24h.menuFailed).toBe(1)
		expect(attempt24h.alerted).toBe(1)

		const managerNotifs = await db
			.select()
			.from(Notification)
			.where(
				and(
					eq(Notification.organizationId, organization.id),
					eq(Notification.userId, user.id),
					eq(Notification.type, MENU_SYNC_FAILING_NOTIFICATION_TYPE),
				),
			)
		expect(managerNotifs).toHaveLength(1)
		expect(JSON.parse(managerNotifs[0]!.payload)).toMatchObject({
			orgSlug: organization.slug,
			integrationId: doorDash.id,
			providerLabel: 'DoorDash',
		})

		// Subsequent failure at t0 + 26h does NOT duplicate the manager alert
		const t26h = new Date(t0.getTime() + 26 * 3600_000)
		const attempt26h = await drainMenuSyncOutbox({
			organizationId: organization.id,
			now: t26h,
		})
		expect(attempt26h.alerted).toBe(0)
		const notifsAfterRetry = await db
			.select()
			.from(Notification)
			.where(
				and(
					eq(Notification.organizationId, organization.id),
					eq(Notification.type, MENU_SYNC_FAILING_NOTIFICATION_TYPE),
				),
			)
		expect(notifsAfterRetry).toHaveLength(1)

		// Settings > Integrations loader exposes syncFailing: true for the "Sync failing" badge
		const integrationsUrl = `https://app.test/${organization.slug}/settings/integrations?locationId=${locationA.id}`
		const loaderDataFailing = await integrationsLoader({
			request: createAuthenticatedRequest(integrationsUrl, {}, cookie),
			params: { orgSlug: organization.slug },
			context: new RouterContextProvider(),
			url: new URL(integrationsUrl),
			pattern: '/:orgSlug/settings/integrations',
		})
		const ddCardFailing = loaderDataFailing.integrations.find(
			(i) => i.id === doorDash.id,
		)
		expect(ddCardFailing?.syncFailing).toBe(true)
		expect(ddCardFailing?.lastSyncError).toContain('temporarily unavailable')

		// Once platform recovers, retry succeeds and clears syncFailing!
		failureMode = 'ok'
		const t28h = new Date(t0.getTime() + 28 * 3600_000)
		const recoveredDrain = await drainMenuSyncOutbox({
			organizationId: organization.id,
			now: t28h,
		})
		expect(recoveredDrain.menuSent).toBe(1)

		const [recoveredIntegration] = await db
			.select()
			.from(Integration)
			.where(eq(Integration.id, doorDash.id))
		const recoveredConfig = parsePosConfig(recoveredIntegration!.config)
		expect(recoveredConfig.syncHealth?.firstFailedAt).toBeNull()
		expect(recoveredConfig.syncHealth?.alertedAt).toBeNull()
	})

	it('Edge cases: Toast receives availability ONLY; POS-owned fields (#93) are never pushed back to that POS; failing menu push never delays availability', async () => {
		flags.on.add(INTEGRATION_FLAG_KEYS.posOwnership)
		const { organization, user, locationA, item1 } = await seedOrgWithMenu()

		// 1) Square POS where Square owns price & available, while description is overridden via "Use my own"
		const square = await createSandboxIntegration(
			organization.id,
			locationA.id,
			'square',
		)
		const imported = await importCatalog(square.id, organization.id)
		expect(imported.created).toBeGreaterThan(0)

		const [squareLink] = await db
			.select()
			.from(OrganizationMenuPosLink)
			.where(
				and(
					eq(OrganizationMenuPosLink.integrationId, square.id),
					eq(OrganizationMenuPosLink.entityType, 'item'),
				),
			)
			.limit(1)
		const linkedLocalId = squareLink!.localId
		const remoteSquareId = squareLink!.remoteId
		const squareBefore = (
			await sandboxAdapterFor('square', square.id).read()
		).items.find((i) => i.id === remoteSquareId)!

		// Override description locally ("Use my own"), while price & available remain Square-owned
		const ovRes = await overridePosField({
			organization: { id: organization.id, slug: organization.slug },
			userId: user.id,
			entityType: 'item',
			entityId: linkedLocalId,
			field: 'description',
		})
		expect(ovRes.ok).toBe(true)

		// Mutate local DB description AND price/availability directly to prove Square NEVER receives POS-owned price or available!
		await db
			.update(OrganizationMenuItem)
			.set({
				description: 'House-written Menuza description',
				price: 99.99,
				availabilityStatus: 'unavailable',
			})
			.where(eq(OrganizationMenuItem.id, linkedLocalId))

		// Enqueue availability for linkedLocalId: Square owns available, so Square gets 0 availability rows!
		const sqAvailEnq = await enqueueMenuSync(organization.id, {
			kind: 'availability',
			entityType: 'item',
			entityId: linkedLocalId,
			available: false,
		})
		expect(sqAvailEnq.integrationIds).not.toContain(square.id)

		// Enqueue menu push: Square receives overridden description ONLY while Square's price & available stay untouched!
		await enqueueMenuSync(organization.id, {
			kind: 'menu',
			entityType: 'all',
			immediate: true,
		})
		await drainMenuSyncOutbox({ organizationId: organization.id })

		const squareAfter = (
			await sandboxAdapterFor('square', square.id).read()
		).items.find((i) => i.id === remoteSquareId)!
		expect(squareAfter.description).toBe('House-written Menuza description')
		expect(squareAfter.price).toBe(squareBefore.price)
		expect(squareAfter.available).toBe(squareBefore.available)

		// 2) Toast with available owned by Menuza receives availability ONLY, and failing DoorDash menu push NEVER delays availability!
		const toast = await createSandboxIntegration(
			organization.id,
			locationA.id,
			'toast',
			{ fieldOwnership: { available: 'menuza' } },
		)
		await db.insert(OrganizationMenuPosLink).values({
			organizationId: organization.id,
			integrationId: toast.id,
			providerName: 'toast',
			entityType: 'item',
			remoteId: 'starter-1',
			localId: item1.id,
		})
		const doorDash = await createSandboxIntegration(
			organization.id,
			locationA.id,
			'doordash',
		)
		// Seed item1 on DoorDash first, then make DoorDash PUT /menus fail with 503 while PATCH /items/status stays healthy!
		await pushMenu(
			doorDash.id,
			organization.id,
			(
				await db
					.select({ id: OrganizationMenu.id })
					.from(OrganizationMenu)
					.where(eq(OrganizationMenu.organizationId, organization.id))
					.limit(1)
			)[0]!.id,
		)

		server.use(
			http.put(
				`${sandboxUrls.doordash}/api/v1/stores/${merchantIds.doordash}/menus`,
				() =>
					HttpResponse.json(
						{ message: 'Menu ingestion outage' },
						{ status: 503, headers: { 'x-pos-sandbox': 'true' } },
					),
			),
		)

		const now = new Date()
		// Queue both a failing full-menu push AND an availability update
		const menuEnq = await enqueueMenuSync(organization.id, {
			kind: 'menu',
			entityType: 'all',
			immediate: true,
			now,
		})
		expect(menuEnq.integrationIds).not.toContain(toast.id)
		expect(menuEnq.integrationIds).toContain(doorDash.id)

		const availEnq = await enqueueMenuSync(organization.id, {
			kind: 'availability',
			entityType: 'item',
			entityId: item1.id,
			available: false,
			now,
		})
		expect(availEnq.integrationIds).toContain(toast.id)
		expect(availEnq.integrationIds).toContain(doorDash.id)

		const mixedDrain = await drainMenuSyncOutbox({
			organizationId: organization.id,
			now,
		})
		// Full menu push failed on DoorDash, yet availability succeeded on BOTH DoorDash and Toast immediately!
		expect(mixedDrain.menuFailed).toBeGreaterThanOrEqual(1)
		expect(mixedDrain.availabilitySent).toBe(2)

		expect(
			(await sandboxAdapterFor('toast', toast.id).read()).items.find(
				(i) => i.id === 'starter-1',
			)?.available,
		).toBe(false)
		expect(
			(await sandboxAdapterFor('doordash', doorDash.id).read()).items.find(
				(i) => i.id === item1.id,
			)?.available,
		).toBe(false)
	})
})
