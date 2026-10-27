import crypto from 'node:crypto'
import { resolveEmailTheme, solidEmailTheme } from '@repo/common/email-theme'
import {
	localeDirection,
	PRINT_TEMPLATE_VERSION,
	printSitePath,
	printUtmParams,
	type PrintDesignContent,
	type PrintFeaturedItem,
	type PrintPiece,
	type PrintPieceFact,
	type PrintProductKey,
	type PrintQrTarget,
	type PrintSnapshot,
	type PrintTemplateStyle,
} from '@repo/common/print-shop'
import { printCatalog } from '@repo/common/print-shop-catalog'
import { parseSiteLocalesConfig } from '@repo/common/site-locales'
import { and, db, eq, OrganizationMediaAsset, or } from '@repo/database'
import QRCode from 'qrcode'
import { ENV } from 'varlock/env'
import { resolveSitesOrigin } from '#app/utils/sites/sites-origin.server.ts'
import { getSignedGetRequestInfoAsync } from '#app/utils/storage.server.ts'
import { type PrintShopAccess } from './access.server.ts'
import { type PrintOrg, type PrintScope } from './vertical-contract.server.ts'
import { printVertical } from './vertical.server.ts'

/**
 * Resolves a design into the frozen `PrintSnapshot` a template renders:
 * brand colors and logo, copy per locale (operator text or the target's
 * default), featured items with their scope's prices, the scope's address,
 * and one piece per printed item with its QR URL (the print vertical
 * resolves its own targets). Images are inlined as data URIs so the
 * renderer needs no network access to the App.
 */

export type { PrintOrg }

const MAX_IMAGE_BYTES = 3 * 1024 * 1024

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

/** The vertical's scopes of the org (none without a vertical). */
export async function listPrintScopes(organizationId: string) {
	return (await printVertical.scopes?.list(organizationId)) ?? []
}

/** The design's scope, else the default one, else the first. */
export function pickScope(scopes: PrintScope[], scopeId: string | null) {
	return (
		scopes.find((scope) => scope.id === scopeId) ??
		scopes.find((scope) => scope.isDefault) ??
		scopes[0] ??
		null
	)
}

/** Items a page can feature, priced for a scope (none without a source). */
export async function listFeaturableItems(
	org: PrintOrg,
	scopeId: string | null,
) {
	return (
		(await printVertical.featuredItems?.list(org, scopeId)) ?? {
			items: [],
			currency: org.dataRegion === 'ksa' ? 'SAR' : 'USD',
		}
	)
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

/** The pieces and facts of a target: the core's own, or the vertical's. */
export async function resolvePrintPieces(input: {
	request: Request
	access: PrintShopAccess
	designId: string
	target: PrintQrTarget
}): Promise<{ pieces: PrintPiece[]; facts: PrintPieceFact[] }> {
	const siteOrigin = orgSiteOrigin(input.access.organization)
	const utm = printUtmParams(input.designId)
	const path = printSitePath(input.target)
	if (path !== null) {
		return {
			pieces: [{ label: null, qrUrl: siteUrl(siteOrigin, path || '/', utm) }],
			facts: [],
		}
	}
	const target = printVertical.qrTargets?.[input.target.kind]
	if (!target || input.target.kind === 'none') {
		return { pieces: [{ label: null, qrUrl: null }], facts: [] }
	}
	return target.resolve(input.target, {
		request: input.request,
		access: input.access,
		designId: input.designId,
		siteOrigin,
		utm,
	})
}

export async function buildPrintSnapshot(input: {
	request: Request
	access: PrintShopAccess
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
	const { design } = input
	const org = input.access.organization
	const withImages = input.skipImages !== true
	const content = design.content
	const product = printCatalog.products[design.product]
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
		const defaults = printCatalog.defaultCopy(locale, content.qr.kind)
		return {
			locale,
			dir: localeDirection(locale),
			headline: content.headline[locale]?.trim() || defaults.headline,
			body: content.body[locale]?.trim() ?? '',
			callToAction:
				content.callToAction[locale]?.trim() || defaults.callToAction,
			qrCaption: defaults.qrCaption,
			pieceWord: printCatalog.pieceWord(locale, content.qr.kind),
		}
	})

	const scope = pickScope(await listPrintScopes(org.id), content.scopeId)

	let featured: PrintFeaturedItem[] = []
	const featuredFacts: PrintSnapshot['facts']['featured'] = []
	if (product?.featuredItems && content.featuredItemIds.length > 0) {
		const { items, currency } = await listFeaturableItems(
			org,
			scope?.id ?? null,
		)
		const byId = new Map(items.map((item) => [item.id, item]))
		const picked = content.featuredItemIds
			.map((id) => byId.get(id))
			.filter((item): item is NonNullable<typeof item> => Boolean(item))
		featured = await Promise.all(
			picked.map(async (item) => {
				const objectKey =
					withImages && item.imageKey
						? await mediaObjectKey(org.id, item.imageKey)
						: null
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

	const { pieces, facts } = await resolvePrintPieces({
		request: input.request,
		access: input.access,
		designId: design.id,
		target: content.qr,
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
		address: content.showAddress ? (scope?.address ?? null) : null,
		website: content.showWebsite ? new URL(origin).host : null,
		qr: content.qr,
		pieces,
		facts: { featured: featuredFacts, pieces: facts },
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
	const piecesNow = new Map(
		(current.facts.pieces ?? []).map((piece) => [piece.id, piece]),
	)
	for (const piece of approved.facts.pieces ?? []) {
		const live = piecesNow.get(piece.id)
		if (!live) changes.push(`piece:${piece.id}:removed`)
		else if (live.version !== piece.version) {
			changes.push(`piece:${piece.id}:code`)
		} else if (live.label !== piece.label)
			changes.push(`piece:${piece.id}:label`)
	}
	return changes
}
