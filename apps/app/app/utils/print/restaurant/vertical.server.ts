import { type LocationAddress } from '@repo/common/location-types'
import {
	isTableTarget,
	type RestaurantMenuTarget,
	type RestaurantReservationsTarget,
} from '@repo/common/print-shop-restaurant'
import { qrPosterUrl, qrTableUrl } from '@repo/common/qr-ordering'
import { and, db, eq, OrganizationLocation } from '@repo/database'
import { buildPublicSiteMenuPayload } from '#app/utils/menu/public-menu-context.server.ts'
import { type PublicMenuItemData } from '#app/utils/menu/public-serializers.server.ts'
import {
	type PrintItemChoice,
	type PrintOrg,
	type PrintScope,
	type PrintShopServerVertical,
} from '../vertical-contract.server.ts'
import {
	canPrintQrTables,
	fetchQrTablesForPrint,
	isQrDineInOn,
} from './qr-tables.server.ts'

/**
 * The restaurant print vertical: locations are the scopes (address, menu
 * prices, ship-to), menu dishes are the featured items, and table cards
 * carry each QR ordering table's code. Table codes are capabilities: only
 * menu editors see them, and they are fetched server-side from the region.
 */

function formatAddress(address: LocationAddress | null): string | null {
	if (!address) return null
	if (address.formattedAddress) return address.formattedAddress
	const line = [address.streetNumber, address.streetName]
		.filter(Boolean)
		.join(' ')
	return [line, address.city, address.state].filter(Boolean).join(', ') || null
}

function parseAddress(raw: string | null): LocationAddress | null {
	try {
		return raw ? (JSON.parse(raw) as LocationAddress | null) : null
	} catch {
		return null
	}
}

async function listLocations(organizationId: string): Promise<PrintScope[]> {
	const rows = await db
		.select({
			id: OrganizationLocation.id,
			name: OrganizationLocation.name,
			address: OrganizationLocation.address,
			isDefault: OrganizationLocation.isDefault,
		})
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, organizationId),
				eq(OrganizationLocation.isActive, true),
			),
		)
	return rows.map((row) => {
		const address = parseAddress(row.address)
		return {
			id: row.id,
			name: row.name,
			isDefault: row.isDefault,
			address: formatAddress(address),
			shipTo: address
				? {
						line1: [address.streetNumber, address.streetName]
							.filter(Boolean)
							.join(' '),
						line2: address.unit ?? '',
						city: address.city ?? '',
						state: (address.state ?? '').toUpperCase(),
						postalCode: address.postalCode ?? '',
					}
				: null,
		}
	})
}

