import crypto from 'node:crypto'
import { resolveEmailTheme, solidEmailTheme } from '@repo/common/email-theme'
import { type LocationAddress } from '@repo/common/location-types'
import {
	defaultPrintCopy,
	localeDirection,
	PRINT_PRODUCTS,
	PRINT_TEMPLATE_VERSION,
	printCopy,
	printUtmParams,
	type PrintDesignContent,
	type PrintFeaturedItem,
	type PrintPiece,
	type PrintProductKey,
	type PrintQrTarget,
	type PrintSnapshot,
	type PrintTemplateStyle,
} from '@repo/common/print-shop'
import { qrPosterUrl, qrTableUrl } from '@repo/common/qr-ordering'
import { parseSiteLocalesConfig } from '@repo/common/site-locales'
import {
	and,
	db,
	eq,
	OrganizationLocation,
	OrganizationMediaAsset,
	or,
} from '@repo/database'
import QRCode from 'qrcode'
import { ENV } from 'varlock/env'
import { buildPublicSiteMenuPayload } from '#app/utils/menu/public-menu-context.server.ts'
import { type PublicMenuItemData } from '#app/utils/menu/public-serializers.server.ts'
import { resolveSitesOrigin } from '#app/utils/reservations/sites-origin.server.ts'
import { getSignedGetRequestInfoAsync } from '#app/utils/storage.server.ts'
import { type PrintShopAccess } from './access.server.ts'
import { fetchQrTablesForPrint } from './qr-tables.server.ts'

/**
 * Resolves a design into the frozen `PrintSnapshot` a template renders:
 * brand colors and logo, copy per locale (operator text or the template
 * default), featured menu items with location prices, the address, and one
 * piece per printed item (a table card per table, with its QR URL). Images
 * are inlined as data URIs so the renderer needs no network access to the App.
 */

const MAX_IMAGE_BYTES = 3 * 1024 * 1024

export type PrintOrg = PrintShopAccess['organization']

export function orgSiteOrigin(org: PrintOrg): string {
	return resolveSitesOrigin({
		slug: org.slug,
		customDomain: org.customDomain,
		baseUrl: ENV.BASE_URL ?? '',
		hostSuffixes: (ENV as { PUBLIC_SITE_HOST_SUFFIXES?: string })
			.PUBLIC_SITE_HOST_SUFFIXES,
	})
}

export function orgLocales(org: PrintOrg) {
	return parseSiteLocalesConfig(org.siteLocales, org.siteDefaultLocale)
}

async function storageDataUri(
	objectKey: string,
	organizationId: string,
): Promise<string | null> {
	try {
		const { url, headers } = await getSignedGetRequestInfoAsync(
			objectKey,
			organizationId,
		)
		const response = await fetch(url, {
			headers,
			signal: AbortSignal.timeout(10_000),
		})
		if (!response.ok) return null
		const type = response.headers.get('content-type') ?? ''
		if (!/^image\/(png|jpe?g|webp|gif|svg\+xml|avif)/i.test(type)) return null
		const buffer = new Uint8Array(await response.arrayBuffer())
		if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) {
			return null
		}
		return `data:${type.split(';')[0]};base64,${Buffer.from(buffer).toString('base64')}`
	} catch {
		return null
	}
}

async function mediaObjectKey(
	organizationId: string,
	imageKey: string,
): Promise<string | null> {
	const [asset] = await db
		.select({ objectKey: OrganizationMediaAsset.objectKey })
		.from(OrganizationMediaAsset)
		.where(
			and(
				eq(OrganizationMediaAsset.organizationId, organizationId),
				or(
					eq(OrganizationMediaAsset.id, imageKey),
					eq(OrganizationMediaAsset.objectKey, imageKey),
				),
			),
		)
		.limit(1)
	return asset?.objectKey ?? null
}

function formatAddress(raw: string | null): string | null {
	if (!raw) return null
	try {
		const address = JSON.parse(raw) as LocationAddress | null
		if (!address) return null
		if (address.formattedAddress) return address.formattedAddress
		const line = [address.streetNumber, address.streetName]
			.filter(Boolean)
			.join(' ')
		return (
			[line, address.city, address.state].filter(Boolean).join(', ') || null
		)
	} catch {
		return null
	}
}

