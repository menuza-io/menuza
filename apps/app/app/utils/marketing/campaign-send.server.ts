import { i18n } from '@lingui/core'
import { msg } from '@lingui/macro'
import {
	checkBroadcast,
	clampLateAfterMinutes,
	hasBlockingProblems,
	type BroadcastCouponState,
	type BroadcastProblem,
} from '@repo/common/broadcast-checks'
import { usesCouponCodeTag, type MarketingOffer } from '@repo/discounts'
import { getDiscount } from '#app/utils/discounts/discounts.server.ts'
import { type PreparedCampaignMessage } from './campaign-message.server.ts'

/**
 * What the App decides before a broadcast is sent or scheduled (#232): when it
 * goes (and how late it may start), and what is wrong with it. tenant-api runs
 * the checks it can see again when the send starts.
 */

const HOUR_MS = 60 * 60 * 1000

export const CAMPAIGN_INTENTS = ['send', 'schedule', 'draft', 'test'] as const
export type CampaignIntent = (typeof CAMPAIGN_INTENTS)[number]

export function readCampaignIntent(value: unknown): CampaignIntent | null {
	return (CAMPAIGN_INTENTS as readonly unknown[]).includes(value)
		? (value as CampaignIntent)
		: null
}

export type CampaignSchedule = {
	/** When it should start; null to send now or to keep a draft unscheduled. */
	scheduledAt: Date | null
	lateAfterMinutes: number
}

/**
 * The "When" the form posted: `scheduledAt` is an ISO instant (the browser turned
 * the operator's local time into one) and `lateAfterHours` the "don't send if
 * more than N hours late" window. A time that is not in the future is refused
 * here (and again in tenant-api, `scheduled_in_past`).
 */
export function readCampaignSchedule(
	formData: FormData,
	now = Date.now(),
): { ok: true; schedule: CampaignSchedule } | { ok: false; error: string } {
	const raw = String(formData.get('scheduledAt') ?? '').trim()
	let scheduledAt: Date | null = null
	if (raw) {
		const parsed = new Date(raw)
		if (Number.isNaN(parsed.getTime())) {
			return { ok: false, error: i18n._(msg`Choose a valid date and time.`) }
		}
		if (parsed.getTime() <= now) {
			return {
				ok: false,
				error: i18n._(msg`Choose a time in the future.`),
			}
		}
		scheduledAt = parsed
	}
	const hours = Number(formData.get('lateAfterHours'))
	return {
		ok: true,
		schedule: {
			scheduledAt,
			lateAfterMinutes: clampLateAfterMinutes(
				Number.isFinite(hours) && hours > 0 ? hours * 60 : undefined,
			),
		},
	}
}

const localStamp = (ms: number) => new Date(ms).toISOString().slice(0, 16)

/**
 * A coupon's standing at the time the message would start: paused, archived or
 * gone is `paused`; an end that has passed in every time zone before the start
 * is `ended_before_send`. A discount's end is a local time at each location
 * (`YYYY-MM-DDTHH:MM`), so it is only called ended once it has ended
 * everywhere (UTC-12 is the last to turn over), like print coupons.
 */
export function couponStateFromDiscount(
	discount: { status: string; endsAt: string | null } | null,
	sendAtMs: number,
): BroadcastCouponState {
	if (!discount || discount.status !== 'active') return 'paused'
	if (
		discount.endsAt &&
		discount.endsAt <= localStamp(sendAtMs - 12 * HOUR_MS)
	) {
		return 'ended_before_send'
	}
	return 'ok'
}

export async function couponStateFor(
	organizationId: string,
	offer: MarketingOffer,
	sendAtMs: number,
): Promise<BroadcastCouponState> {
	const found = await getDiscount(organizationId, offer.discountId)
	return couponStateFromDiscount(
		found?.stored
			? {
					status: found.row.status,
					endsAt: found.stored.definition.endsAt ?? null,
				}
			: null,
		sendAtMs,
	)
}

type FetchTenant = (path: string, init?: RequestInit) => Promise<Response>

