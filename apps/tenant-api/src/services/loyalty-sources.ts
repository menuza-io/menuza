import {
	type LoyaltyExcludedReason,
	type LoyaltyPurchaseSnapshot,
	type LoyaltyPurchaseSource,
	type LoyaltyReviewReason,
} from '@repo/loyalty'
import { type LoyaltyReader } from '../lib/loyalty-write.ts'
import { type RedemptionRow } from './loyalty-redemption-service.ts'

/**
 * How reconciliation reads an order, a QR tab or a till sale. An adapter turns
 * the authoritative source row into a verdict and never writes. It is read
 * again on every attempt, so a verdict always reflects the latest facts and a
 * repeated, late or out-of-order event cannot change the outcome.
 */
export type LoyaltySourceVerdict =
	/** Not finished yet, or not uploaded yet: nothing changes. */
	| { kind: 'open' }
	/** Confirmed unpaid (cancelled, voided, payment failed or expired). */
	| { kind: 'cancelled'; releaseReason: string }
	/** Payment or upload uncertain: an operator decides. */
	| { kind: 'review'; reason: LoyaltyReviewReason }
	/** Finished, but this source never earns; a held reward is given back. */
	| { kind: 'excluded'; reason: LoyaltyExcludedReason; releaseReason: string }
	/** Paid and finished. */
	| {
			kind: 'completed'
			occurredAt: number
			/** Offline sales only: when the region received the sale. */
			receivedAt: number | null
			snapshot: LoyaltyPurchaseSnapshot
			/** The loyalty discount the sale itself carries. */
			loyaltyDiscountMinor: number
			/** Set when the sale finished without its reward (paid at the counter). */
			releaseReason: string | null
			/**
			 * Finished, but an operator decides before it earns (a till sale that
			 * was flagged, or a reward that does not fit the sale). The reward the
			 * sale carries waits in review with it, its points still held.
			 */
			holdReason?: LoyaltyReviewReason | null
	  }

export type LoyaltySourceFacts = {
	currency: string
	/** What the customer pays (or paid) in total. */
	totalMinor: number
	/**
	 * Money returned so far: an online order's or a till sale's own refunds,
	 * or a QR tab's refunds recorded through loyalty.
	 */
	refundedMinor: number
	locationId: string | null
	verdict: LoyaltySourceVerdict
}

export type LoyaltySourceAdapter = {
	type: LoyaltyPurchaseSource
	/**
	 * `redemption` is the source's latest redemption in any state, so a sale
	 * that still carries a released reward's discount reads with its split.
	 * Null when the source does not exist (or is never a purchase of its own).
	 */
	read(
		db: LoyaltyReader,
		sourceId: string,
		context: { redemption: RedemptionRow | null; now: number },
	): Promise<LoyaltySourceFacts | null>
	/**
	 * For a source whose verdict changes with time alone (an unpaid order
	 * whose payment page is still open): the sources due to be reconciled
	 * again by `now`, and when the next one falls due. The tick queues them.
	 */
	timed?: {
		due(db: LoyaltyReader, now: number, limit: number): Promise<string[]>
		nextDueAt(db: LoyaltyReader): Promise<number | null>
	}
}