export async function listOrgLocations(organizationId: string) {
	return db
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
}

export type MenuItemChoice = {
	id: string
	name: string
	priceCents: number
	hasImage: boolean
}

/** Items of the location's live menus (no drops), with location prices. */
export async function listFeaturableItems(
	org: PrintOrg,
	locationId: string | null,
): Promise<{
	items: Array<MenuItemChoice & { raw: PublicMenuItemData }>
	currency: string
}> {
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
	const seen = new Map<string, MenuItemChoice & { raw: PublicMenuItemData }>()
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
				hasImage: Boolean(item.imageKey || item.imageUrl),
				raw: item,
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

function formatMoney(cents: number, currency: string, locale: string) {
	try {
		return new Intl.NumberFormat(locale, {
			style: 'currency',
			currency,
			// Prices print in Latin digits so they read the same in every copy.
			numberingSystem: 'latn',
		}).format(cents / 100)
	} catch {
		return `${(cents / 100).toFixed(2)} ${currency}`
	}
}

function siteUrl(origin: string, path: string, params: Record<string, string>) {
	const url = new URL(path, origin)
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value)
	}
	return url.toString()
}

async function resolvePieces(input: {
	request: Request
	org: PrintOrg
	designId: string
	target: PrintQrTarget
	product: PrintProductKey
}): Promise<{
	pieces: PrintPiece[]
	tables: PrintSnapshot['facts']['tables']
}> {
	const origin = orgSiteOrigin(input.org)
	const utm = printUtmParams(input.designId)
	const target = input.target
	switch (target.kind) {
		case 'table': {
			const tables = await fetchQrTablesForPrint(
				input.request,
				input.org.slug,
				target.tableIds,
			)
			return {
				pieces: tables.map((table) => ({
					tableLabel: table.label,
					qrUrl: qrTableUrl(origin, table.locationId, table.token, utm),
				})),
				tables: tables.map((table) => ({
					id: table.id,
					label: table.label,
					tokenVersion: table.tokenVersion,
				})),
			}
		}
		case 'menu':
			return {
				pieces: [
					{
						tableLabel: null,
						qrUrl: qrPosterUrl(origin, target.locationId, utm),
					},
				],
				tables: [],
			}
		case 'reservations':
			return {
				pieces: [
					{
						tableLabel: null,
						qrUrl: siteUrl(origin, '/reserve', {
							...(target.locationId ? { location: target.locationId } : {}),
							...utm,
						}),
					},
				],
				tables: [],
			}
		case 'site':
			return {
				pieces: [
					{ tableLabel: null, qrUrl: siteUrl(origin, target.path || '/', utm) },
				],
				tables: [],
			}
		default:
			return { pieces: [{ tableLabel: null, qrUrl: null }], tables: [] }
	}
}

