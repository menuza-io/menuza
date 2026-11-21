import {
	starterTextBlockIds,
	hasBoilerplatePhrase,
} from './email-boilerplate.ts'
import { restaurantBlockProblems } from './email-blocks-restaurant.ts'
import { type EmailBlock } from './email-blocks.ts'

/**
 * What is wrong with a broadcast before it goes out (#232). Pure, so the App
 * (when the operator presses Send or Schedule) and tenant-api (again when the
 * send starts) judge the same message the same way.
 *
 * Blocking problems cannot be overridden. A warning can be: the operator may
 * choose Edit or Send anyway.
 */

export type BroadcastProblemCode =
	/** Warnings */
	| 'starter_text'
	| 'boilerplate_phrase'
	/** Another broadcast in the same window targets many of the same guests (#393). */
	| 'audience_overlap'
	/** Blocking */
	| 'empty_message'
	| 'empty_image'
	| 'empty_button_link'
	| 'empty_menu_item'
	| 'empty_coupon'
	| 'coupon_missing'
	| 'coupon_paused'
	| 'coupon_ended_before_send'
	| 'audience_zero'
	/** A push holds no personal data: no merge tags (#105). */
	| 'push_merge_tags'

export type BroadcastProblem = {
	code: BroadcastProblemCode
	severity: 'blocking' | 'warning'
	/** The designer block to open, when the problem is in one. */
	blockId?: string
	/** With `audience_overlap`: which broadcast, and how many guests they share. */
	overlap?: BroadcastOverlap
}

/**
 * Another broadcast in the window that targets many of the same guests (#393).
 * Counts and the broadcast's own name and time only: the region computes the
 * overlap and never sends a guest to the control plane.
 */
export type BroadcastOverlap = {
	campaignId: string
	/** The operator's own title of the other broadcast. */
	name: string
	channel: 'email' | 'sms' | 'push'
	/** When it goes out (epoch ms); null while it is sending now. */
	scheduledAt: number | null
	/** Guests both would reach. */
	overlapCount: number
	/** Guests this broadcast would reach, and the other one. */
	audienceCount: number
	otherAudienceCount: number
}

/** The window either side of a send inside which two broadcasts are compared. */
export const OVERLAP_WINDOW_MS = 24 * 60 * 60 * 1000
/** At least this many shared guests... */
export const OVERLAP_MIN_GUESTS = 5
/** ...and at least this share of the smaller audience is "many". */
export const OVERLAP_MIN_SHARE = 0.5

export function isManyOverlap(
	overlapCount: number,
	audienceCount: number,
	otherAudienceCount: number,
) {
	const smaller = Math.min(audienceCount, otherAudienceCount)
	return (
		overlapCount >= OVERLAP_MIN_GUESTS &&
		smaller > 0 &&
		overlapCount / smaller >= OVERLAP_MIN_SHARE
	)
}

/** What the control plane knows about the message's coupon (the App checks it). */
export type BroadcastCouponState = 'ok' | 'paused' | 'ended_before_send'

export type BroadcastCheckInput = {
	channel: 'email' | 'sms' | 'push'
	subject?: string | null
	content: string
	contentHtml?: string | null
	/** The designer's blocks, parsed. Absent for SMS and for plain email. */
	blocks?: readonly EmailBlock[] | null
	/** The message carries a coupon (`discountOffer`). */
	hasOffer: boolean
	/** The message uses the `{{couponCode}}` tag. */
	usesCouponTag: boolean
	/** Checked by the App against the discount; tenant-api cannot see it. */
	couponState?: BroadcastCouponState
	/** Recipients now; null when not known (not checked). */
	audienceCount: number | null
	/**
	 * Other broadcasts in the same window that share many guests (#393), as the
	 * region counted them. A warning only: sending is still allowed.
	 */
	overlaps?: readonly BroadcastOverlap[] | null
}

const BLOCKING = new Set<BroadcastProblemCode>([
	'empty_message',
	'empty_image',
	'empty_button_link',
	'empty_menu_item',
	'empty_coupon',
	'coupon_missing',
	'coupon_paused',
	'coupon_ended_before_send',
	'audience_zero',
	'push_merge_tags',
])

