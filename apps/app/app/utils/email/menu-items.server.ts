import {
	type EmailMenuItemBlock,
	type EmailMenuItemSnapshotItem,
} from '@repo/common/email-blocks-restaurant'
import { type EmailBlock } from '@repo/common/email-blocks'
import { db, eq, Organization } from '@repo/database'
import {
	buildPublicSiteMenuPayload,
	type PublicSiteMenuPayload,
} from '#app/utils/menu/public-menu-context.server.ts'
import { type PublicMenuItemData } from '#app/utils/menu/public-serializers.server.ts'

/**
 * Dishes for the email designer's Menu item block (#153), read from the live
 * control-plane menu. Control-plane data only, no guest PII.
 *
 * A dish can be picked only while it is on a live menu: archived items,
 * unavailable ones, drops and dishes hidden at the chosen location are not in
 * the list, and a saved block whose dish has left it is refused with
 * `item_not_available` instead of freezing a stale or missing dish into mail.
 */

const DESCRIPTION_MAX = 140

export type MenuLocationChoice = { id: string; name: string }

export type PickableMenuItems = {
	items: EmailMenuItemSnapshotItem[]
	locations: MenuLocationChoice[]
	currency: string
}

function shortDescription(value: string | null): string {
	const text = (value ?? '').replace(/\s+/g, ' ').trim()
	return text.length > DESCRIPTION_MAX
		? `${text.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…`
		: text
}

