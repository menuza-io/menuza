import {
	DISCOUNTS_FLAG_KEYS,
	foldDiscountsFeatures,
} from '@repo/common/discounts-flags'
import { getFeatureFlag } from '@repo/common/feature-flags'
import {
	and,
	asc,
	db,
	Discount,
	DiscountCode,
	eq,
	isNull,
} from '@repo/database'
import {
	type OrderContextDiscounts,
	discountCodeRecordSchema,
	discountRecordSchema,
} from '@repo/discounts'
import {
	definitionFromRow,
	MAX_CODES_PER_ORG,
	MAX_DISCOUNTS_PER_ORG,
} from './discounts.server.ts'
import {
	type PublicMenuPromotion,
	publicPromotionFor,
} from './public-promotion.ts'

/**
 * The `discounts` field of `GET /resources/order-context`: active discount
 * definitions and their unarchived codes, for the regional node to evaluate.
 * No customer data. Features fold each sub-flag with `discounts.enabled`; a
 * switched-off sub-flag drops its discounts (and, for coupons, its codes).
 */

/** Placeholder `syncCodes` writes while swapping codes; no real code has a colon. */
const PARKED_CODE_PREFIX = 'parked:'
const MAX_DISCOUNTS = MAX_DISCOUNTS_PER_ORG
const MAX_CODES = MAX_CODES_PER_ORG
/**
 * `startsAt` and `endsAt` are local wall-clock times in each location's time
 * zone, and a location is anywhere from UTC-12 to UTC+14. Comparing them with
 * the UTC clock is wrong by up to that much, so this side only trims what no
 * zone could still show (`earliestLocalStamp`, `latestLocalStamp`); the exact
 * check is the region's (and the menu page's, in the location's zone).
 */
const MAX_OFFSET_BEHIND_MS = 12 * 60 * 60 * 1000
const MAX_OFFSET_AHEAD_MS = 14 * 60 * 60 * 1000

function stampAt(date: Date, offsetMs: number): string {
	return new Date(date.getTime() + offsetMs).toISOString().slice(0, 16)
}

/** The earliest wall-clock time any location shows at `now`. */
function earliestLocalStamp(now: Date): string {
	return stampAt(now, -MAX_OFFSET_BEHIND_MS)
}

/** The latest wall-clock time any location shows at `now`. */
function latestLocalStamp(now: Date): string {
	return stampAt(now, MAX_OFFSET_AHEAD_MS)
}

export async function buildOrderContextDiscounts(
	organizationId: string,
	now: Date = new Date(),
): Promise<OrderContextDiscounts> {
	const [enabled, automatic, coupons] = await Promise.all([
		getFeatureFlag(DISCOUNTS_FLAG_KEYS.enabled, { organizationId }),
		getFeatureFlag(DISCOUNTS_FLAG_KEYS.automatic, { organizationId }),
		getFeatureFlag(DISCOUNTS_FLAG_KEYS.coupons, { organizationId }),
	])
	const features = foldDiscountsFeatures({ enabled, automatic, coupons })
	if (!features.automatic && !features.coupons) {
		return {
			features: { automatic: features.automatic, coupons: features.coupons },
			discounts: [],
			codes: [],
		}
	}

	const [rows, codeRows] = await Promise.all([
		db
			.select()
			.from(Discount)
			.where(
				and(
					eq(Discount.organizationId, organizationId),
					eq(Discount.status, 'active'),
				),
			)
			.orderBy(asc(Discount.createdAt), asc(Discount.id)),
		// Only the codes of active discounts, so paused and archived discounts
		// (which keep their unarchived codes) never use up the cap. One past the
		// cap is read to tell that it was hit.
		features.coupons
			? db
					.select({
						id: DiscountCode.id,
						discountId: DiscountCode.discountId,
						normalizedCode: DiscountCode.normalizedCode,
						maxUses: DiscountCode.maxUses,
					})
					.from(DiscountCode)
					.innerJoin(Discount, eq(DiscountCode.discountId, Discount.id))
					.where(
						and(
							eq(DiscountCode.organizationId, organizationId),
							isNull(DiscountCode.archivedAt),
							eq(Discount.organizationId, organizationId),
							eq(Discount.status, 'active'),
						),
					)
					.orderBy(asc(DiscountCode.createdAt), asc(DiscountCode.id))
					.limit(MAX_CODES + 1)
			: Promise.resolve([]),
	])

	const earliestEnd = earliestLocalStamp(now)
	const discounts: OrderContextDiscounts['discounts'] = []
	for (const row of rows) {
		if (discounts.length >= MAX_DISCOUNTS) {
			// Counts only. Creating past the cap is refused, so this means rows
			// from before the cap or a changed limit: the newest are left out.
			console.warn(
				`order-context: discount cap ${MAX_DISCOUNTS} reached for organization ${organizationId} (${rows.length} active)`,
			)
			break
		}
		if (row.application === 'automatic' && !features.automatic) continue
		if (row.application === 'code' && !features.coupons) continue
		// Manual discounts are the till's (phase 3); the region never sees them.
		if (row.application !== 'automatic' && row.application !== 'code') continue
		if (row.endsAt && row.endsAt <= earliestEnd) continue
		const definition = definitionFromRow(row)
		const record = definition
			? discountRecordSchema.safeParse({
					...definition,
					id: row.id,
					version: row.version,
					createdAt: row.createdAt.toISOString(),
				})
			: null
		if (!record?.success) {
			// Ids only: a broken row must not take ordering down.
			console.warn(`order-context: skipping invalid discount ${row.id}`)
			continue
		}
		discounts.push(record.data)
	}

	const kept = new Set(discounts.map((discount) => discount.id))
	const codes: OrderContextDiscounts['codes'] = []
	if (codeRows.length > MAX_CODES) {
		console.warn(
			`order-context: code cap ${MAX_CODES} reached for organization ${organizationId}; the newest codes are left out`,
		)
	}
	for (const code of codeRows) {
		if (codes.length >= MAX_CODES) break
		if (!kept.has(code.discountId)) continue
		// `syncCodes` parks a renamed code as `parked:<id>` while swapping; if a
		// Worker died mid-swap the row stays. It is never a real code, and the
		// region's schema would reject it (and, before it parsed per row, every
		// discount with it), so it is never sent.
		if (code.normalizedCode.startsWith(PARKED_CODE_PREFIX)) {
			console.warn(`order-context: skipping parked code row ${code.id}`)
			continue
		}
		const parsed = discountCodeRecordSchema.safeParse({
			id: code.id,
			discountId: code.discountId,
			normalizedCode: code.normalizedCode,
			maxUses: code.maxUses,
		})
		if (!parsed.success) {
			// Ids only, never the code value.
			console.warn(`order-context: skipping invalid code row ${code.id}`)
			continue
		}
		codes.push(parsed.data)
	}

	return {
		features: { automatic: features.automatic, coupons: features.coupons },
		discounts,
		codes,
	}
}

