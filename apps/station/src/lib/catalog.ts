import { isAvailable, isHiddenStatus } from './availability.ts'
import { type PosSettings } from './config.ts'
import { db } from './db.ts'
import { demoCatalog } from './demo-catalog.ts'
import {
	type CatalogSnapshot,
	type MenuCategory,
	type MenuItem,
	type MenuLocation,
	type MenuOption,
	type ModifierGroup,
	type MenuPayload,
	type PublicOrganization,
} from './types.ts'

const FETCH_TIMEOUT_MS = 10_000

async function getJson<T>(url: string): Promise<T> {
	const response = await fetch(url, {
		headers: { Accept: 'application/json' },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	})
	if (!response.ok)
		throw new Error(`${response.status} from ${new URL(url).pathname}`)
	return (await response.json()) as T
}

export async function loadCachedCatalog(): Promise<
	CatalogSnapshot | undefined
> {
	return db.catalog.get('catalog')
}

/**
 * Fetches branding and menu together and replaces the stored snapshot only when
 * both succeed, so a half-failed refresh never leaves a theme without a menu.
 * Returns the previous snapshot untouched on any failure; the caller decides
 * whether to surface it.
 */
export async function refreshCatalog(
	settings: PosSettings,
): Promise<
	{ ok: true; snapshot: CatalogSnapshot } | { ok: false; error: string }
> {
	if (settings.demo) {
		const snapshot = demoCatalog()
		await db.catalog.put(snapshot)
		return { ok: true, snapshot }
	}
	try {
		const base = settings.appUrl.replace(/\/+$/, '')
		const slug = encodeURIComponent(settings.slug.trim().toLowerCase())
		const [organization, menu] = await Promise.all([
			getJson<PublicOrganization>(`${base}/resources/sites?slug=${slug}`),
			getJson<MenuPayload>(`${base}/resources/sites/menu?slug=${slug}`),
		])
		if (!organization?.id || !menu?.menus)
			throw new Error('Unexpected catalog response')
		const snapshot: CatalogSnapshot = {
			key: 'catalog',
			fetchedAt: Date.now(),
			organization,
			menu,
		}
		await db.catalog.put(snapshot)
		return { ok: true, snapshot }
	} catch (error) {
		return {
			ok: false,
			error:
				error instanceof Error ? error.message : 'Could not reach the server',
		}
	}
}

export function pickLocation(
	menu: MenuPayload,
	preferredId: string | null,
): MenuLocation | undefined {
	return (
		menu.locations.find((l) => l.id === preferredId) ??
		menu.locations.find((l) => l.isDefault) ??
		menu.locations[0]
	)
}

/** Categories that are off the till entirely (not merely sold out). */
const categoryOff = (status: string | null | undefined) =>
	status === 'unavailable' || isHiddenStatus(status)

/**
 * Categories for the till: the first available menu, with this location's
 * overrides applied the way the server applies them when it re-prices an order
 * (overrides match by entity id, whatever the entity type): a disabled or hidden
 * entity disappears, an override price replaces the base only when it is above
 * zero, and an override status replaces the base status. Items that are sold out
 * stay visible and greyed so the cashier can explain.
 */
export function buildCategories(
	menu: MenuPayload,
	locationId: string,
): MenuCategory[] {
	const overrides = menu.locationOverrides?.[locationId] ?? []
	const byId = new Map(overrides.map((o) => [o.entityId, o]))
	const statusOf = (id: string, base: string) =>
		byId.get(id)?.availabilityStatus ?? base
	const priceOf = (id: string, base: number) => {
		const price = byId.get(id)?.price
		return price != null && price > 0 ? price : base
	}
	const off = (id: string, status: string) =>
		byId.get(id)?.isEnabled === false || isHiddenStatus(statusOf(id, status))

	const applyOption = (option: MenuOption): MenuOption | null => {
		if (off(option.id, option.availabilityStatus)) return null
		return {
			...option,
			price: priceOf(option.id, option.price),
			availabilityStatus: statusOf(option.id, option.availabilityStatus),
			nestedModifierGroups: option.nestedModifierGroups
				?.map(applyGroup)
				.filter((g): g is ModifierGroup => g !== null),
		}
	}
	const applyGroup = (group: ModifierGroup): ModifierGroup | null => {
		if (off(group.id, group.availabilityStatus)) return null
		return {
			...group,
			availabilityStatus: statusOf(group.id, group.availabilityStatus),
			options: group.options
				.map(applyOption)
				.filter((o): o is MenuOption => o !== null),
		}
	}
	const applyItem = (item: MenuItem): MenuItem | null => {
		if (off(item.id, item.availabilityStatus)) return null
		return {
			...item,
			price: priceOf(item.id, item.price),
			availabilityStatus: statusOf(item.id, item.availabilityStatus),
			modifierGroups: item.modifierGroups
				.map(applyGroup)
				.filter((g): g is ModifierGroup => g !== null),
		}
	}
	const applyCategory = (cat: MenuCategory): MenuCategory | null => {
		if (
			byId.get(cat.id)?.isEnabled === false ||
			categoryOff(cat.availabilityStatus)
		)
			return null
		const subcategories = (cat.subcategories ?? [])
			.map(applyCategory)
			.filter((c): c is MenuCategory => c !== null)
		const items = (cat.items ?? [])
			.map(applyItem)
			.filter((i): i is MenuItem => i !== null)
			.sort((a, b) => a.position - b.position)
		if (items.length === 0 && subcategories.length === 0) return null
		return { ...cat, items, subcategories }
	}

	const menus = menu.menus
		.filter((m) => !categoryOff(m.availabilityStatus))
		.sort((a, b) => a.position - b.position)
	return (
		menus
			.flatMap((m) => m.categories)
			// Sub-categories arrive nested under their parent; like the website, skip
			// any that are also listed at the top level.
			.filter((c) => !c.parentId)
			.sort((a, b) => a.position - b.position)
			.map(applyCategory)
			.filter((c): c is MenuCategory => c !== null)
	)
}

/** A category with its subcategories' items folded in, for a flat item grid. */
export function categoryItems(category: MenuCategory): MenuItem[] {
	const seen = new Set<string>()
	const out: MenuItem[] = []
	const walk = (c: MenuCategory) => {
		for (const item of c.items) {
			if (!seen.has(item.id)) {
				seen.add(item.id)
				out.push(item)
			}
		}
		c.subcategories?.forEach(walk)
	}
	walk(category)
	return out
}

export const isSoldOut = (item: MenuItem): boolean => {
	if (!isAvailable(item.availabilityStatus)) return true
	const variants = item.variations.variants
	return (
		variants.length > 0 &&
		variants.every((v) => !isAvailable(v.availabilityStatus))
	)
}
