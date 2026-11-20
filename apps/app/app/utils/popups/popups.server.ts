import { parseLocalizedString, pickLocalized } from '@repo/common/site-locales'
import {
	COUPON_NOT_VALID_ONLINE,
	couponValidOnline,
	type PublicSitePopup,
	type SitePopupInput,
} from '@repo/common/site-popup'
import {
	and,
	db,
	Discount,
	DiscountCode,
	eq,
	isNull,
	Organization,
	SitePopup,
} from '@repo/database'
import { discountUsageResponseSchema, localNowString } from '@repo/discounts'
import { loadCouponDiscountOptions } from '#app/utils/discounts/marketing-offers.server.ts'
import { mintDiscountToken } from '#app/utils/discounts/token.server.ts'
import { getSiteTimeZone } from '#app/utils/website/site-time-zone.server.ts'
import { isWebsiteFlagOn } from '#app/utils/website/website-flags.ts'

export const WEBSITE_POPUPS_FLAG = 'website.popups'

/** Popups are behind `website.popups` (default off). */
export function popupsEnabled(organizationId: string) {
	return isWebsiteFlagOn(organizationId, WEBSITE_POPUPS_FLAG)
}

export const MAX_POPUPS_PER_ORG = 50

/** How the region's counted uses are read; tests pass their own. */
export type UsageReader = (
	organization: { id: string; dataRegion: string | null },
	discountIds: string[],
) => Promise<Record<string, number> | null>

/**
 * Counted uses (reserved and consumed) per discount, asked of the region with
 * a server-minted read token. `null` when the region cannot say now: a limit
 * is then not held against the coupon (the region enforces it at checkout).
 */
export const readDiscountUses: UsageReader = async (organization, ids) => {
	if (ids.length === 0) return {}
	try {
		const { jwt, tenantApiUrl } = await mintDiscountToken({
			organizationId: organization.id,
			userId: 'popups',
			dataRegion: organization.dataRegion,
			held: ['read:discount:any'],
			locationIds: null,
			impersonated: false,
		})
		const url = new URL(
			`${tenantApiUrl.replace(/\/+$/, '')}/operator/discounts/usage`,
		)
		url.searchParams.set('ids', ids.join(','))
		const response = await fetch(url, {
			headers: { Accept: 'application/json', Authorization: `Bearer ${jwt}` },
			cache: 'no-store',
			signal: AbortSignal.timeout(3000),
		})
		if (!response.ok) return null
		const parsed = discountUsageResponseSchema.parse(await response.json())
		return Object.fromEntries(
			parsed.usage.map((entry) => [entry.discountId, entry.uses]),
		)
	} catch {
		return null
	}
}

type CouponCheck =
	| { ok: true; code: string }
	| {
			ok: false
			error: typeof COUPON_NOT_VALID_ONLINE | 'discount_unavailable'
	  }

/**
 * Whether a discount of this organization is a coupon a popup may carry right
 * now (#132): active, applied with a code, usable on the website, inside its
 * dates, not used up, with a code to show. Used when saving (a failure is
 * `coupon_not_valid_online`) and again for every public request (a coupon that
 * expired or was switched off stops the popup without an edit).
 */
export async function checkPopupCoupon(input: {
	organization: { id: string; dataRegion: string | null }
	discountId: string
	now?: Date
	readUses?: UsageReader
	timeZone?: string
}): Promise<CouponCheck> {
	const now = input.now ?? new Date()
	const [discount] = await db
		.select({
			id: Discount.id,
			status: Discount.status,
			application: Discount.application,
			channels: Discount.channels,
			startsAt: Discount.startsAt,
			endsAt: Discount.endsAt,
			totalLimit: Discount.totalLimit,
		})
		.from(Discount)
		.where(
			and(
				eq(Discount.id, input.discountId),
				eq(Discount.organizationId, input.organization.id),
			),
		)
		.limit(1)
	if (!discount) return { ok: false, error: 'discount_unavailable' }
	const codes = await db
		.select({ code: DiscountCode.code })
		.from(DiscountCode)
		.where(
			and(
				eq(DiscountCode.organizationId, input.organization.id),
				eq(DiscountCode.discountId, discount.id),
				isNull(DiscountCode.archivedAt),
			),
		)
		.orderBy(DiscountCode.createdAt, DiscountCode.id)
	let uses: number | null = null
	if (discount.totalLimit !== null) {
		const read = input.readUses ?? readDiscountUses
		uses =
			(await read(input.organization, [discount.id]))?.[discount.id] ?? null
	}
	let channels: string[] = []
	try {
		const parsed: unknown = JSON.parse(discount.channels)
		if (Array.isArray(parsed)) channels = parsed.map(String)
	} catch {
		channels = []
	}
	const timeZone =
		input.timeZone ?? (await getSiteTimeZone(input.organization.id))
	const valid = couponValidOnline({
		status: discount.status,
		application: discount.application,
		channels,
		startsAt: discount.startsAt,
		endsAt: discount.endsAt,
		localNow: localNowString(now.getTime(), timeZone),
		totalLimit: discount.totalLimit,
		uses,
		codes: codes.map((row) => row.code),
	})
	if (!valid) return { ok: false, error: COUPON_NOT_VALID_ONLINE }
	return { ok: true, code: codes[0]!.code }
}