function problem(
	code: BroadcastProblemCode,
	blockId?: string,
): BroadcastProblem {
	return {
		code,
		severity: BLOCKING.has(code) ? 'blocking' : 'warning',
		...(blockId ? { blockId } : {}),
	}
}

/** A button link that points nowhere: empty, or only the scheme the starter has. */
function linkIsEmpty(url: string) {
	const value = url.trim()
	return value === '' || /^https?:\/\/$/i.test(value)
}

export function checkBroadcast(input: BroadcastCheckInput): BroadcastProblem[] {
	const found: BroadcastProblem[] = []
	const blocks = input.channel === 'email' ? (input.blocks ?? []) : []

	if (input.content.trim() === '' && blocks.length === 0) {
		found.push(problem('empty_message'))
	}
	if (input.channel === 'push') {
		// The subject is the push title: both title and message are needed, and
		// neither may use a merge tag (a push passes through outside providers).
		if ((input.subject ?? '').trim() === '')
			found.push(problem('empty_message'))
		if ((input.subject ?? '').includes('{{') || input.content.includes('{{')) {
			found.push(problem('push_merge_tags'))
		}
	}

	for (const block of blocks) {
		switch (block.type) {
			case 'image':
				if (block.config.url.trim() === '') {
					found.push(problem('empty_image', block.id))
				}
				break
			case 'button':
				// A button with no label is not drawn, so it has no link to check.
				if (block.config.label.trim() && linkIsEmpty(block.config.url)) {
					found.push(problem('empty_button_link', block.id))
				}
				break
			case 'menu_item':
			case 'coupon':
				for (const issue of restaurantBlockProblems(block, {
					hasCoupon: input.hasOffer,
				})) {
					found.push(problem(issue.code, issue.blockId))
				}
				break
			default:
				break
		}
	}

	if (input.usesCouponTag && !input.hasOffer) {
		found.push(problem('coupon_missing'))
	}
	if (input.hasOffer && input.couponState === 'paused') {
		found.push(problem('coupon_paused'))
	}
	if (input.hasOffer && input.couponState === 'ended_before_send') {
		found.push(problem('coupon_ended_before_send'))
	}
	if (input.audienceCount === 0) found.push(problem('audience_zero'))

	if (input.channel === 'email') {
		for (const blockId of starterTextBlockIds(blocks)) {
			found.push(problem('starter_text', blockId))
		}
	}
	if (hasBoilerplatePhrase(input.subject, input.content, input.contentHtml)) {
		found.push(problem('boilerplate_phrase'))
	}
	for (const overlap of input.overlaps ?? []) {
		found.push({ ...problem('audience_overlap'), overlap })
	}

	// Blocking first, in the order they were found.
	return [
		...found.filter((item) => item.severity === 'blocking'),
		...found.filter((item) => item.severity === 'warning'),
	]
}

export function hasBlockingProblems(problems: readonly BroadcastProblem[]) {
	return problems.some((item) => item.severity === 'blocking')
}

/**
 * How long a scheduled broadcast may start late (#232). `null` for a broadcast
 * with no schedule. The operator sets whole hours; the column keeps minutes.
 */
export const DEFAULT_LATE_AFTER_MINUTES = 240
export const MIN_LATE_AFTER_MINUTES = 60
export const MAX_LATE_AFTER_MINUTES = 72 * 60

export function clampLateAfterMinutes(value: unknown): number {
	const minutes = typeof value === 'number' ? value : Number(value)
	if (!Number.isFinite(minutes)) return DEFAULT_LATE_AFTER_MINUTES
	return Math.min(
		MAX_LATE_AFTER_MINUTES,
		Math.max(MIN_LATE_AFTER_MINUTES, Math.round(minutes)),
	)
}

/** A scheduled start that could not begin inside its window. */
export function isTooLate(input: {
	scheduledAtMs: number
	lateAfterMinutes: number
	nowMs: number
}) {
	return input.nowMs - input.scheduledAtMs > input.lateAfterMinutes * 60_000
}
