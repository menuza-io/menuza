import { auditService, AuditAction } from '@repo/audit'
import {
	and,
	db,
	eq,
	Integration,
	OrganizationLocation,
	OrganizationMenuItem,
	OrganizationMenuModifierGroup,
	OrganizationMenuOption,
	OrganizationMenuPosLink,
} from '@repo/database'
import {
	createAdapter,
	importCatalog,
	merchantIds,
	parsePosValues,
	resolveTransport,
} from '@repo/integrations'
import {
	posSandboxHandlers,
	resetPosSandbox,
} from '@repo/integrations/pos/sandbox'
import { RouterContextProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	action as itemAction,
	loader as itemLoader,
} from '#app/routes/_app+/$orgSlug_+/menu+/items.$itemId.tsx'
import {
	action as itemsIndexAction,
	loader as itemsIndexLoader,
} from '#app/routes/_app+/$orgSlug_+/menu+/items._index.tsx'
import { action as modifierGroupAction } from '#app/routes/_app+/$orgSlug_+/menu+/modifiers.$modifierGroupId.tsx'
import { action as optionAction } from '#app/routes/_app+/$orgSlug_+/menu+/options.$optionId.tsx'
import { action as suggestionsAction } from '#app/routes/_app+/$orgSlug_+/menu+/suggestions.ts'
import {
	action as integrationsAction,
	loader as integrationsLoader,
} from '#app/routes/_app+/$orgSlug_+/settings+/integrations.tsx'
import { INTEGRATION_FLAG_KEYS } from '#app/utils/integrations/flags.server.ts'
import { server } from '#tests/mocks/index.ts'
import {
	createAuthenticatedRequest,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { applyBulkItemDelete, applyBulkItemEdit } from './bulk-apply.server.ts'
import { lockedFieldsForOne } from './pos-ownership.server.ts'

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

beforeEach(() => {
	flags.on.clear()
	flags.on.add(INTEGRATION_FLAG_KEYS.posOwnership)
	purge.mockClear()
	resetPosSandbox()
	server.use(...posSandboxHandlers)
})

afterEach(() => {
	resetPosSandbox()
})

async function setupSquareOrg() {
	const ctx = await setupTestOrgWithUser('admin')
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: ctx.organization.id,
			name: 'Downtown',
			slug: `downtown-${Math.random().toString(36).slice(2, 8)}`,
			isDefault: true,
		})
		.returning()

	const [integration] = await db
		.insert(Integration)
		.values({
			organizationId: ctx.organization.id,
			organizationLocationId: location!.id,
			providerName: 'square',
			providerType: 'pos',
			isActive: true,
			config: JSON.stringify({
				environment: 'sandbox',
				merchantId: merchantIds.square,
			}),
		})
		.returning()

	return {
		...ctx,
		location: location!,
		integration: integration!,
	}
}

function squareAdapterFor(integrationId: string) {
	return createAdapter(
		'square',
		resolveTransport('square', integrationId, {
			environment: 'sandbox',
			merchantId: merchantIds.square,
		}),
	)
}

