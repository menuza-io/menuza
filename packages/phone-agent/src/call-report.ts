import { z } from 'zod'
import {
	CALL_SENTIMENTS,
	type CallOutcome,
	type CallRequestType,
	type CallSentiment,
	type NotificationEvent,
} from './constants.ts'
import {
	type CallTag,
	PhoneAgentFollowUpSchema,
	PhoneAgentNotificationsSchema,
} from './settings.ts'

/**
 * `referred`: a cold SIP REFER transfer. The carrier takes the call over, so
 * the agent never learns whether staff picked up.
 */
export const CALL_TRANSFER_RESULTS = [
	'none',
	'answered',
	'no_answer',
	'referred',
] as const
export type CallTransferResult = (typeof CALL_TRANSFER_RESULTS)[number]

/** Ratings at or below this count as low for alerts and follow-up. */
export const LOW_RATING_MAX = 2

const TagIdSchema = z
	.string()
	.trim()
	.regex(/^[a-z0-9_]{1,60}$/u)

/** Most tags one call can carry. */
export const MAX_CALL_TAGS = 10

/**
 * Extra fields the voice worker sends with `POST /api/voice/calls/:id/finish`.
 * Org settings travel with the call because tenant-api has no copy of them.
 * All fields default, so older workers keep working.
 */
export const CallFinishExtrasSchema = z.object({
	tags: z.array(TagIdSchema).max(MAX_CALL_TAGS).default([]),
	rating: z.number().int().min(1).max(5).nullable().default(null),
	sentiment: z.enum(CALL_SENTIMENTS).nullable().default(null),
	transferResult: z.enum(CALL_TRANSFER_RESULTS).default('none'),
	/** Contact id when a transfer case was used. */
	transferContactId: TagIdSchema.nullable().default(null),
	/** The caller left a voicemail recording. */
	voicemail: z.boolean().default(false),
	calledWhileOpen: z.boolean().nullable().default(null),
	followUp: PhoneAgentFollowUpSchema.nullable().default(null),
	/** Tag ids the org marked important (never auto-resolved, can alert). */
	importantTagIds: z.array(TagIdSchema).max(30).default([]),
	/** Display names for the org's tags, keyed by id, for staff alerts. */
	tagNames: z
		.record(TagIdSchema, z.string().trim().min(1).max(40))
		.refine((value) => Object.keys(value).length <= 30, 'Too many tags')
		.default({}),
	notifications: PhoneAgentNotificationsSchema.nullable().default(null),
	/** App page for this org's calls; the call id is appended as `?call=`. */
	callsUrl: z.string().url().max(500).nullable().default(null),
})
export type CallFinishExtras = z.infer<typeof CallFinishExtrasSchema>

export type CallFacts = {
	outcome: CallOutcome
	tags: readonly string[]
	importantTagIds: readonly string[]
	rating: number | null
	sentiment: CallSentiment | null
	transferResult: CallTransferResult
	voicemail: boolean
	requestTypes: readonly CallRequestType[]
	linkSent: boolean
}

/** Which notification events a finished call triggers. */
export function callNotificationEvents(facts: CallFacts): NotificationEvent[] {
	const events: NotificationEvent[] = ['every_call']
	if (facts.voicemail) events.push('voicemail')
	if (facts.requestTypes.includes('callback')) events.push('callback_request')
	if (facts.linkSent || facts.outcome === 'link_sent') events.push('link_sent')
	if (facts.transferResult === 'no_answer') events.push('transfer_no_answer')
	if (
		facts.requestTypes.includes('complaint') ||
		facts.tags.includes('complaint')
	)
		events.push('complaint')
	if (facts.rating != null && facts.rating <= LOW_RATING_MAX) {
		events.push('low_rating')
	}
	if (facts.tags.some((tag) => facts.importantTagIds.includes(tag))) {
		events.push('important_tag')
	}
	return events
}

/** True when someone on the team should look at the call. */
export function callNeedsFollowUp(
	facts: CallFacts,
	followUp: { keepTransferredOpen: boolean } | null,
) {
	return (
		facts.voicemail ||
		facts.requestTypes.length > 0 ||
		facts.transferResult === 'no_answer' ||
		facts.outcome === 'message_taken' ||
		facts.outcome === 'failed' ||
		(facts.rating != null && facts.rating <= LOW_RATING_MAX) ||
		facts.sentiment === 'negative' ||
		facts.tags.some((tag) => facts.importantTagIds.includes(tag)) ||
		(Boolean(followUp?.keepTransferredOpen) &&
			(facts.transferResult === 'answered' ||
				facts.transferResult === 'referred'))
	)
}

