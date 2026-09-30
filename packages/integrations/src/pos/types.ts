/**
 * Canonical types for POS and delivery-platform integrations.
 *
 * Ported and trimmed from the Mise reference project (`lib/pos/types.ts`).
 * Money is stored in minor units (cents) at this boundary; the menu projector
 * converts from the menu's `real` dollars.
 */

export const posProviders = [
	'clover',
	'square',
	'toast',
	'ubereats',
	'doordash',
] as const
export type PosProvider = (typeof posProviders)[number]

export type ProviderKind = 'pos' | 'delivery'
/** How each platform accepts menu content: per item, as a whole menu, or not at all. */
export type WriteMode = 'item' | 'menu' | 'none'

export const menuFields = [
	'name',
	'description',
	'category',
	'price',
	'photo',
	'available',
	'modifiers',
	'variations',
	'menus',
	'allergens',
	'tax',
] as const
export type MenuField = (typeof menuFields)[number]

// Items with no assigned menu are served whenever the restaurant is open.
export const ALL_DAY = 'All day'

/* ---------- What a provider holds (canonical form of its catalog) ---------- */
export type RemoteOption = {
	id?: string
	name: string
	price: number
	available?: boolean
}
export type RemoteModifierGroup = {
	id?: string
	name: string
	min: number
	max: number
	options: RemoteOption[]
}
export type RemoteVariation = { name: string; price: number }
export type Snapshot = {
	name: string
	description: string
	category: string
	price: number
	imageUrl: string | null
	available: boolean
	modifierGroups: RemoteModifierGroup[]
	variations: RemoteVariation[]
	menus: string[]
	allergens: string[]
	alcohol?: boolean
	taxRate: number | null
}
export type RemoteItem = Snapshot & {
	id: string
	variationId?: string
	version: number
}
export type RemoteMenu = {
	name: string
	days: number[]
	start: string
	end: string
	timezone?: string
}
export type RemoteRead = {
	items: RemoteItem[]
	menus: RemoteMenu[]
	version: number
	currency: string
}

/* ---------- Provider metadata ---------- */
export const providerNames: Record<PosProvider, string> = {
	clover: 'Clover',
	square: 'Square',
	toast: 'Toast',
	ubereats: 'Uber Eats',
	doordash: 'DoorDash',
}
export const providerKind: Record<PosProvider, ProviderKind> = {
	clover: 'pos',
	square: 'pos',
	toast: 'pos',
	ubereats: 'delivery',
	doordash: 'delivery',
}
export const providerWriteMode: Record<PosProvider, WriteMode> = {
	clover: 'item',
	square: 'item',
	toast: 'none',
	ubereats: 'menu',
	doordash: 'menu',
}
// Deterministic sandbox store ids, used when connecting in sandbox mode.
export const merchantIds: Record<PosProvider, string> = {
	clover: 'M_SANDBOX_CLOVER',
	square: 'L_SANDBOX_SQUARE',
	toast: 'b7bdc2a0-13b8-4cc3-9183-bef001ad9e5f',
	ubereats: 'a4f1c9d2-7b3e-4a58-9c1d-2e6f8b0a4d17',
	doordash: 'D-8241937',
}
// Sandbox hosts. The adapter talks to these and MSW intercepts them in dev/test.
export const sandboxUrls: Record<PosProvider, string> = {
	clover: 'https://apisandbox.dev.clover.com',
	square: 'https://connect.squareupsandbox.com',
	toast: 'https://ws-sandbox-api.toasttab.com',
	ubereats: 'https://api.uber.com',
	doordash: 'https://openapi.doordash.com',
}

const all: MenuField[] = [...menuFields]
// Fields each provider's API exposes on read, and the subset we can write back.
export const readFields: Record<PosProvider, MenuField[]> = {
	clover: ['name', 'category', 'price', 'available', 'modifiers', 'tax'],
	square: [
		'name',
		'description',
		'category',
		'price',
		'photo',
		'available',
		'modifiers',
		'variations',
		'allergens',
		'tax',
	],
	toast: [
		'name',
		'description',
		'category',
		'price',
		'photo',
		'available',
		'modifiers',
		'variations',
		'menus',
		'allergens',
	],
	ubereats: all,
	doordash: all.filter((field) => field !== 'tax'),
}
export const writeFields: Record<PosProvider, MenuField[]> = {
	...readFields,
	toast: ['available'],
}

export function isPosProvider(value: string): value is PosProvider {
	return (posProviders as readonly string[]).includes(value)
}