/** How many customers the broadcast reaches now: a count, never a customer. */
export async function countAudience(
	fetchTenant: FetchTenant,
	input: {
		channel: 'email' | 'sms'
		audience: string
		/** A saved audience (#98): narrows the consented guests. */
		audienceId?: string | null
		retargetOf?: string | null
	},
): Promise<number | null> {
	const query = new URLSearchParams({
		channel: input.channel,
		audience: input.audience,
	})
	if (input.audienceId) query.set('audienceId', input.audienceId)
	if (input.retargetOf) query.set('retargetOf', input.retargetOf)
	try {
		const res = await fetchTenant(
			`/operator/marketing/audience-count?${query.toString()}`,
		)
		if (!res.ok) return null
		const body = (await res.json()) as { count?: unknown }
		return typeof body.count === 'number' ? body.count : null
	} catch {
		return null
	}
}

/** The checks for pressing Send or Schedule: blocking problems and warnings. */
export async function runSendChecks(input: {
	organizationId: string
	message: PreparedCampaignMessage
	audience: string
	audienceId?: string | null
	/** When it would start: the scheduled time, or now. */
	sendAtMs: number
	fetchTenant: FetchTenant
	retargetOf?: string | null
}): Promise<BroadcastProblem[]> {
	const { message } = input
	const [audienceCount, couponState] = await Promise.all([
		countAudience(input.fetchTenant, {
			channel: message.channel,
			audience: input.audience,
			audienceId: input.audienceId,
			retargetOf: input.retargetOf,
		}),
		message.discountOffer
			? couponStateFor(
					input.organizationId,
					message.discountOffer,
					input.sendAtMs,
				)
			: Promise.resolve(undefined),
	])
	return checkBroadcast({
		channel: message.channel,
		subject: message.subject,
		content: message.content,
		contentHtml: message.contentHtml,
		blocks: message.blocks,
		hasOffer: Boolean(message.discountOffer),
		usesCouponTag: usesCouponCodeTag(
			message.content,
			message.channel === 'email' ? message.subject : null,
			message.channel === 'email' ? message.contentHtml : null,
		),
		couponState,
		audienceCount,
	})
}

/**
 * Whether the operator may go ahead: nothing blocking, and every warning was
 * seen ("Send anyway" posts `acknowledgeWarnings`).
 */
export function mayProceed(
	problems: readonly BroadcastProblem[],
	acknowledgeWarnings: boolean,
) {
	if (hasBlockingProblems(problems)) return false
	return problems.length === 0 || acknowledgeWarnings
}

/** What the operator reads for a refused action; the code is tenant-api's. */
export function campaignActionError(code: unknown): string {
	switch (code) {
		case 'campaign_already_sending':
			return i18n._(
				msg`This broadcast is already sending, so it can no longer be changed.`,
			)
		case 'campaign_not_editable':
			return i18n._(msg`Only a draft or a scheduled broadcast can be edited.`)
		case 'campaign_not_cancellable':
			return i18n._(
				msg`Only a draft or a scheduled broadcast can be cancelled.`,
			)
		case 'campaign_not_deletable':
			return i18n._(msg`Only a draft or a cancelled broadcast can be deleted.`)
		case 'scheduled_in_past':
			return i18n._(msg`Choose a time in the future.`)
		case 'retarget_not_supported':
			return i18n._(
				msg`Texts have no open signal, so they cannot be re-sent to non-openers.`,
			)
		case 'campaign_not_completed':
			return i18n._(msg`Only a finished broadcast can be re-sent.`)
		case 'retarget_too_early':
			return i18n._(
				msg`You can re-send to non-openers 48 hours after the broadcast finished.`,
			)
		case 'already_retargeted':
			return i18n._(msg`This broadcast was already re-sent to non-openers.`)
		case 'test_send_limit':
			return i18n._(
				msg`You can send 10 tests an hour. Try again a little later.`,
			)
		case 'test_send_failed':
			return i18n._(msg`The test could not be sent. Try again.`)
		case 'not_found':
			return i18n._(msg`That broadcast no longer exists.`)
		default:
			return i18n._(msg`Something went wrong. Try again.`)
	}
}