export async function buildPrintSnapshot(input: {
	request: Request
	org: PrintOrg
	design: {
		id: string
		product: PrintProductKey
		sizeKey: string
		style: PrintTemplateStyle
		content: PrintDesignContent
	}
	/** Facts only (stale check): no logo or photo downloads. */
	skipImages?: boolean
}): Promise<PrintSnapshot> {
	const { org, design } = input
	const withImages = input.skipImages !== true
	const content = design.content
	const product = PRINT_PRODUCTS[design.product]
	const theme = solidEmailTheme(
		resolveEmailTheme({
			organizationName: org.name,
			siteTheme: org.siteTheme,
			mode: 'light',
		}),
	)
	const logoDataUri =
		withImages && org.siteIconKey
			? await storageDataUri(org.siteIconKey, org.id)
			: null

	const { locales: siteLocales, defaultLocale } = orgLocales(org)
	const locales = content.locales.filter((locale) =>
		(siteLocales as readonly string[]).includes(locale),
	)
	if (locales.length === 0) locales.push(defaultLocale)

	const copy = locales.map((locale) => {
		const defaults = defaultPrintCopy(locale, content.qr.kind)
		return {
			locale,
			dir: localeDirection(locale),
			headline: content.headline[locale]?.trim() || defaults.headline,
			body: content.body[locale]?.trim() ?? '',
			callToAction:
				content.callToAction[locale]?.trim() || defaults.callToAction,
			qrCaption: defaults.qrCaption,
			tableWord: printCopy(locale, 'table'),
		}
	})

	const locations = await listOrgLocations(org.id)
	const location =
		locations.find((candidate) => candidate.id === content.locationId) ??
		locations.find((candidate) => candidate.isDefault) ??
		locations[0] ??
		null

	let featured: PrintFeaturedItem[] = []
	const featuredFacts: PrintSnapshot['facts']['featured'] = []
	if (product.featuredItems && content.featuredItemIds.length > 0) {
		const { items, currency } = await listFeaturableItems(
			org,
			location?.id ?? null,
		)
		const byId = new Map(items.map((item) => [item.id, item]))
		const picked = content.featuredItemIds
			.map((id) => byId.get(id))
			.filter((item): item is NonNullable<typeof item> => Boolean(item))
		featured = await Promise.all(
			picked.map(async (item) => {
				const imageKey = item.raw.imageKey
				const objectKey =
					withImages && imageKey ? await mediaObjectKey(org.id, imageKey) : null
				const price = formatMoney(item.priceCents, currency, locales[0]!)
				featuredFacts.push({ id: item.id, name: item.name, price })
				return {
					id: item.id,
					name: item.name,
					price,
					imageDataUri: objectKey
						? await storageDataUri(objectKey, org.id)
						: null,
				}
			}),
		)
	}

	const { pieces, tables } = await resolvePieces({
		request: input.request,
		org,
		designId: design.id,
		target: content.qr,
		product: design.product,
	})

	const origin = orgSiteOrigin(org)
	return {
		product: design.product,
		sizeKey: design.sizeKey,
		style: design.style,
		templateVersion: PRINT_TEMPLATE_VERSION,
		brand: {
			name: org.name,
			logoDataUri,
			background: theme.background,
			foreground: theme.foreground,
			muted: theme.mutedForeground,
			primary: theme.primary,
			primaryForeground: theme.primaryForeground,
			accent: theme.accent,
			accentForeground: theme.accentForeground,
			headingFont: theme.headingFont,
			bodyFont: theme.bodyFont,
		},
		copy,
		featured,
		address: content.showAddress
			? formatAddress(location?.address ?? null)
			: null,
		website: content.showWebsite ? new URL(origin).host : null,
		pieces,
		facts: { featured: featuredFacts, tables },
	}
}

/** Stable hash of a snapshot (cache keys and order items). */
export function snapshotHash(snapshot: PrintSnapshot): string {
	return crypto
		.createHash('sha256')
		.update(JSON.stringify(snapshot))
		.digest('hex')
}

/** Inline QR SVG per piece: always black on white, for any scanner. */
export async function qrSvgsFor(
	snapshot: PrintSnapshot,
): Promise<Array<string | null>> {
	return Promise.all(
		snapshot.pieces.map((piece) =>
			piece.qrUrl
				? QRCode.toString(piece.qrUrl, {
						type: 'svg',
						margin: 0,
						errorCorrectionLevel: 'M',
						color: { dark: '#000000', light: '#ffffff' },
					})
				: Promise.resolve(null),
		),
	)
}

/** What changed since a snapshot was approved (re-order stale check). */
export function staleFacts(
	approved: PrintSnapshot,
	current: PrintSnapshot,
): string[] {
	const changes: string[] = []
	const now = new Map(current.facts.featured.map((item) => [item.id, item]))
	for (const item of approved.facts.featured) {
		const live = now.get(item.id)
		if (!live) changes.push(`featured:${item.id}:removed`)
		else if (live.price !== item.price)
			changes.push(`featured:${item.id}:price`)
		else if (live.name !== item.name) changes.push(`featured:${item.id}:name`)
	}
	const tablesNow = new Map(
		current.facts.tables.map((table) => [table.id, table]),
	)
	for (const table of approved.facts.tables) {
		const live = tablesNow.get(table.id)
		if (!live) changes.push(`table:${table.id}:removed`)
		else if (live.tokenVersion !== table.tokenVersion) {
			changes.push(`table:${table.id}:token`)
		} else if (live.label !== table.label)
			changes.push(`table:${table.id}:label`)
	}
	return changes
}
