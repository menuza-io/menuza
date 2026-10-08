import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import {
	CALL_CHANNELS,
	CALL_FOLLOW_UP_STATUSES,
	CALL_OUTCOMES,
	CALL_REQUEST_STATUSES,
	CALL_SENTIMENTS,
	CALL_TRANSFER_RESULTS,
	type CallFollowUpStatus,
	type CallOutcome,
	type CallSentiment,
	DefinitionIdSchema,
	type CallTransferResult,
} from '@repo/phone-agent'
import { z } from 'zod'

/**
 * Schemas for the regional tenant-api `/operator/calls` responses. Caller PII
 * in these payloads is fetched by the browser directly and never reaches App.
 */
// Enums fall back instead of failing so a newer tenant-api that adds a value
// does not break the whole list with a ZodError.
// Purposes and request types are vertical slugs; labels are looked up by id
// (see `useVerticalLabels`), so any well-formed slug is kept.
const purposeSchema = DefinitionIdSchema.nullable().catch(null)
const outcomeSchema = z.enum(CALL_OUTCOMES).nullable().catch(null)

/** Parses each item on its own and drops the ones that no longer fit. */
function tolerantArray<T extends z.ZodTypeAny>(item: T) {
	return z.array(z.unknown()).transform((values) =>
		values.flatMap((value) => {
			const parsed = item.safeParse(value)
			return parsed.success ? [parsed.data as z.output<T>] : []
		}),
	)
}

export const callSummarySchema = z.object({
	id: z.string(),
	channel: z.enum(CALL_CHANNELS).catch('phone'),
	scopeId: z.string().nullable().catch(null),
	callerPhone: z.string().nullable(),
	customerName: z.string().nullable(),
	purpose: purposeSchema,
	outcome: outcomeSchema,
	summary: z.string().nullable(),
	startedAt: z.string(),
	durationSeconds: z.number().nullable(),
	hasRecording: z.boolean().catch(false),
	// Older tenant-api nodes do not send these yet.
	followUpStatus: z.enum(CALL_FOLLOW_UP_STATUSES).catch('resolved'),
	followUpResolvedAt: z.string().nullable().catch(null),
	tags: z.array(z.string()).catch([]),
	rating: z.number().int().min(1).max(5).nullable().catch(null),
	sentiment: z.enum(CALL_SENTIMENTS).nullable().catch(null),
	transferResult: z.enum(CALL_TRANSFER_RESULTS).catch('none'),
	voicemail: z.boolean().catch(false),
	calledWhileOpen: z.boolean().nullable().catch(null),
	linkSent: z.boolean().catch(false),
})
export type CallSummary = z.infer<typeof callSummarySchema>

export const callListSchema = z.object({
	calls: tolerantArray(callSummarySchema),
	/** Opaque keyset cursor for the next page; null on the last page. */
	nextCursor: z.string().nullable().optional().catch(null),
	purposeCounts: z.array(
		z.object({ purpose: purposeSchema, total: z.number() }),
	),
	openRequests: z.number(),
	openFollowUps: z.number().catch(0),
})

/** Builds the `cursor` query param for the page after `call`. */
export function callListCursor(call: Pick<CallSummary, 'id' | 'startedAt'>) {
	return `${Math.floor(new Date(call.startedAt).getTime() / 1000)}.${call.id}`
}

export const callRequestSchema = z.object({
	id: z.string(),
	callId: z.string(),
	type: DefinitionIdSchema,
	status: z.enum(CALL_REQUEST_STATUSES).catch('open'),
	callerName: z.string().nullable(),
	callerPhone: z.string().nullable(),
	details: z.record(z.string(), z.unknown()).nullable().catch(null),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
})
export type CallRequest = z.infer<typeof callRequestSchema>

export const callRequestListSchema = z.object({
	// Rows without a well-formed type are skipped.
	requests: tolerantArray(callRequestSchema),
})

const transcriptTurnSchema = z.object({
	role: z.enum(['agent', 'caller']),
	text: z.string(),
	at: z.number().nullable().optional(),
})

/** A link the agent texted, with the data the vertical stored for it. */
export const callHandoffSchema = z.object({
	id: z.string(),
	path: z.string().catch('/'),
	payload: z.unknown(),
	createdAt: z.string().nullable().optional().catch(null),
	expiresAt: z.string().nullable().catch(null),
	sentToPhone: z.string().nullable().optional().catch(null),
	smsSentAt: z.string().nullable().optional().catch(null),
	openedAt: z.string().nullable().optional().catch(null),
})
export type CallHandoff = z.infer<typeof callHandoffSchema>

export const callDetailSchema = z.object({
	call: callSummarySchema.extend({
		flowVersionId: z.string().nullable(),
		transcript: z.array(transcriptTurnSchema).nullable().catch(null),
		endedAt: z.string().nullable(),
		autoResolveAt: z.string().nullable().catch(null),
		transferContactId: z.string().nullable().catch(null),
	}),
	handoffs: tolerantArray(callHandoffSchema).catch([]),
	requests: tolerantArray(callRequestSchema),
})
export type CallDetail = z.infer<typeof callDetailSchema>

export const OUTCOME_LABELS: Record<CallOutcome, MessageDescriptor> = {
	resolved: msg`Resolved`,
	link_sent: msg`Link sent`,
	escalated: msg`Escalated`,
	message_taken: msg`Message taken`,
	abandoned: msg`Abandoned`,
	failed: msg`Failed`,
}

export const FOLLOW_UP_LABELS: Record<CallFollowUpStatus, MessageDescriptor> = {
	open: msg`Needs follow-up`,
	resolved: msg`Complete`,
}

export const SENTIMENT_LABELS: Record<CallSentiment, MessageDescriptor> = {
	positive: msg`Positive`,
	neutral: msg`Neutral`,
	negative: msg`Negative`,
}

export const TRANSFER_RESULT_LABELS: Record<
	CallTransferResult,
	MessageDescriptor
> = {
	none: msg`No transfer`,
	answered: msg`Staff picked up`,
	no_answer: msg`Nobody answered`,
	referred: msg`Handed to the business line`,
}

export function outcomeVariant(outcome: CallOutcome) {
	if (outcome === 'failed' || outcome === 'abandoned') return 'destructive'
	if (outcome === 'escalated' || outcome === 'message_taken') return 'outline'
	return 'secondary'
}

/** `m:ss` for call durations and transcript offsets. */
export function formatDuration(seconds: number | null | undefined) {
	if (seconds == null || !Number.isFinite(seconds)) return '—'
	const total = Math.max(0, Math.round(seconds))
	const minutes = Math.floor(total / 60)
	return `${minutes}:${String(total % 60).padStart(2, '0')}`
}

export function formatPhone(phone: string | null | undefined) {
	if (!phone) return ''
	const nanp = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone)
	return nanp ? `+1 (${nanp[1]}) ${nanp[2]}-${nanp[3]}` : phone
}

export function formatDateTime(value: string | null, locale: string) {
	if (!value) return '—'
	return new Intl.DateTimeFormat(locale, {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(new Date(value))
}

export function formatRelative(value: string, locale: string) {
	const diffSeconds = (new Date(value).getTime() - Date.now()) / 1000
	const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
	const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
		['day', 86_400],
		['hour', 3_600],
		['minute', 60],
	]
	for (const [unit, size] of units) {
		if (Math.abs(diffSeconds) >= size) {
			return format.format(Math.round(diffSeconds / size), unit)
		}
	}
	return format.format(0, 'minute')
}

export function formatDetailValue(value: unknown) {
	if (value == null) return '—'
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean')
		return String(value)
	return JSON.stringify(value)
}