export type PopupSaveResult =
	| { ok: true; id: string }
	| {
			ok: false
			error:
				| typeof COUPON_NOT_VALID_ONLINE
				| 'coupon_not_allowed'
				| 'limit_reached'
				| 'not_found'
	  }

/**
 * Creates or updates a popup. A coupon needs `read:discount:any` on top of
 * website editing (the same check as marketing coupons) and must be valid
 * online right now, or the save is refused with `coupon_not_valid_online`.
 * `unchangedDiscountId` lets a member without that permission save other
 * changes while the saved coupon stays as it is.
 */
export async function savePopup(input: {
	userId: string
	organization: { id: string; dataRegion: string | null }
	popupId: string | null
	values: SitePopupInput
	now?: Date
	readUses?: UsageReader
}): Promise<PopupSaveResult> {
	const { values, organization } = input
	let existing: { discountId: string | null } | null = null
	if (input.popupId) {
		const [row] = await db
			.select({ discountId: SitePopup.discountId })
			.from(SitePopup)
			.where(
				and(
					eq(SitePopup.id, input.popupId),
					eq(SitePopup.organizationId, organization.id),
				),
			)
			.limit(1)
		if (!row) return { ok: false, error: 'not_found' }
		existing = row
	} else {
		const count = await db
			.select({ id: SitePopup.id })
			.from(SitePopup)
			.where(eq(SitePopup.organizationId, organization.id))
		if (count.length >= MAX_POPUPS_PER_ORG) {
			return { ok: false, error: 'limit_reached' }
		}
	}
	if (values.discountId) {
		const unchanged = existing?.discountId === values.discountId
		if (!unchanged) {
			const options = await loadCouponDiscountOptions(
				input.userId,
				organization.id,
			)
			// Null: no `read:discount:any`, or discounts / coupons are off.
			if (!options) return { ok: false, error: 'coupon_not_allowed' }
			if (!options.some((option) => option.id === values.discountId)) {
				return { ok: false, error: COUPON_NOT_VALID_ONLINE }
			}
		}
		const check = await checkPopupCoupon({
			organization,
			discountId: values.discountId,
			now: input.now,
			readUses: input.readUses,
		})
		if (!check.ok) return { ok: false, error: COUPON_NOT_VALID_ONLINE }
	}
	const row = {
		name: values.name,
		title: values.title,
		body: values.body,
		buttonLabel: values.buttonLabel,
		buttonUrl: values.buttonUrl,
		imageUrl: values.imageUrl,
		discountId: values.discountId,
		trigger: values.trigger,
		triggerValue: values.triggerValue,
		frequency: values.frequency,
		pages: JSON.stringify(values.pages),
		startsAt: values.startsAt ? new Date(values.startsAt) : null,
		endsAt: values.endsAt ? new Date(values.endsAt) : null,
		captureContact: values.captureContact,
		consentText: values.consentText,
	}
	if (input.popupId) {
		await db
			.update(SitePopup)
			.set(row)
			.where(
				and(
					eq(SitePopup.id, input.popupId),
					eq(SitePopup.organizationId, organization.id),
				),
			)
		return { ok: true, id: input.popupId }
	}
	const [created] = await db
		.insert(SitePopup)
		.values({
			...row,
			organizationId: organization.id,
			createdById: input.userId,
		})
		.returning({ id: SitePopup.id })
	return { ok: true, id: created!.id }
}

/** Publishing re-checks the coupon: a popup never goes live with a dead one. */
export async function setPopupStatus(input: {
	organization: { id: string; dataRegion: string | null }
	popupId: string
	status: 'draft' | 'published'
	now?: Date
	readUses?: UsageReader
}): Promise<
	| { ok: true }
	| { ok: false; error: typeof COUPON_NOT_VALID_ONLINE | 'not_found' }