/**
 * When an open call resolves itself. Null keeps it open until someone marks
 * it complete: auto-resolve is off, or the call has an important tag.
 */
export function autoResolveAt(
	facts: Pick<CallFacts, 'tags' | 'importantTagIds'>,
	followUp: { autoResolveAfterDays: number } | null,
	finishedAt: Date,
) {
	const days = followUp?.autoResolveAfterDays ?? 0
	if (days <= 0) return null
	if (facts.tags.some((tag) => facts.importantTagIds.includes(tag))) return null
	return new Date(finishedAt.getTime() + days * 24 * 60 * 60 * 1000)
}

export const NOTIFICATION_EVENT_HEADLINES: Record<NotificationEvent, string> = {
	every_call: 'New call',
	voicemail: 'New voicemail',
	callback_request: 'Callback requested',
	link_sent: 'Link sent',
	transfer_no_answer: 'Missed transfer',
	complaint: 'Complaint',
	low_rating: 'Low rating',
	important_tag: 'Important call',
}

/** The most urgent of the triggered events, for the message headline. */
const EVENT_PRIORITY: NotificationEvent[] = [
	'complaint',
	'transfer_no_answer',
	'voicemail',
	'callback_request',
	'low_rating',
	'important_tag',
	'link_sent',
	'every_call',
]

/** Events the org subscribed to that this call triggered. */
export function matchedNotificationEvents(
	triggered: readonly NotificationEvent[],
	subscribed: readonly NotificationEvent[],
) {
	return EVENT_PRIORITY.filter(
		(event) => triggered.includes(event) && subscribed.includes(event),
	)
}

/**
 * Plain-text staff alert. Kept short for SMS; includes the caller's number
 * because staff need it to call back.
 */
export function formatStaffNotification(input: {
	businessName: string
	events: readonly NotificationEvent[]
	callerPhone: string | null
	summary: string | null
	tags: readonly Pick<CallTag, 'id' | 'name'>[]
	callUrl: string | null
	maxLength?: number
	/** The vertical's wording for event headlines (`notificationHeadlines`). */
	headlines?: Partial<Record<NotificationEvent, string>>
}) {
	const event = input.events[0] ?? 'every_call'
	const headline =
		input.headlines?.[event] ?? NOTIFICATION_EVENT_HEADLINES[event]
	const tagNames = input.tags.map((tag) => tag.name).join(', ')
	const lines = [
		`${input.businessName}: ${headline}`,
		input.callerPhone ? `From ${input.callerPhone}` : 'Caller ID hidden',
		input.summary?.trim() || null,
		tagNames ? `Tags: ${tagNames}` : null,
		input.callUrl,
	].filter((line): line is string => Boolean(line))
	const text = lines.join('\n')
	const max = input.maxLength ?? 600
	if (text.length <= max) return text
	// Trim the summary, never the link.
	const withoutSummary = lines.filter((line) => line !== input.summary?.trim())
	const room = max - withoutSummary.join('\n').length - 2
	const summary = input.summary?.trim() ?? ''
	return [
		...withoutSummary.slice(0, 2),
		room > 20 ? `${summary.slice(0, room - 1)}…` : null,
		...withoutSummary.slice(2),
	]
		.filter(Boolean)
		.join('\n')
}

export function callLink(callsUrl: string | null, callId: string) {
	if (!callsUrl) return null
	const url = new URL(callsUrl)
	url.searchParams.set('call', callId)
	return url.toString()
}

/** Call log sentence for each outcome; a vertical can reword them. */
export const CALL_OUTCOME_SUMMARIES: Record<CallOutcome, string> = {
	resolved: 'Caller was helped by the agent.',
	link_sent: 'Link sent.',
	escalated: 'Transferred to staff.',
	message_taken: 'Request recorded for staff follow-up.',
	abandoned: 'Caller hung up before speaking.',
	failed: 'The agent hit an error during the call.',
}

export function outcomeSummary(
	outcome: CallOutcome,
	overrides?: Partial<Record<CallOutcome, string>>,
) {
	return overrides?.[outcome] ?? CALL_OUTCOME_SUMMARIES[outcome]
}
