import { userHasOrganizationPermission } from '@repo/auth'
import {
	and,
	asc,
	db,
	Discount,
	DiscountCode,
	eq,
	inArray,
	isNull,
} from '@repo/database'
import {
	type MarketingOffer,
	marketingOfferSchema,
	normalizeDiscountCode,
	parseMarketingOffer,
	usesCouponCodeTag,
} from '@repo/discounts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { getDiscountsFeatures } from './access.server.ts'
import { definitionFromRow } from './discounts.server.ts'
import {
	discountVisibleInScope,
	resolveDiscountLocationIds,
} from './location-scope.server.ts'
import { type MarketingOfferError } from './marketing-offer-labels.ts'

/**
 * Coupons in marketing messages. A broadcast or an automation email or text
 * step can carry a coupon discount; `{{couponCode}}` shows its code (one
 * shared code, or a unique single-use code the region mints per recipient).
 *
 * Attaching one needs the `discounts.enabled` and `discounts.coupons` flags
 * and `read:discount:any` on top of the marketing permission, and only an
 * active discount applied with a code qualifies. The region checks the
 * discount again at checkout, so pausing or archiving it later stops the
 * codes that went out.
 */

export type CouponDiscountOption = {
	id: string
	name: string
	codes: string[]
}

/**
 * The picker's choices, or null when this user cannot attach coupons. A member
 * scoped to some locations sees only the discounts the Discounts page shows
 * them (`discountVisibleInScope`), so the picker never hands them the codes of
 * a discount for other locations.
 */
export async function loadCouponDiscountOptions(
	userId: string,
	organizationId: string,
): Promise<CouponDiscountOption[] | null> {
	const canRead = await userHasOrganizationPermission(
		userId,
		organizationId,
		ORG_PERMISSIONS.READ_DISCOUNT_ANY,
	)
	if (!canRead) return null
	const locationIds = await resolveDiscountLocationIds(userId, organizationId)
	return loadCodeDiscounts(organizationId, locationIds)
}

/**
 * Active discounts applied with a code, with their unarchived codes, that a
 * member with these locations may see (`null`: every location). Null while
 * the organization's discounts or coupons are off. A row that no longer
 * parses is left out: checkout skips it too.
 */
async function loadCodeDiscounts(
	organizationId: string,
	operatorLocationIds: readonly string[] | null,
): Promise<CouponDiscountOption[] | null> {
	const features = await getDiscountsFeatures(organizationId)
	if (!features.enabled || !features.coupons) return null

	const rows = await db
		.select()
		.from(Discount)
		.where(
			and(
				eq(Discount.organizationId, organizationId),
				eq(Discount.status, 'active'),
				eq(Discount.application, 'code'),
			),
		)
		.orderBy(asc(Discount.name), asc(Discount.id))
	const discounts = rows.flatMap((row) => {
		const definition = definitionFromRow(row)
		if (
			!definition ||
			!discountVisibleInScope(definition.locationIds, operatorLocationIds)
		) {
			return []
		}
		return [{ id: row.id, name: row.name }]
	})
	if (discounts.length === 0) return []

	const codes = await db
		.select({ discountId: DiscountCode.discountId, code: DiscountCode.code })
		.from(DiscountCode)
		.where(
			and(
				eq(DiscountCode.organizationId, organizationId),
				isNull(DiscountCode.archivedAt),
				inArray(
					DiscountCode.discountId,
					discounts.map((discount) => discount.id),
				),
			),
		)
		.orderBy(asc(DiscountCode.createdAt), asc(DiscountCode.id))
	const byDiscount = new Map<string, string[]>()
	for (const row of codes) {
		const list = byDiscount.get(row.discountId) ?? []
		list.push(row.code)
		byDiscount.set(row.discountId, list)
	}
	return discounts.map((discount) => ({
		id: discount.id,
		name: discount.name,
		codes: byDiscount.get(discount.id) ?? [],
	}))
}

export type MarketingOfferCheck =
	| { ok: true; offer: MarketingOffer | null }
	| { ok: false; error: MarketingOfferError }

/** Reads the posted offer: empty means none. */
export function readOfferField(value: unknown): unknown {
	if (value === null || value === undefined) return null
	if (typeof value !== 'string') return value
	if (!value.trim()) return null
	try {
		return JSON.parse(value) as unknown
	} catch {
		return { invalid: true }
	}
}

type OfferOptions = CouponDiscountOption[] | null

/**
 * Checks a message's coupon before it is saved or sent: the shape, the
 * user's right to attach it, the discount (this organization's, active,
 * applied with a code) and, for a shared code, that the code is one of its
 * unarchived codes. `texts` are the message parts `{{couponCode}}` may sit in:
 * a coupon needs the tag, and the tag needs a coupon.
 */