describe('POS field ownership, 409 guards, overrides & catalog re-import (#93)', () => {
	it('AC #1 & #2: locks Square-owned price in loader, refuses direct POST changing price or location override with 409 field_owned_by_pos, and allows unowned field edits', async () => {
		const { organization, location, integration, cookie } =
			await setupSquareOrg()
		const imported = await importCatalog(integration.id, organization.id)
		expect(imported.created).toBeGreaterThan(0)

		const [pizzaLink] = await db
			.select()
			.from(OrganizationMenuPosLink)
			.where(
				and(
					eq(OrganizationMenuPosLink.integrationId, integration.id),
					eq(OrganizationMenuPosLink.entityType, 'item'),
					eq(OrganizationMenuPosLink.remoteId, 'main-1'),
				),
			)
		const itemId = pizzaLink!.localId

		// AC #1: Loader exposes POS lock with Square badge & price locked
		const loaderData = await itemLoader({
			request: createAuthenticatedRequest(
				`https://app.test/${organization.slug}/menu/items/${itemId}`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug, itemId },
			context: new RouterContextProvider(),
		} as never)
		expect(loaderData.posLock.isLinked).toBe(true)
		expect(loaderData.posLock.providers).toEqual(['Square'])
		expect(loaderData.posLock.lockedFields).toContain('price')

		// AC #2: Direct POST changing price returns 409 field_owned_by_pos
		const blockedRes = (await itemAction({
			request: createAuthenticatedRequest(
				`https://app.test/${organization.slug}/menu/items/${itemId}`,
				{
					method: 'POST',
					body: new URLSearchParams({
						displayName: loaderData.item.displayName,
						description: loaderData.item.description,
						price: '19.99',
						applySalesTax: String(loaderData.item.applySalesTax),
						availabilityStatus: loaderData.item.availabilityStatus,
						assignedCategoryIds: JSON.stringify(
							loaderData.item.assignedCategoryIds,
						),
						assignedModifierGroupIds: JSON.stringify(
							loaderData.item.assignedModifierGroupIds,
						),
					}),
				},
				cookie,
			),
			params: { orgSlug: organization.slug, itemId },
			context: new RouterContextProvider(),
		} as never)) as Response
		expect(blockedRes.status).toBe(409)
		await expect(blockedRes.json()).resolves.toMatchObject({
			error: 'field_owned_by_pos',
			fields: ['price'],
			provider: 'Square',
		})

		// Location price override on Square's location is also refused with 409
		const locBlockedRes = (await itemAction({
			request: createAuthenticatedRequest(
				`https://app.test/${organization.slug}/menu/items/${itemId}`,
				{
					method: 'POST',
					body: new URLSearchParams({
						displayName: loaderData.item.displayName,
						description: loaderData.item.description,
						price: String(loaderData.item.price),
						applySalesTax: String(loaderData.item.applySalesTax),
						availabilityStatus: loaderData.item.availabilityStatus,
						assignedCategoryIds: JSON.stringify(
							loaderData.item.assignedCategoryIds,
						),
						assignedModifierGroupIds: JSON.stringify(
							loaderData.item.assignedModifierGroupIds,
						),
						locationOverrides: JSON.stringify({
							[location.id]: {
								locationId: location.id,
								isEnabled: true,
								price: 17.5,
							},
						}),
					}),
				},
				cookie,
			),
			params: { orgSlug: organization.slug, itemId },
			context: new RouterContextProvider(),
		} as never)) as Response
		expect(locBlockedRes.status).toBe(409)
		await expect(locBlockedRes.json()).resolves.toMatchObject({
			error: 'field_owned_by_pos',
			fields: ['price'],
			provider: 'Square',
		})

		// Editing unowned fields (calories, allergens) succeeds!
		const okRes = (await itemAction({
			request: createAuthenticatedRequest(
				`https://app.test/${organization.slug}/menu/items/${itemId}`,
				{
					method: 'POST',
					body: new URLSearchParams({
						displayName: loaderData.item.displayName,
						description: loaderData.item.description,
						price: String(loaderData.item.price),
						calorieMin: '550',
						allergens: JSON.stringify(['gluten', 'dairy']),
						applySalesTax: String(loaderData.item.applySalesTax),
						availabilityStatus: loaderData.item.availabilityStatus,
						assignedCategoryIds: JSON.stringify(
							loaderData.item.assignedCategoryIds,
						),
						assignedModifierGroupIds: JSON.stringify(
							loaderData.item.assignedModifierGroupIds,
						),
					}),
				},
				cookie,
			),
			params: { orgSlug: organization.slug, itemId },
			context: new RouterContextProvider(),
		} as never)) as Response
		expect(okRes.status).toBe(302)
		const [updatedItem] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, itemId))
		expect(updatedItem!.calorieMin).toBe(550)
		expect(updatedItem!.price).toBe(12.99)
	})

	it('refuses locked writes across options, modifier groups, bulk edit, suggestions, and dish delete', async () => {
		const { organization, integration, user, cookie } = await setupSquareOrg()
		await importCatalog(integration.id, organization.id)

		const [pizzaLink] = await db
			.select()
			.from(OrganizationMenuPosLink)
			.where(
				and(
					eq(OrganizationMenuPosLink.integrationId, integration.id),
					eq(OrganizationMenuPosLink.entityType, 'item'),
					eq(OrganizationMenuPosLink.remoteId, 'main-1'),
				),
			)
		const itemId = pizzaLink!.localId
		const [itemRow] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, itemId))

		// Option price edit refused with 409
		const [optLink] = await db
			.select()
			.from(OrganizationMenuPosLink)
			.where(
				and(
					eq(OrganizationMenuPosLink.integrationId, integration.id),
					eq(OrganizationMenuPosLink.entityType, 'modifier_option'),
				),
			)
		const [optRow] = await db
			.select()
			.from(OrganizationMenuOption)
			.where(eq(OrganizationMenuOption.id, optLink!.localId))
		const optRes = (await optionAction({
			request: createAuthenticatedRequest(
				`https://app.test/${organization.slug}/menu/options/${optRow!.id}`,
				{
					method: 'POST',
					body: new URLSearchParams({
						displayName: optRow!.displayName,
						price: '9.99',
						availabilityStatus: optRow!.availabilityStatus,
					}),
				},
				cookie,
			),
			params: { orgSlug: organization.slug, optionId: optRow!.id },
			context: new RouterContextProvider(),
		} as never)) as Response
		expect(optRes.status).toBe(409)
		await expect(optRes.json()).resolves.toMatchObject({
			error: 'field_owned_by_pos',
			fields: ['price'],
		})

		// Modifier group name edit refused with 409
		const [grpLink] = await db
			.select()
			.from(OrganizationMenuPosLink)
			.where(
				and(
					eq(OrganizationMenuPosLink.integrationId, integration.id),
					eq(OrganizationMenuPosLink.entityType, 'modifier_group'),
				),
			)
		const [grpRow] = await db
			.select()
			.from(OrganizationMenuModifierGroup)
			.where(eq(OrganizationMenuModifierGroup.id, grpLink!.localId))
		const grpRes = (await modifierGroupAction({
			request: createAuthenticatedRequest(
				`https://app.test/${organization.slug}/menu/modifiers/${grpRow!.id}`,
				{
					method: 'POST',
					body: new URLSearchParams({
						name: 'Renamed Group',
						selectionType: grpRow!.selectionType,
						minSelections: String(grpRow!.minSelections),
						maxSelections: String(grpRow!.maxSelections ?? ''),
						availabilityStatus: grpRow!.availabilityStatus,
						options: '[]',
						assignedItemIds: JSON.stringify([itemId]),
					}),
				},
				cookie,
			),
			params: { orgSlug: organization.slug, modifierGroupId: grpRow!.id },
			context: new RouterContextProvider(),
		} as never)) as Response
		expect(grpRes.status).toBe(409)
		await expect(grpRes.json()).resolves.toMatchObject({
			error: 'field_owned_by_pos',
		})

		// Bulk price edit refused with 409
		const bulkRes = await applyBulkItemEdit({
			organizationId: organization.id,
			organizationSlug: organization.slug,
			userId: user.id,
			itemIds: [itemId],
			operation: { type: 'price', change: { kind: 'set', value: 20 } },
			expectedUpdatedAt: { [itemId]: itemRow!.updatedAt.toISOString() },
		})
		expect(bulkRes.status).toBe(409)
		await expect(bulkRes.json()).resolves.toMatchObject({
			error: 'field_owned_by_pos',
			fields: ['price'],
		})

		// Bulk delete refused with 409
		const bulkDelRes = await applyBulkItemDelete({
			organizationId: organization.id,
			organizationSlug: organization.slug,
			userId: user.id,
			itemIds: [itemId],
		})
		expect(bulkDelRes.status).toBe(409)

		// Suggestions set-text on POS-locked description refused with 409
		const sugRes = (await suggestionsAction({
			request: new Request(
				`https://app.test/${organization.slug}/menu/suggestions`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json', cookie },
					body: JSON.stringify({
						intent: 'set-text',
						reason: 'description',
						itemId,
						changes: [
							{
								field: 'description',
								locale: 'en',
								value: 'AI suggested description',
							},
						],
					}),
				},
			),
			params: { orgSlug: organization.slug },
			context: new RouterContextProvider(),
		} as never)) as Response
		expect(sugRes.status).toBe(409)
		await expect(sugRes.json()).resolves.toMatchObject({
			error: 'field_owned_by_pos',
			fields: ['description'],
		})

		// Dish delete on items._index.tsx refused while Square owns name or price
		const delRes = (await itemsIndexAction({
			request: createAuthenticatedRequest(
				`https://app.test/${organization.slug}/menu/items?index`,
				{
					method: 'POST',
					body: new URLSearchParams({
						intent: 'delete-item',
						itemId,
					}),
				},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: new RouterContextProvider(),
		} as never)) as Response
		expect(delRes.status).toBe(409)
		await expect(delRes.json()).resolves.toMatchObject({
			error: 'field_owned_by_pos',
			provider: 'Square',
		})
	})

	it('AC #3: re-import skips unchanged dishes and updates POS-owned price when changed in Square, reporting the change', async () => {
		const { organization, location, integration, cookie } =
			await setupSquareOrg()
		const first = await importCatalog(integration.id, organization.id)
		expect(first.created).toBe(4)
		expect(first.updated).toBe(0)

		// Second import with no remote changes skips all 4 via stored hash
		const second = await importCatalog(integration.id, organization.id)
		expect(second.created).toBe(0)
		expect(second.updated).toBe(0)
		expect(second.skipped).toBe(4)
		expect(second.changes).toEqual([])

		// Update Margherita Pizza price in Square sandbox from $12.99 to $15.49
		const adapter = squareAdapterFor(integration.id)
		const remoteCatalog = await adapter.read()
		const remotePizza = remoteCatalog.items.find((i) => i.id === 'main-1')!
		await adapter.update(
			{ ...remotePizza, price: 1549 },
			'key-price-bump',
			'USD',
		)

		// Trigger re-import via Settings > Integrations action (checks toast reporting too!)
		const actionRes = (await integrationsAction({
			request: createAuthenticatedRequest(
				`https://app.test/${organization.slug}/settings/integrations`,
				{
					method: 'POST',
					body: new URLSearchParams({
						intent: 'import-pos-menu',
						integrationId: integration.id,
						organizationLocationId: location.id,
					}),
				},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: new RouterContextProvider(),
		} as never)) as Response
		expect(actionRes.status).toBe(302)
		const rawCookie = actionRes.headers.get('set-cookie') ?? ''
		const cookieVal =
			rawCookie.split(';')[0]?.split('=').slice(1).join('=') ?? ''
		const decodedPayload = Buffer.from(
			decodeURIComponent(cookieVal).split('.')[0] ?? '',
			'base64',
		).toString('utf8')
		expect(decodedPayload).toContain('1 updated')
		expect(decodedPayload).toContain('Margherita Pizza (price)')

		const [pizzaLink] = await db
			.select()
			.from(OrganizationMenuPosLink)
			.where(
				and(
					eq(OrganizationMenuPosLink.integrationId, integration.id),
					eq(OrganizationMenuPosLink.entityType, 'item'),
					eq(OrganizationMenuPosLink.remoteId, 'main-1'),
				),
			)
		const [localPizza] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, pizzaLink!.localId))
		expect(localPizza!.price).toBe(15.49)
	})

	it('AC #4: switching field ownership to Menuza via save-pos-ownership immediately unlocks the field without altering data', async () => {
		const { organization, location, integration, cookie } =
			await setupSquareOrg()
		await importCatalog(integration.id, organization.id)

		const [pizzaLink] = await db
			.select()
			.from(OrganizationMenuPosLink)
			.where(
				and(
					eq(OrganizationMenuPosLink.integrationId, integration.id),
					eq(OrganizationMenuPosLink.entityType, 'item'),
					eq(OrganizationMenuPosLink.remoteId, 'main-1'),
				),
			)
		const itemId = pizzaLink!.localId

		// Integrations loader exposes default fieldOwnership on POS cards
		const intLoader = await integrationsLoader({
			request: createAuthenticatedRequest(
				`https://app.test/${organization.slug}/settings/integrations?locationId=${location.id}`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: new RouterContextProvider(),
		} as never)
		const squareCard = intLoader.integrations.find(
			(i) => i.id === integration.id,
		)
		expect(squareCard?.fieldOwnership?.price).toBe('pos')

		// Switch price ownership to Menuza
		const saveRes = (await integrationsAction({
			request: createAuthenticatedRequest(
				`https://app.test/${organization.slug}/settings/integrations`,
				{
					method: 'POST',
					body: new URLSearchParams({
						intent: 'save-pos-ownership',
						integrationId: integration.id,
						organizationLocationId: location.id,
						fieldOwnership: JSON.stringify({
							...squareCard!.fieldOwnership,
							price: 'menuza',
						}),
					}),
				},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: new RouterContextProvider(),
		} as never)) as Response
		expect(saveRes.status).toBe(302)

		// Lock is lifted immediately, data unchanged ($12.99)
		const lockAfter = await lockedFieldsForOne(organization.id, 'item', itemId)
		expect(lockAfter.lockedFields).not.toContain('price')
		const [beforeEdit] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, itemId))
		expect(beforeEdit!.price).toBe(12.99)

		// Editing price now succeeds!
		const loaded = await itemLoader({
			request: createAuthenticatedRequest(
				`https://app.test/${organization.slug}/menu/items/${itemId}`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug, itemId },
			context: new RouterContextProvider(),
		} as never)
		const editRes = (await itemAction({
			request: createAuthenticatedRequest(
				`https://app.test/${organization.slug}/menu/items/${itemId}`,
				{
					method: 'POST',
					body: new URLSearchParams({
						displayName: loaded.item.displayName,
						description: loaded.item.description,
						price: '16.50',
						applySalesTax: String(loaded.item.applySalesTax),
						availabilityStatus: loaded.item.availabilityStatus,
						assignedCategoryIds: JSON.stringify(
							loaded.item.assignedCategoryIds,
						),
						assignedModifierGroupIds: JSON.stringify(
							loaded.item.assignedModifierGroupIds,
						),
					}),
				},
				cookie,
			),
			params: { orgSlug: organization.slug, itemId },
			context: new RouterContextProvider(),
		} as never)) as Response
		expect(editRes.status).toBe(302)
		const [afterEdit] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, itemId))
		expect(afterEdit!.price).toBe(16.5)
	})

	it('AC #5, #6 & #7: allows overriding allowlisted description, filters ?overrides=1, preserves override on sync while refreshing posValues, restores latest POS value with audit history, and refuses non-allowlisted overrides', async () => {
		const auditSpy = vi.spyOn(auditService, 'log')
		const { organization, integration, cookie } = await setupSquareOrg()
		await importCatalog(integration.id, organization.id)

		const [pizzaLink] = await db
			.select()
			.from(OrganizationMenuPosLink)
			.where(
				and(
					eq(OrganizationMenuPosLink.integrationId, integration.id),
					eq(OrganizationMenuPosLink.entityType, 'item'),
					eq(OrganizationMenuPosLink.remoteId, 'main-1'),
				),
			)
		const itemId = pizzaLink!.localId

		// AC #7: Non-allowlisted field (price on Square) cannot be overridden
		const disallowedRes = (await itemAction({
			request: createAuthenticatedRequest(
				`https://app.test/${organization.slug}/menu/items/${itemId}`,
				{
					method: 'POST',
					body: new URLSearchParams({
						intent: 'override-pos-field',
						field: 'price',
					}),
				},
				cookie,
			),
			params: { orgSlug: organization.slug, itemId },
			context: new RouterContextProvider(),
		} as never)) as Response
		expect(disallowedRes.status).toBe(403)
		await expect(disallowedRes.json()).resolves.toMatchObject({
			ok: false,
			error: 'field_not_overridable',
			field: 'price',
		})

		// AC #5 (part 1): Override POS description via "Use my own"
		const overrideRes = (await itemAction({
			request: createAuthenticatedRequest(
				`https://app.test/${organization.slug}/menu/items/${itemId}`,
				{
					method: 'POST',
					body: new URLSearchParams({
						intent: 'override-pos-field',
						field: 'description',
					}),
				},
				cookie,
			),
			params: { orgSlug: organization.slug, itemId },
			context: new RouterContextProvider(),
		} as never)) as Response
		expect(overrideRes.status).toBe(200)
		await expect(overrideRes.json()).resolves.toMatchObject({
			ok: true,
			field: 'description',
		})

		// Operator saves their own description
		const loaded = await itemLoader({
			request: createAuthenticatedRequest(
				`https://app.test/${organization.slug}/menu/items/${itemId}`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug, itemId },
			context: new RouterContextProvider(),
		} as never)
		expect(loaded.posLock.overriddenFields).toContain('description')
		expect(loaded.posLock.lockedFields).not.toContain('description')

		const customSave = (await itemAction({
			request: createAuthenticatedRequest(
				`https://app.test/${organization.slug}/menu/items/${itemId}`,
				{
					method: 'POST',
					body: new URLSearchParams({
						displayName: loaded.item.displayName,
						description: JSON.stringify({
							en: 'Wood-fired San Marzano & fresh basil',
						}),
						price: String(loaded.item.price),
						applySalesTax: String(loaded.item.applySalesTax),
						availabilityStatus: loaded.item.availabilityStatus,
						assignedCategoryIds: JSON.stringify(
							loaded.item.assignedCategoryIds,
						),
						assignedModifierGroupIds: JSON.stringify(
							loaded.item.assignedModifierGroupIds,
						),
					}),
				},
				cookie,
			),
			params: { orgSlug: organization.slug, itemId },
			context: new RouterContextProvider(),
		} as never)) as Response
		expect(customSave.status).toBe(302)

		// ?overrides=1 filter on items._index.tsx returns only the overridden dish
		const filteredList = await itemsIndexLoader({
			request: createAuthenticatedRequest(
				`https://app.test/${organization.slug}/menu/items?overrides=1`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: new RouterContextProvider(),
		} as never)
		expect(filteredList.overridesFilter).toBe(true)
		expect(filteredList.items.map((i) => i.id)).toEqual([itemId])

		// AC #6: Square changes description & price; sync updates price, leaves overridden
		// description untouched, AND refreshes stored posValues.description!
		const adapter = squareAdapterFor(integration.id)
		const remoteCatalog = await adapter.read()
		const remotePizza = remoteCatalog.items.find((i) => i.id === 'main-1')!
		await adapter.update(
			{
				...remotePizza,
				description: 'Updated Square buffalo mozzarella description',
				price: 1450,
			},
			'key-sync-override',
			'USD',
		)
		const syncRes = await importCatalog(integration.id, organization.id)
		expect(syncRes.updated).toBe(1)
		expect(syncRes.changes).toEqual([
			{ itemId, name: 'Margherita Pizza', fields: ['price'] },
		])

		const [afterSyncItem] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, itemId))
		expect(afterSyncItem!.price).toBe(14.5)
		expect(afterSyncItem!.description).toBe(
			JSON.stringify({ en: 'Wood-fired San Marzano & fresh basil' }),
		)

		const [refreshedLink] = await db
			.select()
			.from(OrganizationMenuPosLink)
			.where(eq(OrganizationMenuPosLink.id, pizzaLink!.id))
		expect(parsePosValues(refreshedLink!.posValues).description).toBe(
			'Updated Square buffalo mozzarella description',
		)

		// AC #5 (part 2): Restore from POS puts the latest refreshed POS description back
		const restoreRes = (await itemAction({
			request: createAuthenticatedRequest(
				`https://app.test/${organization.slug}/menu/items/${itemId}`,
				{
					method: 'POST',
					body: new URLSearchParams({
						intent: 'restore-pos-field',
						field: 'description',
					}),
				},
				cookie,
			),
			params: { orgSlug: organization.slug, itemId },
			context: new RouterContextProvider(),
		} as never)) as Response
		expect(restoreRes.status).toBe(200)

		const [restoredItem] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, itemId))
		expect(restoredItem!.description).toBe(
			JSON.stringify({
				en: 'Updated Square buffalo mozzarella description',
			}),
		)
		const lockRestored = await lockedFieldsForOne(
			organization.id,
			'item',
			itemId,
		)
		expect(lockRestored.lockedFields).toContain('description')
		expect(lockRestored.overriddenFields).not.toContain('description')

		// Menu history recorded via auditService.log (AuditAction.MENU_ITEM_UPDATED) for both override and restore
		expect(auditSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				action: AuditAction.MENU_ITEM_UPDATED,
				organizationId: organization.id,
				resourceId: itemId,
				metadata: expect.objectContaining({
					posOverride: 'override',
					field: 'description',
				}),
			}),
		)
		expect(auditSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				action: AuditAction.MENU_ITEM_UPDATED,
				organizationId: organization.id,
				resourceId: itemId,
				metadata: expect.objectContaining({
					posOverride: 'restore',
					field: 'description',
					restoredValue: 'Updated Square buffalo mozzarella description',
				}),
			}),
		)
		auditSpy.mockRestore()
	})
})
