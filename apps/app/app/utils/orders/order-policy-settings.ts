/**
 * Location settings form for guest self-cancel (#111) and manual order
 * acceptance (#107): parses the posted fields into `OrganizationLocation`
 * column values. A group whose org flag is off is skipped entirely, so a
 * hidden or stale form cannot change it. Errors are fixed strings and never
 * echo what was posted.
 */
import {
	DEFAULT_ORDER_ACCEPTANCE_TIMEOUT_MINUTES,
	GUEST_CANCEL_MAX_SCHEDULED_LEAD_MINUTES,
	GUEST_CANCEL_MINUTES_CHOICES,
	ORDER_ACCEPTANCE_MODES,
	ORDER_ACCEPTANCE_TIMEOUT_CHOICES,
} from '@repo/common/restaurant-orders'
import { z } from 'zod'

export type OrderPolicyPatch = {
	guestCancelMinutes?: number | null
	guestCancelScheduledLeadMinutes?: number | null
	orderAcceptanceMode?: 'auto' | 'manual'
	orderAcceptanceTimeoutMinutes?: number
	orderAcceptanceMinTotalCents?: number | null
	orderAcceptanceScheduledOnly?: boolean
}

const blankToUndefined = (value: unknown) =>
	typeof value === 'string' && value.trim() === '' ? undefined : value

const guestCancelSchema = z.object({
	// '' or '0' is Off.
	guestCancelMinutes: z.preprocess(
		(v) => (v === '' || v === '0' || v == null ? 0 : Number(v)),
		z.union([
			z.literal(0),
			...GUEST_CANCEL_MINUTES_CHOICES.map((m) => z.literal(m)),
		] as [z.ZodLiteral<number>, ...z.ZodLiteral<number>[]]),
	),
	guestCancelScheduledLeadMinutes: z.preprocess((v) => {
		const blank = blankToUndefined(v)
		return blank === undefined || blank === null ? undefined : Number(blank)
	}, z.number().int().min(0).max(GUEST_CANCEL_MAX_SCHEDULED_LEAD_MINUTES).optional()),
})

const acceptanceSchema = z.object({
	orderAcceptanceMode: z.enum(ORDER_ACCEPTANCE_MODES),
	orderAcceptanceTimeoutMinutes: z.preprocess(
		(v) =>
			blankToUndefined(v) === undefined
				? DEFAULT_ORDER_ACCEPTANCE_TIMEOUT_MINUTES
				: Number(v),
		z.union(
			ORDER_ACCEPTANCE_TIMEOUT_CHOICES.map((m) => z.literal(m)) as [
				z.ZodLiteral<number>,
				...z.ZodLiteral<number>[],
			],
		),
	),
	// Major units as typed (up to 2 decimals); blank means every order.
	orderAcceptanceMinTotal: z.preprocess(
		(v) => {
			const blank = blankToUndefined(v)
			return blank === undefined || blank === null ? undefined : String(blank)
		},
		z
			.string()
			.regex(/^\d{1,9}(\.\d{1,2})?$/)
			.optional(),
	),
	orderAcceptanceScheduledOnly: z.preprocess(
		(v) => v === 'true' || v === true,
		z.boolean(),
	),
})

export function parseOrderPolicyFields(
	raw: Record<string, unknown>,
	flags: { guestCancel: boolean; acceptance: boolean },
): { ok: true; patch: OrderPolicyPatch } | { ok: false; error: string } {
	const patch: OrderPolicyPatch = {}

	if (flags.guestCancel) {
		const parsed = guestCancelSchema.safeParse(raw)
		if (!parsed.success) {
			return { ok: false, error: 'Check the guest cancel settings.' }
		}
		const { guestCancelMinutes, guestCancelScheduledLeadMinutes } = parsed.data
		patch.guestCancelMinutes =
			guestCancelMinutes === 0 ? null : guestCancelMinutes
		patch.guestCancelScheduledLeadMinutes =
			guestCancelMinutes === 0
				? null
				: (guestCancelScheduledLeadMinutes ?? null)
	}

	if (flags.acceptance) {
		const parsed = acceptanceSchema.safeParse(raw)
		if (!parsed.success) {
			return { ok: false, error: 'Check the order acceptance settings.' }
		}
		const data = parsed.data
		patch.orderAcceptanceMode = data.orderAcceptanceMode
		patch.orderAcceptanceTimeoutMinutes = data.orderAcceptanceTimeoutMinutes
		patch.orderAcceptanceMinTotalCents =
			data.orderAcceptanceMinTotal === undefined
				? null
				: Math.round(Number(data.orderAcceptanceMinTotal) * 100)
		patch.orderAcceptanceScheduledOnly = data.orderAcceptanceScheduledOnly
	}

	return { ok: true, patch }
}
