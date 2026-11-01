import {
	type DiscountCodeRecord,
	generateMarketingCode,
	type MarketingOffer,
	normalizeDiscountCode,
} from '@repo/discounts'
import {
	discountIssuedCodes,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'

type CodesDb = TenantDatabase | TenantTransaction

const DAY_MS = 24 * 60 * 60 * 1000
/** A fresh random code colliding is ~1 in 10^11; a few retries are plenty. */
const MINT_ATTEMPTS = 5

export type MarketingCodeSource = {
	sourceType: 'campaign' | 'journey'
	/** The broadcast id, or `<runId>:<nodeId>` for an automation step. */
	sourceId: string
	customerId: string
}

function randomBytes(length: number): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(length))
}

function isUniqueViolation(error: unknown): boolean {
	const text = String(
		(error as { message?: unknown } | null)?.message ?? error ?? '',
	)
	return /UNIQUE constraint failed/i.test(text)
}

async function findIssued(db: CodesDb, source: MarketingCodeSource) {
	return db
		.select({ code: discountIssuedCodes.code })
		.from(discountIssuedCodes)
		.where(
			and(
				eq(discountIssuedCodes.sourceType, source.sourceType),
				eq(discountIssuedCodes.sourceId, source.sourceId),
				eq(discountIssuedCodes.customerId, source.customerId),
			),
		)
		.get()
}

/**
 * The code `{{couponCode}}` shows one recipient. A shared offer is its code as
 * typed. A unique offer mints a single-use code once per message and
 * recipient: a retried send gets the same code back.
 */
export async function couponCodeForRecipient(
	db: CodesDb,
	offer: MarketingOffer,
	source: MarketingCodeSource,
	now: Date = new Date(),
): Promise<string> {
	if (offer.mode === 'shared') return offer.code.toUpperCase()

	const existing = await findIssued(db, source)
	if (existing) return existing.code

	const expiresAt = now.getTime() + offer.validDays * DAY_MS
	for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
		const { code, normalizedCode } = generateMarketingCode(
			offer.prefix,
			randomBytes,
		)
		try {
			await db.insert(discountIssuedCodes).values({
				discountId: offer.discountId,
				code,
				normalizedCode,
				sourceType: source.sourceType,
				sourceId: source.sourceId,
				customerId: source.customerId,
				expiresAt,
				createdAt: now.getTime(),
			})
			return code
		} catch (error) {
			if (!isUniqueViolation(error)) throw error
			// A concurrent send for the same recipient won the race: use its code.
			const raced = await findIssued(db, source)
			if (raced) return raced.code
			// Otherwise the random code collided; draw again.
		}
	}
	throw new Error('Could not mint a unique coupon code')
}

/**
 * The coupon codes an evaluation should see: the organization's own codes
 * from the order context and, when the typed code is none of them, the
 * unexpired single-use code a marketing message issued. An issued code counts
 * like a code with `maxUses: 1`; its uses are redemptions with its id as
 * `code_id`. The discount it points at must still be in the order context
 * (active, a code discount, coupons on), or the code is not found.
 */
export async function codesWithIssuedCode(
	db: CodesDb,
	contextCodes: readonly DiscountCodeRecord[],
	typedCode: string | null | undefined,
	now: Date = new Date(),
): Promise<readonly DiscountCodeRecord[]> {
	if (!typedCode) return contextCodes
	const normalized = normalizeDiscountCode(typedCode)
	if (normalized.length < 3 || normalized.length > 24) return contextCodes
	if (contextCodes.some((code) => code.normalizedCode === normalized)) {
		return contextCodes
	}
	const issued = await db
		.select({
			id: discountIssuedCodes.id,
			discountId: discountIssuedCodes.discountId,
			expiresAt: discountIssuedCodes.expiresAt,
		})
		.from(discountIssuedCodes)
		.where(eq(discountIssuedCodes.normalizedCode, normalized))
		.get()
	if (!issued || issued.expiresAt <= now.getTime()) return contextCodes
	return [
		...contextCodes,
		{
			id: issued.id,
			discountId: issued.discountId,
			normalizedCode: normalized,
			maxUses: 1,
		},
	]
}