export async function checkMarketingOffer(input: {
	userId: string
	organizationId: string
	raw: unknown
	texts: ReadonlyArray<string | null | undefined>
	/**
	 * The coupon is already saved on this message exactly as sent, so a user
	 * without `read:discount:any` can still save other changes. The discount
	 * is still checked.
	 */
	unchanged?: boolean
	/** Reused across the nodes of one automation. */
	cache?: { options?: OfferOptions; all?: OfferOptions }
}): Promise<MarketingOfferCheck> {
	const usesTag = usesCouponCodeTag(...input.texts)
	if (input.raw === null || input.raw === undefined) {
		return usesTag
			? { ok: false, error: 'offer_missing' }
			: { ok: true, offer: null }
	}
	const parsed = marketingOfferSchema.safeParse(input.raw)
	if (!parsed.success) return { ok: false, error: 'invalid' }
	const offer = parsed.data
	if (!usesTag) return { ok: false, error: 'tag_missing' }

	const cache = input.cache ?? {}
	let options: OfferOptions
	if (input.unchanged) {
		if (cache.all === undefined) {
			cache.all = await loadCodeDiscounts(input.organizationId, null)
		}
		options = cache.all
	} else {
		if (cache.options === undefined) {
			cache.options = await loadCouponDiscountOptions(
				input.userId,
				input.organizationId,
			)
		}
		options = cache.options
	}
	if (!options) return { ok: false, error: 'not_allowed' }
	const discount = options.find((option) => option.id === offer.discountId)
	if (!discount) return { ok: false, error: 'discount_unavailable' }
	if (offer.mode === 'shared') {
		const wanted = normalizeDiscountCode(offer.code)
		const code = discount.codes.find(
			(entry) => normalizeDiscountCode(entry) === wanted,
		)
		if (!code) return { ok: false, error: 'code_unavailable' }
		return { ok: true, offer: { ...offer, code } }
	}
	return { ok: true, offer }
}

type JourneyNode = { id?: unknown; type?: unknown; data?: unknown }

function nodeTexts(node: JourneyNode): string[] {
	const data = (node.data ?? {}) as Record<string, unknown>
	const keys =
		node.type === 'action_email'
			? ['subject', 'bodyHtml', 'bodyText']
			: ['messageText', 'content']
	return keys
		.map((key) => data[key])
		.filter((value): value is string => typeof value === 'string')
}

/**
 * Checks the coupon of every email and text step of an automation and
 * returns the nodes with each coupon in its checked form (or removed when
 * there is none). The first refusal wins.
 */
export async function checkJourneyOffers(input: {
	userId: string
	organizationId: string
	nodes: readonly unknown[]
	storedNodes: readonly unknown[]
}): Promise<
	{ ok: true; nodes: unknown[] } | { ok: false; error: MarketingOfferError }
> {
	const stored = new Map<string, string>()
	for (const node of input.storedNodes as JourneyNode[]) {
		const offer = (node?.data as { discountOffer?: unknown } | undefined)
			?.discountOffer
		if (typeof node?.id === 'string' && offer) {
			stored.set(node.id, JSON.stringify(offer))
		}
	}
	const cache: { options?: OfferOptions; all?: OfferOptions } = {}
	const nodes: unknown[] = []
	for (const raw of input.nodes) {
		const node = raw as JourneyNode
		if (
			!node ||
			typeof node !== 'object' ||
			(node.type !== 'action_email' && node.type !== 'action_sms')
		) {
			nodes.push(raw)
			continue
		}
		const data = { ...((node.data ?? {}) as Record<string, unknown>) }
		const offerRaw = data.discountOffer ?? null
		const check = await checkMarketingOffer({
			userId: input.userId,
			organizationId: input.organizationId,
			raw: offerRaw,
			texts: nodeTexts(node),
			unchanged:
				typeof node.id === 'string' &&
				offerRaw !== null &&
				stored.get(node.id) === JSON.stringify(offerRaw),
			cache,
		})
		if (!check.ok) return check
		if (check.offer) data.discountOffer = check.offer
		else delete data.discountOffer
		nodes.push({ ...node, data })
	}
	return { ok: true, nodes }
}

/**
 * What the broadcast page says about its coupon. The discount's name is read
 * from this organization only; a deleted or foreign id shows no name. A shared
 * code is shown only to members with `read:discount:any`, the permission that
 * lets them attach it: anyone who may view the broadcast sees that it carried
 * one, not the code itself (`code: null`).
 */
export async function describeCampaignCoupon(
	organizationId: string,
	raw: unknown,
	viewer: { userId: string },
): Promise<
	| { mode: 'shared'; discountName: string | null; code: string | null }
	| { mode: 'unique'; discountName: string | null; validDays: number }
	| null
> {
	const offer = parseMarketingOffer(raw)
	if (!offer) return null
	const canSeeCode =
		offer.mode === 'shared' &&
		(await userHasOrganizationPermission(
			viewer.userId,
			organizationId,
			ORG_PERMISSIONS.READ_DISCOUNT_ANY,
		))
	const [row] = await db
		.select({ name: Discount.name })
		.from(Discount)
		.where(
			and(
				eq(Discount.organizationId, organizationId),
				eq(Discount.id, offer.discountId),
			),
		)
		.limit(1)
	const discountName = row?.name ?? null
	return offer.mode === 'shared'
		? { mode: 'shared', discountName, code: canSeeCode ? offer.code : null }
		: { mode: 'unique', discountName, validDays: offer.validDays }
}
