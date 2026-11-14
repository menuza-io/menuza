/**
 * Per-location order policies the control plane sends the region in the order
 * context: guest self-cancel (#111) and manual order acceptance (#107). Policy
 * only (ids, numbers and flags), no PII.
 */
import {
	DEFAULT_ORDER_ACCEPTANCE_TIMEOUT_MINUTES,
	GUEST_CANCEL_MAX_SCHEDULED_LEAD_MINUTES,
	GUEST_CANCEL_MINUTES_CHOICES,
	ORDER_ACCEPTANCE_TIMEOUT_CHOICES,
	type GuestCancelContext,
	type GuestCancelMinutes,
	type OrderAcceptanceContext,
	type OrderAcceptancePolicy,
} from '@repo/common/restaurant-orders'

/** Org flag, default off, only a literal `true` counts. */
export const GUEST_CANCEL_FLAG_KEY = 'ordering.guest_cancel'

/** Org flag, default off, only a literal `true` counts. */
export const MANUAL_ACCEPTANCE_FLAG_KEY = 'ordering.manual_acceptance'

/** The `OrganizationLocation` columns these policies read. */
export type LocationOrderPolicyRow = {
	id: string
	guestCancelMinutes: number | null
	guestCancelScheduledLeadMinutes: number | null
	orderAcceptanceMode: string | null
	orderAcceptanceTimeoutMinutes: number | null
	orderAcceptanceMinTotalCents: number | null
	orderAcceptanceScheduledOnly: boolean | null
}

function isGuestCancelMinutes(value: unknown): value is GuestCancelMinutes {
	return (GUEST_CANCEL_MINUTES_CHOICES as readonly unknown[]).includes(value)
}

/**
 * `guestCancel` of the order context: only while the flag is on, only
 * locations whose minutes are one of 1, 2, 5, 10 (null, 0 or anything else is
 * off). A lead outside 0..1440 minutes reads as "same as ASAP" (null).
 */
export function foldGuestCancel(
	flag: unknown,
	rows: readonly LocationOrderPolicyRow[],
): GuestCancelContext {
	const out: GuestCancelContext = {}
	if (flag !== true) return out
	for (const row of rows) {
		if (!isGuestCancelMinutes(row.guestCancelMinutes)) continue
		const lead = row.guestCancelScheduledLeadMinutes
		out[row.id] = {
			minutes: row.guestCancelMinutes,
			scheduledLeadMinutes:
				typeof lead === 'number' &&
				Number.isInteger(lead) &&
				lead >= 0 &&
				lead <= GUEST_CANCEL_MAX_SCHEDULED_LEAD_MINUTES
					? lead
					: null,
		}
	}
	return out
}

/**
 * `acceptance` of the order context: only while the flag is on, only
 * locations set to `manual` (the region reads every other location as
 * Automatic). A timeout outside 3, 5, 10 reads as 5; a negative or
 * non-integer minimum as none.
 */
export function foldOrderAcceptance(
	flag: unknown,
	rows: readonly LocationOrderPolicyRow[],
): OrderAcceptanceContext {
	const out: OrderAcceptanceContext = {}
	if (flag !== true) return out
	for (const row of rows) {
		if (row.orderAcceptanceMode !== 'manual') continue
		const timeout = row.orderAcceptanceTimeoutMinutes
		const min = row.orderAcceptanceMinTotalCents
		out[row.id] = {
			mode: 'manual',
			timeoutMinutes: (
				ORDER_ACCEPTANCE_TIMEOUT_CHOICES as readonly unknown[]
			).includes(timeout)
				? (timeout as OrderAcceptancePolicy['timeoutMinutes'])
				: DEFAULT_ORDER_ACCEPTANCE_TIMEOUT_MINUTES,
			minTotalCents:
				typeof min === 'number' && Number.isInteger(min) && min >= 0
					? min
					: null,
			scheduledOnly: row.orderAcceptanceScheduledOnly === true,
		}
	}
	return out
}
