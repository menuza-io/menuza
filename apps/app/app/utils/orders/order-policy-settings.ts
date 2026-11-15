/**
 * Location settings form for guest self-cancel (#111) and manual order
 * acceptance (#107): parses the posted fields into `OrganizationLocation`
 * column values. A group whose org flag is off is skipped entirely, so a
 * hidden or stale form cannot change it. A refusal names the field and a
 * code (the form words it in the reader's language); it never echoes what was
 * posted. Amounts and minutes may be typed with Arabic-Indic digits.
 */
import {
	DEFAULT_ORDER_ACCEPTANCE_TIMEOUT_MINUTES,
	GUEST_CANCEL_MAX_SCHEDULED_LEAD_MINUTES,
	GUEST_CANCEL_MINUTES_CHOICES,
	ORDER_ACCEPTANCE_MODES,
	ORDER_ACCEPTANCE_TIMEOUT_CHOICES,
} from '@repo/common/restaurant-orders'
import { z } from 'zod'
import { parseMoneyToMinor, parseWholeNumber } from '#app/utils/money-input.ts'

export type OrderPolicyPatch = {
	guestCancelMinutes?: number | null
	guestCancelScheduledLeadMinutes?: number | null
	orderAcceptanceMode?: 'auto' | 'manual'
	orderAcceptanceTimeoutMinutes?: number
	orderAcceptanceMinTotalCents?: number | null
	orderAcceptanceScheduledOnly?: boolean
}

/** The form fields a refusal can point at. */
export const ORDER_POLICY_FIELDS = [
	'guestCancelMinutes',
	'guestCancelScheduledLeadMinutes',
	'orderAcceptanceMode',
	'orderAcceptanceTimeoutMinutes',
	'orderAcceptanceMinTotal',
] as const
export type OrderPolicyField = (typeof ORDER_POLICY_FIELDS)[number]

/** Why a field was refused: not a listed choice, not minutes, not an amount. */
export type OrderPolicyErrorCode =
	'invalid_choice' | 'invalid_minutes' | 'invalid_amount'

export type OrderPolicyError = {
	field: OrderPolicyField
	code: OrderPolicyErrorCode
}

const ERROR_CODE: Record<OrderPolicyField, OrderPolicyErrorCode> = {
	guestCancelMinutes: 'invalid_choice',
	guestCancelScheduledLeadMinutes: 'invalid_minutes',
	orderAcceptanceMode: 'invalid_choice',
	orderAcceptanceTimeoutMinutes: 'invalid_choice',
	orderAcceptanceMinTotal: 'invalid_amount',
}

/** The largest minimum total: 999,999,999.99 in major units. */
const MAX_MIN_TOTAL_CENTS = 99_999_999_999

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
		if (blank === undefined || blank === null) return undefined
		return parseWholeNumber(String(blank)) ?? Number.NaN
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
	// Major units as typed (up to 2 decimals), read as cents; blank means
	// every order.
	orderAcceptanceMinTotal: z.preprocess((v) => {
		const blank = blankToUndefined(v)
		if (blank === undefined || blank === null) return undefined
		return parseMoneyToMinor(String(blank)) ?? Number.NaN
	}, z.number().int().min(0).max(MAX_MIN_TOTAL_CENTS).optional()),
	orderAcceptanceScheduledOnly: z.preprocess(
		(v) => v === 'true' || v === true,
		z.boolean(),
	),
})

export function parseOrderPolicyFields(
	raw: Record<string, unknown>,
	flags: { guestCancel: boolean; acceptance: boolean },
):
	| { ok: true; patch: OrderPolicyPatch }
	| ({ ok: false; error: string } & OrderPolicyError) {
	const patch: OrderPolicyPatch = {}

	if (flags.guestCancel) {
		const parsed = guestCancelSchema.safeParse(raw)
		if (!parsed.success) {
			return {
				ok: false,
				error: 'Check the guest cancel settings.',
				...refusal(parsed.error, 'guestCancelMinutes'),
			}
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
			return {
				ok: false,
				error: 'Check the order acceptance settings.',
				...refusal(parsed.error, 'orderAcceptanceMode'),
			}
		}
		const data = parsed.data
		patch.orderAcceptanceMode = data.orderAcceptanceMode
		patch.orderAcceptanceTimeoutMinutes = data.orderAcceptanceTimeoutMinutes
		patch.orderAcceptanceMinTotalCents = data.orderAcceptanceMinTotal ?? null
		patch.orderAcceptanceScheduledOnly = data.orderAcceptanceScheduledOnly
	}

	return { ok: true, patch }
}

/** The first refused field of a group and its code; never the posted value. */
function refusal(
	error: z.ZodError,
	fallback: OrderPolicyField,
): OrderPolicyError {
	const key = error.issues[0]?.path[0]
	const field = ORDER_POLICY_FIELDS.find((name) => name === key) ?? fallback
	return { field, code: ERROR_CODE[field] }
}
