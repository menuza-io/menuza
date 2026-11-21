import { z } from 'zod'

/**
 * The monthly marketing text allowance (#247). Pure rules shared by the App
 * (the send step, the guard, Billing) and Admin (extra sends). A "send" is one
 * broadcast text to an audience, or one start of an automation text step; not
 * a segment. Transactional texts (order ready, booking reminders, codes) are
 * never counted. Extra packs are not sold; Admin can grant extra sends.
 */

/** Marketing text sends a plan includes per month per location, when the plan says nothing. */
export const DEFAULT_SMS_SENDS_PER_MONTH = 4

/**
 * What a plan includes, by lower-cased plan name, until plans are defined with
 * their modules (#127). A plan not listed (or none) gets the default.
 */
export const SMS_SENDS_BY_PLAN: Readonly<Record<string, number>> = {
	free: 2,
	starter: 4,
	basic: 4,
	growth: 12,
	pro: 20,
	premium: 20,
	scale: 40,
	enterprise: 100,
}

/** The most extra sends Admin grants in one go; a month rarely needs more than a few. */
export const MAX_SMS_GRANT = 100

export function smsSendsForPlan(planName: string | null | undefined): number {
	const key = planName?.trim().toLowerCase()
	return (
		(key ? SMS_SENDS_BY_PLAN[key] : undefined) ?? DEFAULT_SMS_SENDS_PER_MONTH
	)
}

export type BillingPeriod = {
	/** `YYYY-MM`. */
	key: string
	startsAt: number
	/** The first instant of the next month: when the allowance comes back. */
	resetsAt: number
}

/**
 * The billing month containing an instant. The subscription's own period is
 * not kept in the control plane yet, so a month is the UTC calendar month; the
 * rest of the code only ever asks this function.
 */
export function billingPeriod(ms: number): BillingPeriod {
	const date = new Date(ms)
	const year = date.getUTCFullYear()
	const month = date.getUTCMonth()
	return {
		key: `${year}-${String(month + 1).padStart(2, '0')}`,
		startsAt: Date.UTC(year, month, 1),
		resetsAt: Date.UTC(year, month + 1, 1),
	}
}

export function isPeriodKey(value: unknown): value is string {
	return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
}

export type SmsAllowance = {
	periodKey: string
	/** What the plan includes plus what Admin granted, per location. */
	limit: number
	extra: number
	/** Sends used in the period (each counts once for every location it reached). */
	used: number
	remaining: number
	resetsAt: number
}

export function smsAllowanceFrom(input: {
	planName: string | null | undefined
	period: BillingPeriod
	sends: number
	extraSends: number
}): SmsAllowance {
	const base = smsSendsForPlan(input.planName)
	const limit = base + Math.max(0, input.extraSends)
	return {
		periodKey: input.period.key,
		limit,
		extra: Math.max(0, input.extraSends),
		used: input.sends,
		remaining: Math.max(0, limit - input.sends),
		resetsAt: input.period.resetsAt,
	}
}

/** Where a region asks the App to spend, confirm or give back a send (#247). */
export const SMS_ALLOWANCE_PATH = '/resources/marketing/sms-allowance'

/**
 * `start`: the region is about to send this broadcast's first text; `release`:
 * it will not send (skipped as too late, or failed before anything went out).
 * Ids only: the schema is strict.
 */
export const SMS_ALLOWANCE_ACTIONS = ['start', 'release'] as const

export const smsAllowanceEventSchema = z
	.object({
		orgId: z.string().min(1).max(100),
		campaignId: z.string().min(1).max(100),
		action: z.enum(SMS_ALLOWANCE_ACTIONS),
	})
	.strict()
export type SmsAllowanceEvent = z.infer<typeof smsAllowanceEventSchema>

export const smsAllowanceResultSchema = z.union([
	z.object({ ok: z.literal(true) }).strict(),
	z
		.object({
			ok: z.literal(false),
			reason: z.literal('exhausted'),
			/** Epoch ms the allowance comes back: the region puts the send off until then. */
			resetsAt: z.number().int(),
		})
		.strict(),
])
export type SmsAllowanceResult = z.infer<typeof smsAllowanceResultSchema>