/** Dishes of the location's live menus (no drops), with location prices. */
async function listDishes(
	org: PrintOrg,
	locationId: string | null,
): Promise<{ items: PrintItemChoice[]; currency: string }> {
	const currency = org.dataRegion === 'ksa' ? 'SAR' : 'USD'
	const { payload } = await buildPublicSiteMenuPayload(
		{
			id: org.id,
			name: org.name,
			slug: org.slug,
			currency,
			siteDefaultLocale: org.siteDefaultLocale,
			siteLocales: org.siteLocales,
			customDomain: org.customDomain,
		},
		locationId,
	)
	const overrides = locationId
		? (payload.locationOverrides[locationId] ?? [])
		: []
	const priceOverride = new Map(
		overrides
			.filter(
				(override) =>
					override.entityType === 'item' &&
					typeof (override as { price?: unknown }).price === 'number',
			)
			.map((override) => [
				override.entityId,
				(override as { price: number }).price,
			]),
	)
	const disabled = new Set(
		overrides
			.filter(
				(override) =>
					override.entityType === 'item' &&
					(override as { isEnabled?: unknown }).isEnabled === false,
			)
			.map((override) => override.entityId),
	)
	const seen = new Map<string, PrintItemChoice>()
	const visit = (items: PublicMenuItemData[]) => {
		for (const item of items) {
			if (seen.has(item.id) || disabled.has(item.id)) continue
			if (item.availabilityStatus !== 'available') continue
			seen.set(item.id, {
				id: item.id,
				name: item.displayName,
				priceCents: Math.round(
					(priceOverride.get(item.id) ?? item.price) * 100,
				),
				imageKey: item.imageKey ?? null,
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
		currency: payload.organization.currency || currency,
	}
}

function siteUrl(origin: string, path: string, params: Record<string, string>) {
	const url = new URL(path, origin)
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value)
	}
	return url.toString()
}

const canSeeTableCodes = (access: {
	userId: string
	organization: { id: string }
}) => canPrintQrTables(access.userId, access.organization.id)

export const restaurantPrintVertical: PrintShopServerVertical = {
	id: 'restaurant',
	scopes: { list: listLocations },
	featuredItems: { list: listDishes },
	qrTargets: {
		table: {
			available: async (access) =>
				(await isQrDineInOn(access.organization.id)) &&
				(await canSeeTableCodes(access)),
			canView: canSeeTableCodes,
			defaultFor: async (access, { product }) =>
				product.qrTargets?.includes('table') &&
				(await isQrDineInOn(access.organization.id)) &&
				(await canSeeTableCodes(access))
					? { kind: 'table', tableIds: ['all'] }
					: null,
			editorData: async (request, access) => ({
				// Where tables are added (Settings, QR tables): the picker links
				// there when there are none yet.
				setupHref: `/${access.organization.slug}/settings/qr-tables`,
				tables: (
					await fetchQrTablesForPrint(request, access.organization.slug).catch(
						() => [],
					)
				).map((table) => ({
					id: table.id,
					label: table.label,
					locationId: table.locationId,
				})),
			}),
			pieceCount: (target, data) => {
				if (!isTableTarget(target)) return 1
				const tables = (data as { tables?: unknown[] } | null)?.tables ?? []
				return target.tableIds.includes('all')
					? tables.length
					: target.tableIds.length
			},
			fromForm: (formData) => {
				if (formData.get('allTables') === 'on') {
					return { kind: 'table', tableIds: ['all'] }
				}
				const tableIds = formData
					.getAll('tableIds')
					.filter((value): value is string => typeof value === 'string')
				return tableIds.length > 0 ? { kind: 'table', tableIds } : 'empty'
			},
			resolve: async (target, { request, access, siteOrigin, utm }) => {
				if (!isTableTarget(target)) return { pieces: [], facts: [] }
				const tables = await fetchQrTablesForPrint(
					request,
					access.organization.slug,
					target.tableIds.includes('all') ? undefined : target.tableIds,
				)
				return {
					pieces: tables.map((table) => ({
						label: table.label,
						qrUrl: qrTableUrl(siteOrigin, table.locationId, table.token, utm),
					})),
					facts: tables.map((table) => ({
						id: table.id,
						label: table.label,
						version: table.tokenVersion,
					})),
				}
			},
		},
		menu: {
			defaultFor: async (_access, { scope }) =>
				scope ? { kind: 'menu', locationId: scope.id } : null,
			fromForm: (formData) => ({
				kind: 'menu',
				locationId: String(formData.get('qrLocationId') ?? ''),
			}),
			resolve: async (target, { siteOrigin, utm }) => ({
				pieces: [
					{
						label: null,
						qrUrl: qrPosterUrl(
							siteOrigin,
							(target as RestaurantMenuTarget).locationId,
							utm,
						),
					},
				],
				facts: [],
			}),
		},
		reservations: {
			fromForm: (formData) => ({
				kind: 'reservations',
				locationId: String(formData.get('qrLocationId') ?? '') || null,
			}),
			resolve: async (target, { siteOrigin, utm }) => {
				const locationId = (target as RestaurantReservationsTarget).locationId
				return {
					pieces: [
						{
							label: null,
							qrUrl: siteUrl(siteOrigin, '/reserve', {
								...(locationId ? { location: locationId } : {}),
								...utm,
							}),
						},
					],
					facts: [],
				}
			},
		},
	},
}