export { type PublicMenuPromotion } from './public-promotion.ts'

/**
 * Promotions for the public menu, and till rules (automatic and manual,
 * channel `pos`). The public menu sends promotions only. A paired terminal
 * loads `discountRules` from tenant-api. Codes stay off the till payload and
 * off the menu except the first code of a code discount the operator chose to
 * promote.
 */
export async function buildPublicMenuDiscounts(
	organizationId: string,
	now: Date = new Date(),
): Promise<{
	promotions: PublicMenuPromotion[]
	discountRules: OrderContextDiscounts['discounts']
}> {
	const empty = { promotions: [], discountRules: [] }
	const [enabled, automatic, coupons] = await Promise.all([
		getFeatureFlag(DISCOUNTS_FLAG_KEYS.enabled, { organizationId }),
		getFeatureFlag(DISCOUNTS_FLAG_KEYS.automatic, { organizationId }),
		getFeatureFlag(DISCOUNTS_FLAG_KEYS.coupons, { organizationId }),
	])
	const features = foldDiscountsFeatures({ enabled, automatic, coupons })
	if (!features.enabled) return empty

	const [rows, codeRows] = await Promise.all([
		db
			.select()
			.from(Discount)
			.where(
				and(
					eq(Discount.organizationId, organizationId),
					eq(Discount.status, 'active'),
				),
			)
			.orderBy(asc(Discount.priority), asc(Discount.createdAt)),
		features.coupons
			? db
					.select()
					.from(DiscountCode)
					.where(
						and(
							eq(DiscountCode.organizationId, organizationId),
							isNull(DiscountCode.archivedAt),
						),
					)
					.orderBy(asc(DiscountCode.createdAt), asc(DiscountCode.id))
			: Promise.resolve([]),
	])
	// A promoted code discount may show one code on the menu. Only a single
	// reusable code is safe to publish; bulk or single-use sets stay hidden.
	const codesByDiscount = new Map<
		string,
		{ code: string; maxUses: number | null }[]
	>()
	for (const code of codeRows) {
		if (code.normalizedCode.startsWith(PARKED_CODE_PREFIX)) continue
		const list = codesByDiscount.get(code.discountId) ?? []
		list.push({ code: code.code, maxUses: code.maxUses ?? null })
		codesByDiscount.set(code.discountId, list)
	}
	const publicCodeFor = (discountId: string): string | null => {
		const list = codesByDiscount.get(discountId)
		if (!list || list.length !== 1) return null
		const [only] = list
		if (!only || only.maxUses !== null) return null
		return only.code
	}
	const latestStart = latestLocalStamp(now)
	const earliestEnd = earliestLocalStamp(now)
	const promotions: PublicMenuPromotion[] = []
	const discountRules: OrderContextDiscounts['discounts'] = []
	for (const row of rows) {
		const definition = definitionFromRow(row)
		if (!definition) continue
		const record = discountRecordSchema.safeParse({
			...definition,
			id: row.id,
			version: row.version,
			createdAt: row.createdAt.toISOString(),
		})
		if (!record.success) continue
		const data = record.data
		const onWebsite =
			data.promoteOnMenu &&
			(data.channels.includes('web') || data.channels.includes('qr')) &&
			(!data.startsAt || data.startsAt <= latestStart) &&
			(!data.endsAt || data.endsAt > earliestEnd) &&
			((data.application === 'automatic' && features.automatic) ||
				(data.application === 'code' && features.coupons))
		const promotion = onWebsite
			? publicPromotionFor(data, { code: publicCodeFor(data.id) })
			: null
		if (promotion) promotions.push(promotion)
		const onTill =
			data.channels.includes('pos') &&
			((data.application === 'automatic' && features.automatic) ||
				data.application === 'manual')
		if (onTill) discountRules.push(data)
	}
	return { promotions, discountRules }
}
