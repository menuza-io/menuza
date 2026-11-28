import { z } from 'zod'

/**
 * Requests to cancel locations, cancel the organization or move to a smaller
 * plan (#379). A request only ever records what the owner asked for: nothing is
 * cancelled, charged, refunded or deleted when it is made. It takes effect at
 * the end of the billing period (the cutoff the owner saw before confirming),
 * and Menuza support acts on it by hand. No guest data is involved.
 */

export const CANCEL_REQUEST_KINDS = [
	'cancel_locations',
	'cancel_organization',
	'downgrade',
] as const
export type CancelRequestKind = (typeof CANCEL_REQUEST_KINDS)[number]

export const CANCEL_REQUEST_STATUSES = [
	'requested',
	'withdrawn',
	'handled',
] as const
export type CancelRequestStatus = (typeof CANCEL_REQUEST_STATUSES)[number]

/** Reason, then a sub-reason that narrows it. Ids are stored; words are written per surface. */
export const CANCEL_REASONS = {
	too_expensive: ['price_too_high', 'not_enough_sales', 'found_cheaper'],
	missing_features: ['ordering', 'reports', 'integrations', 'something_else'],
	closing_or_seasonal: ['closing_for_good', 'seasonal', 'selling_the_business'],
	switching: ['other_platform', 'doing_it_in_house'],
	service: ['support', 'reliability', 'hard_to_use'],
	other: [],
} as const satisfies Record<string, readonly string[]>
export type CancelReason = keyof typeof CANCEL_REASONS
export const CANCEL_REASON_IDS = Object.keys(CANCEL_REASONS) as [
	CancelReason,
	...CancelReason[],
]

export function isSubReasonOf(reason: CancelReason, subReason: string) {
	return (CANCEL_REASONS[reason] as readonly string[]).includes(subReason)
}

/** Plain English, for Admin and support. The App words each reason in the viewer's language. */
export const CANCEL_REASON_LABELS_EN: Record<CancelReason, string> = {
	too_expensive: 'Too expensive',
	missing_features: 'Missing features',
	closing_or_seasonal: 'Closing or seasonal',
	switching: 'Switching to something else',
	service: 'Service or reliability',
	other: 'Something else',
}
export const CANCEL_SUB_REASON_LABELS_EN: Record<string, string> = {
	price_too_high: 'The price is too high for us',
	not_enough_sales: 'Not enough sales to justify it',
	found_cheaper: 'Found something cheaper',
	ordering: 'Ordering features',
	reports: 'Reports',
	integrations: 'Integrations',
	something_else: 'Something else is missing',
	closing_for_good: 'Closing for good',
	seasonal: 'Seasonal: coming back later',
	selling_the_business: 'Selling the business',
	other_platform: 'Moving to another platform',
	doing_it_in_house: 'Doing it in house',
	support: 'Support',
	reliability: 'Reliability',
	hard_to_use: 'Hard to use',
}
export const CANCEL_KIND_LABELS_EN: Record<CancelRequestKind, string> = {
	cancel_locations: 'Cancel locations',
	cancel_organization: 'Cancel the organization',
	downgrade: 'Downgrade',
}

export const CANCEL_NOTE_MAX = 500

/**
 * What the owner sends. `confirm` must be literally `true`: the form's
 * confirmation checkbox, shown after the cutoff date.
 */
export const cancelRequestInputSchema = z
	.object({
		kind: z.enum(CANCEL_REQUEST_KINDS),
		locationIds: z.array(z.string().min(1).max(64)).max(200).default([]),
		targetPlan: z.string().trim().min(1).max(80).nullish(),
		reason: z.enum(CANCEL_REASON_IDS),
		subReason: z.string().trim().max(40).nullish(),
		note: z.string().trim().max(CANCEL_NOTE_MAX).nullish(),
		confirm: z.literal(true),
	})
	.superRefine((value, ctx) => {
		if (value.kind === 'cancel_locations' && value.locationIds.length === 0) {
			ctx.addIssue({
				code: 'custom',
				path: ['locationIds'],
				message: 'choose_locations',
			})
		}
		if (value.kind === 'downgrade' && !value.targetPlan) {
			ctx.addIssue({
				code: 'custom',
				path: ['targetPlan'],
				message: 'choose_plan',
			})
		}
		if (value.subReason && !isSubReasonOf(value.reason, value.subReason)) {
			ctx.addIssue({
				code: 'custom',
				path: ['subReason'],
				message: 'invalid_sub_reason',
			})
		}
	})
export type CancelRequestInput = z.infer<typeof cancelRequestInputSchema>

/** The retention offer is the plain words of one setting: no markup, no links. */
export const RETENTION_OFFER_MAX = 400
export function cleanRetentionOffer(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const text = value.replace(/[<>]/g, '').trim().slice(0, RETENTION_OFFER_MAX)
	return text.length > 0 ? text : null
}

/** The feature flag key holding the retention offer text (platform or per organization). */
export const RETENTION_OFFER_FLAG = 'billing.retention_offer'