> {
	const [popup] = await db
		.select({ id: SitePopup.id, discountId: SitePopup.discountId })
		.from(SitePopup)
		.where(
			and(
				eq(SitePopup.id, input.popupId),
				eq(SitePopup.organizationId, input.organization.id),
			),
		)
		.limit(1)
	if (!popup) return { ok: false, error: 'not_found' }
	if (input.status === 'published' && popup.discountId) {
		const check = await checkPopupCoupon({
			organization: input.organization,
			discountId: popup.discountId,
			now: input.now,
			readUses: input.readUses,
		})
		if (!check.ok) return { ok: false, error: COUPON_NOT_VALID_ONLINE }
	}
	await db
		.update(SitePopup)
		.set({
			status: input.status,
			publishedAt:
				input.status === 'published' ? (input.now ?? new Date()) : null,
		})
		.where(eq(SitePopup.id, popup.id))
	return { ok: true }
}

export async function deletePopup(organizationId: string, popupId: string) {
	await db
		.delete(SitePopup)
		.where(
			and(
				eq(SitePopup.id, popupId),
				eq(SitePopup.organizationId, organizationId),
			),
		)
}

function parsePages(raw: string): PublicSitePopup['pages'] {
	try {
		const parsed: unknown = JSON.parse(raw)
		if (Array.isArray(parsed)) {
			const pages = parsed.filter(
				(page): page is PublicSitePopup['pages'][number] =>
					page === 'all' ||
					page === 'home' ||
					page === 'menu' ||
					page === 'other',
			)
			if (pages.length > 0) return pages
		}
	} catch {
		/* falls through */
	}
	return ['all']
}

/** A path on this site, or an https URL; anything else (javascript:, data:) is dropped. */
export function safePopupButtonUrl(url: string | null): string | null {
	if (!url) return null
	const trimmed = url.trim()
	if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed
	try {
		return new URL(trimmed).protocol === 'https:' ? trimmed : null
	} catch {
		return null
	}
}

/**
 * The published popups for the public site (#132), already localized. The
 * coupon is resolved here: its code is sent only while it is valid online, and
 * a popup whose coupon stopped working is left out, so the site never shows a
 * dead offer. The flag, the dates and the page rules are applied by Sites at
 * request time (the dates ride along).
 */
export async function loadPublicPopups(input: {
	organization: { id: string; dataRegion: string | null }
	locale: string
	defaultLocale: string
	now?: Date
	readUses?: UsageReader
}): Promise<PublicSitePopup[]> {
	if (!(await popupsEnabled(input.organization.id))) return []
	const rows = await db
		.select()
		.from(SitePopup)
		.where(
			and(
				eq(SitePopup.organizationId, input.organization.id),
				eq(SitePopup.status, 'published'),
			),
		)
	if (rows.length === 0) return []
	const timeZone = rows.some((row) => row.discountId)
		? await getSiteTimeZone(input.organization.id)
		: 'UTC'
	const text = (value: string) =>
		pickLocalized(
			parseLocalizedString(value, input.defaultLocale),
			input.locale,
			input.defaultLocale,
		)
	const popups: PublicSitePopup[] = []
	for (const row of rows) {
		let couponCode: string | null = null
		if (row.discountId) {
			const check = await checkPopupCoupon({
				organization: input.organization,
				discountId: row.discountId,
				now: input.now,
				readUses: input.readUses,
				timeZone,
			})
			if (!check.ok) continue
			couponCode = check.code
		}
		popups.push({
			id: row.id,
			title: text(row.title),
			body: text(row.body),
			buttonLabel: text(row.buttonLabel),
			buttonUrl: couponCode ? null : safePopupButtonUrl(row.buttonUrl),
			imageUrl: row.imageUrl,
			couponCode,
			trigger: row.trigger,
			triggerValue: row.triggerValue,
			frequency: row.frequency,
			pages: parsePages(row.pages),
			startsAt: row.startsAt?.toISOString() ?? null,
			endsAt: row.endsAt?.toISOString() ?? null,
			captureContact: row.captureContact,
			consentText: text(row.consentText),
		})
	}
	return popups
}

/** Every popup of the organization, for the Popups list. */
export async function listPopups(organizationId: string) {
	return db
		.select()
		.from(SitePopup)
		.where(eq(SitePopup.organizationId, organizationId))
		.orderBy(SitePopup.createdAt)
}

export async function loadOrganizationRegion(organizationId: string) {
	const [org] = await db
		.select({ id: Organization.id, dataRegion: Organization.dataRegion })
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	return org ?? null
}