function absoluteImageUrl(item: PublicMenuItemData, baseUrl: string): string {
	const direct = item.imageUrl?.trim()
	if (direct && /^https?:\/\//i.test(direct)) return direct
	const key = item.imageKey?.trim()
	if (key) {
		return `${baseUrl.replace(/\/+$/, '')}/resources/images?objectKey=${encodeURIComponent(key)}`
	}
	if (direct?.startsWith('/')) return `${baseUrl.replace(/\/+$/, '')}${direct}`
	return ''
}

/** The dishes of the live menus at a location, with that location's prices. */
export function collectPickableMenuItems(
	payload: PublicSiteMenuPayload,
	locationId: string | null,
	options: { baseUrl: string; fallbackCurrency: string },
): PickableMenuItems {
	const location = locationId
		? payload.locations.find((entry) => entry.id === locationId)
		: null
	const currency =
		location?.currency ||
		payload.organization.currency ||
		options.fallbackCurrency
	const overrides = locationId
		? (payload.locationOverrides[locationId] ?? [])
		: []
	const itemOverrides = new Map(
		overrides
			.filter((override) => override.entityType === 'item')
			.map((override) => [override.entityId, override]),
	)

	const seen = new Map<string, EmailMenuItemSnapshotItem>()
	const visit = (items: PublicMenuItemData[]) => {
		for (const item of items) {
			if (seen.has(item.id)) continue
			const override = itemOverrides.get(item.id)
			if (override?.isEnabled === false) continue
			const status = override?.availabilityStatus ?? item.availabilityStatus
			if (status !== 'available') continue
			const price =
				typeof override?.price === 'number' ? override.price : item.price
			seen.set(item.id, {
				itemId: item.id,
				name: item.displayName,
				description: shortDescription(item.description),
				priceMinor: Math.round(price * 100),
				currency,
				imageUrl: absoluteImageUrl(item, options.baseUrl),
				path: `/menu?item=${encodeURIComponent(item.id)}`,
			})
		}
	}
	type Category = { items: PublicMenuItemData[]; subcategories?: Category[] }
	const walk = (categories: Category[]) => {
		for (const category of categories) {
			visit(category.items ?? [])
			walk(category.subcategories ?? [])
		}
	}
	for (const menu of payload.menus) {
		if (menu.menuType === 'drop' || menu.availabilityStatus !== 'available') {
			continue
		}
		walk(menu.categories as Category[])
	}
	return {
		items: [...seen.values()],
		locations: payload.locations.map((entry) => ({
			id: entry.id,
			name: entry.name,
		})),
		currency,
	}
}

type MenuOrg = Parameters<typeof buildPublicSiteMenuPayload>[0]

async function loadMenuOrg(organizationId: string): Promise<MenuOrg | null> {
	const [org] = await db
		.select({
			id: Organization.id,
			name: Organization.name,
			slug: Organization.slug,
			dataRegion: Organization.dataRegion,
			siteDefaultLocale: Organization.siteDefaultLocale,
			siteLocales: Organization.siteLocales,
			customDomain: Organization.customDomain,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	if (!org) return null
	return {
		id: org.id,
		name: org.name,
		slug: org.slug,
		currency: org.dataRegion === 'ksa' ? 'SAR' : 'USD',
		siteDefaultLocale: org.siteDefaultLocale,
		siteLocales: org.siteLocales,
		customDomain: org.customDomain,
	}
}

export async function listPickableMenuItems(
	organizationId: string,
	locationId: string | null,
	baseUrl: string,
): Promise<PickableMenuItems> {
	const org = await loadMenuOrg(organizationId)
	if (!org) return { items: [], locations: [], currency: 'USD' }
	const { payload } = await buildPublicSiteMenuPayload(org, locationId)
	return collectPickableMenuItems(payload, locationId, {
		baseUrl,
		fallbackCurrency: org.currency,
	})
}

export type ResolveMenuItemsResult =
	| { ok: true; blocks: EmailBlock[] }
	| { ok: false; error: 'item_not_available'; blockId: string }

/**
 * Re-resolves every Menu item block from the live menu: the saved snapshot is
 * the server's reading, never the browser's, so a price in a sent email cannot
 * be forged or stale. A dish that cannot be picked now refuses the save.
 */
export async function resolveMenuItemBlocks(
	organizationId: string,
	blocks: EmailBlock[],
	baseUrl: string,
	options: {
		now?: Date
		/** Reads the pickable dishes of a location; the live menu by default. */
		listItems?: typeof listPickableMenuItems
	} = {},
): Promise<ResolveMenuItemsResult> {
	const now = options.now ?? new Date()
	const listItems = options.listItems ?? listPickableMenuItems
	const catalogs = new Map<string, Promise<PickableMenuItems>>()
	const catalogFor = (locationId: string | null) => {
		const key = locationId ?? ''
		let found = catalogs.get(key)
		if (!found) {
			found = listItems(organizationId, locationId, baseUrl)
			catalogs.set(key, found)
		}
		return found
	}

	const out: EmailBlock[] = []
	for (const block of blocks) {
		if (block.type !== 'menu_item') {
			out.push(block)
			continue
		}
		if (block.config.itemIds.length === 0) {
			out.push({ ...block, config: { ...block.config, snapshot: null } })
			continue
		}
		const catalog = await catalogFor(block.config.locationId)
		if (
			block.config.locationId &&
			!catalog.locations.some((entry) => entry.id === block.config.locationId)
		) {
			return { ok: false, error: 'item_not_available', blockId: block.id }
		}
		const byId = new Map(catalog.items.map((item) => [item.itemId, item]))
		const items: EmailMenuItemSnapshotItem[] = []
		for (const itemId of block.config.itemIds) {
			const item = byId.get(itemId)
			if (!item) {
				return { ok: false, error: 'item_not_available', blockId: block.id }
			}
			items.push(item)
		}
		const config: EmailMenuItemBlock['config'] = {
			...block.config,
			snapshot: { resolvedAt: now.toISOString(), items },
		}
		out.push({ ...block, config })
	}
	return { ok: true, blocks: out }
}

/**
 * Dishes of a block taken from somewhere older (a saved template): keeps the
 * dishes that can still be picked, drops the rest, and re-freezes the snapshot
 * from the live menu. A location that is gone falls back to base prices. Never
 * refuses: a block left with no dish is caught by the pre-send check.
 */
export async function refreshMenuItemBlocks(
	organizationId: string,
	blocks: EmailBlock[],
	baseUrl: string,
	options: {
		now?: Date
		listItems?: typeof listPickableMenuItems
	} = {},
): Promise<EmailBlock[]> {
	const now = options.now ?? new Date()
	const listItems = options.listItems ?? listPickableMenuItems
	const catalogs = new Map<string, Promise<PickableMenuItems>>()
	const catalogFor = (locationId: string | null) => {
		const key = locationId ?? ''
		let found = catalogs.get(key)
		if (!found) {
			found = listItems(organizationId, locationId, baseUrl)
			catalogs.set(key, found)
		}
		return found
	}

	const out: EmailBlock[] = []
	for (const block of blocks) {
		if (block.type !== 'menu_item' || block.config.itemIds.length === 0) {
			out.push(block)
			continue
		}
		let locationId = block.config.locationId
		let catalog = await catalogFor(locationId)
		if (
			locationId &&
			!catalog.locations.some((entry) => entry.id === locationId)
		) {
			locationId = null
			catalog = await catalogFor(null)
		}
		const byId = new Map(catalog.items.map((item) => [item.itemId, item]))
		const items = block.config.itemIds.flatMap((id) => {
			const item = byId.get(id)
			return item ? [item] : []
		})
		out.push({
			...block,
			config: {
				...block.config,
				locationId,
				itemIds: items.map((item) => item.itemId),
				snapshot:
					items.length > 0 ? { resolvedAt: now.toISOString(), items } : null,
			},
		})
	}
	return out
}
