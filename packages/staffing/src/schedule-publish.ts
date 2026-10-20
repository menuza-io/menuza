import { z } from 'zod'
import {
	availabilityCreateSchema,
	shiftRequestCreateSchema,
	timeOffCreateSchema,
	type ScheduleNotifyMode,
} from './schedule-api.ts'
import { localDateSchema } from './schemas.ts'

/**
 * Telling people about a published schedule, and letting them see it.
 *
 * Two halves, both pure:
 *
 * - Who hears about a publication (`scheduleRecipients`) and what the queued
 *   message carries (ids and counts only: the times are read from the live
 *   schedule when the message is sent, so a stale message can never state a
 *   stale time).
 * - The capability link: a read-only, revocable, per-person credential that is
 *   delivered in the email and opens a client-rendered "my schedule" page. Its
 *   format, the contracts of the self-service routes it unlocks and the stable
 *   error vocabulary. No UI strings.
 *
 * Residency: everything here describes data that lives in the regional
 * database. The control plane only ever sees a generic event (kind, scope id,
 * count) when a week is published.
 */

const DAY_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Capability link
// ---------------------------------------------------------------------------

export const SCHEDULE_LINK_PREFIX = 'slk1'
/** How long a link works after the last email that carried it. */
export const SCHEDULE_LINK_TTL_MS = 90 * DAY_MS
/** The page that opens the link (client-rendered; the token is in the fragment). */
export const SCHEDULE_LINK_PAGE_PATH = '/my-schedule'

const ORG_ID = '[A-Za-z0-9_-]{1,64}'
const LINK_ID = '[A-Za-z0-9_-]{8,64}'
const SECRET = '[a-f0-9]{64}'
const LINK_PATTERN = new RegExp(
	`^${SCHEDULE_LINK_PREFIX}\\.(${ORG_ID})\\.(${LINK_ID})\\.(${SECRET})$`,
)

/**
 * `slk1.<orgId>.<linkId>.<secret>`. The organization id is a plain prefix so
 * the regional router can open the right database before anything is verified;
 * the secret is an HMAC of the link and the person, derived (so the same email
 * can be sent again) and stored only as a keyed hash.
 */
export function formatScheduleLinkToken(
	orgId: string,
	linkId: string,
	secret: string,
): string {
	const token = `${SCHEDULE_LINK_PREFIX}.${orgId}.${linkId}.${secret}`
	if (!LINK_PATTERN.test(token)) throw new Error('Invalid schedule link parts')
	return token
}

export function parseScheduleLinkToken(
	value: unknown,
): { orgId: string; linkId: string; secret: string } | null {
	if (typeof value !== 'string' || value.length > 220) return null
	const match = LINK_PATTERN.exec(value)
	return match
		? { orgId: match[1]!, linkId: match[2]!, secret: match[3]! }
		: null
}

/** What is fed to HMAC to derive the secret part for one person's link. */
export function scheduleLinkSecretMessage(
	orgId: string,
	linkId: string,
	staffId: string,
): string {
	return `schedule-link-secret:${orgId}:${linkId}:${staffId}`
}

/** What is fed to HMAC for the stored hash of a whole token. */
export function scheduleLinkHashMessage(token: string): string {
	return `schedule-link:${token}`
}

/** `#r=us&t=<token>`: the fragment never reaches a server. */
export function scheduleLinkFragment(
	region: 'us' | 'ksa',
	token: string,
): string {
	return `#r=${region}&t=${encodeURIComponent(token)}`
}

export function parseScheduleLinkFragment(
	hash: string,
): { region: 'us' | 'ksa'; token: string } | null {
	const raw = hash.startsWith('#') ? hash.slice(1) : hash
	if (!raw || raw.length > 400) return null
	const params = new URLSearchParams(raw)
	const region = params.get('r')
	const token = params.get('t')
	if ((region !== 'us' && region !== 'ksa') || !token) return null
	return parseScheduleLinkToken(token) ? { region, token } : null
}

// ---------------------------------------------------------------------------
// Who is told
// ---------------------------------------------------------------------------

/** The part of a publication row that decides recipients. */
export type PublishedChange = {
	shiftId: string
	kind: 'created' | 'changed' | 'cancelled'
	staffId: string | null
	previousStaffId?: string | null
}

export type ScheduleRecipient = {
	staffId: string
	/** Own shifts that are new or changed in this publication. */
	changedShiftIds: string[]
	/** Own shifts that were cancelled, or moved to someone else, in it. */
	removedShiftIds: string[]
	/** The person works at least one live shift in the week. */
	hasShifts: boolean
}

export const MAX_NOTICE_SHIFT_IDS = 40

/**
 * Recipients of one publication:
 *
 * - `nobody`: nobody.
 * - `changed`: people whose own shifts were added, edited, removed or reassigned
 *   (the person who lost a shift hears about it too).
 * - `everyone`: everyone who works a live shift that week, plus anyone who lost
 *   one in this publication.
 *
 * Open shifts (no person) notify nobody. Order is stable (by id).
 */
export function scheduleRecipients(input: {
	mode: ScheduleNotifyMode
	changes: readonly PublishedChange[]
	/** People with a live (published, not cancelled) shift in the week. */
	liveStaffIds: readonly string[]
}): ScheduleRecipient[] {
	if (input.mode === 'nobody') return []
	const live = new Set(input.liveStaffIds)
	const byStaff = new Map<
		string,
		{ changed: Set<string>; removed: Set<string> }
	>()
	const entry = (staffId: string) => {
		let found = byStaff.get(staffId)
		if (!found) {
			found = { changed: new Set(), removed: new Set() }
			byStaff.set(staffId, found)
		}
		return found
	}
	for (const change of input.changes) {
		if (change.kind === 'cancelled') {
			if (change.staffId) entry(change.staffId).removed.add(change.shiftId)
			continue
		}
		if (change.staffId) entry(change.staffId).changed.add(change.shiftId)
		if (change.previousStaffId && change.previousStaffId !== change.staffId) {
			entry(change.previousStaffId).removed.add(change.shiftId)
		}
	}
	if (input.mode === 'everyone') {
		for (const staffId of live) entry(staffId)
	}
	return [...byStaff.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([staffId, value]) => ({
			staffId,
			changedShiftIds: [...value.changed].slice(0, MAX_NOTICE_SHIFT_IDS),
			removedShiftIds: [...value.removed].slice(0, MAX_NOTICE_SHIFT_IDS),
			hasShifts: live.has(staffId),
		}))
}

/** Why someone a publication meant to tell had nothing queued. */
export const NOT_REACHED_REASONS = [
	'no_email',
	'inactive',
	'email_disabled',
] as const
export type NotReachedReason = (typeof NOT_REACHED_REASONS)[number]

/** Why a queued message was not sent. */
export const NOTICE_SKIP_REASONS = [
	'no_email',
	'inactive',
	'email_disabled',
	'superseded',
	'stale',
] as const
export type NoticeSkipReason = (typeof NOTICE_SKIP_REASONS)[number]

/** The delivery state a manager sees for one recipient. */
export const NOTICE_STATES = ['pending', 'sent', 'failed', 'not_sent'] as const
export type NoticeState = (typeof NOTICE_STATES)[number]

export const SCHEDULE_NOTICE_PREFIX = 'schedule_published'

/** Outbox dedupe key: one message per publication, person and resend round. */
export function scheduleNoticeKey(
	publicationId: string,
	staffId: string,
	round: number,
): string {
	return `${SCHEDULE_NOTICE_PREFIX}:${publicationId}:${staffId}:${round}`
}

export function scheduleNoticePrefix(publicationId: string): string {
	return `${SCHEDULE_NOTICE_PREFIX}:${publicationId}:`
}

/** The round a dedupe key was queued in (0 for the first send). */
export function scheduleNoticeRound(key: string): number {
	const last = key.split(':').pop() ?? ''
	const round = Number(last)
	return Number.isInteger(round) && round >= 0 ? round : 0
}

/** What a queued "schedule published" message carries: ids and counts. */
export type SchedulePublishedPayload = {
	publicationId: string
	scopeId: string
	weekStart: string
	version: number
	mode: ScheduleNotifyMode
	changedShiftIds: string[]
	removedShiftIds: string[]
}

export function isSchedulePublishedPayload(
	value: unknown,
): value is SchedulePublishedPayload {
	if (!value || typeof value !== 'object') return false
	const v = value as Record<string, unknown>
	return (
		typeof v.publicationId === 'string' &&
		typeof v.scopeId === 'string' &&
		typeof v.weekStart === 'string' &&
		typeof v.version === 'number' &&
		Array.isArray(v.changedShiftIds) &&
		Array.isArray(v.removedShiftIds)
	)
}

/** Minutes between two resends of the same publication. */
export const RESEND_COOLDOWN_MS = 5 * 60 * 1000

export const resendSchema = z
	.object({
		/** `unsent` leaves people who already got it alone. */
		scope: z.enum(['unsent', 'all']).default('unsent'),
	})
	.strict()
export type Resend = z.infer<typeof resendSchema>

export type PublicationNotification = {
	mode: ScheduleNotifyMode
	/** People the publication meant to tell. */
	recipients: number
	/** People with a message queued (an address on file and an active status). */
	queued: number
	/** Recipients with nothing queued, and why. Ids only. */
	notReached: Array<{ staffId: string; reason: NotReachedReason }>
}

export type NoticeView = {
	staffId: string
	state: NoticeState
	reason: NoticeSkipReason | string | null
	/** Resend round of the latest message (0 = first send). */
	round: number
	sentAt: number | null
}

export type PublicationNoticesView = {
	publicationId: string
	mode: ScheduleNotifyMode
	/** Whether this publication is the latest for its week. */
	current: boolean
	emailEnabled: boolean
	notices: NoticeView[]
	/** Recipients with nothing queued (no address, or left the roster). */
	notReached: PublicationNotification['notReached']
}

export type ResendResult = {
	queued: number
	notReached: PublicationNotification['notReached']
}

export type ScheduleLinkStatus = {
	staffId: string
	active: boolean
	createdAt: number | null
	lastUsedAt: number | null
	expiresAt: number | null
}

// ---------------------------------------------------------------------------
// Self service (behind the capability link)
// ---------------------------------------------------------------------------

/** Stands in for the person in a body; the route always uses the link's own id. */
export const SELF_STAFF_ID = 'self'

function injectSelf(extra: Record<string, unknown>) {
	return (value: unknown) =>
		value && typeof value === 'object' && !Array.isArray(value)
			? { ...(value as Record<string, unknown>), ...extra }
			: value
}

/**
 * A person's own time-off request. They cannot name another person or approve
 * it: whatever the body says, it is recorded as theirs and waits for a decision.
 */
export const selfTimeOffSchema = z.preprocess(
	injectSelf({ staffId: SELF_STAFF_ID, submission: 'staff_request' }),
	timeOffCreateSchema,
)

export const selfAvailabilitySchema = z.preprocess(
	injectSelf({ staffId: SELF_STAFF_ID, submission: 'staff_request' }),
	availabilityCreateSchema,
)

export const selfShiftRequestSchema = z.preprocess(
	injectSelf({
		requesterStaffId: SELF_STAFF_ID,
		submission: 'staff_request',
	}),
	shiftRequestCreateSchema,
)

export const selfRangeQuerySchema = z
	.object({
		from: localDateSchema.optional(),
		to: localDateSchema.optional(),
	})
	.refine((q) => !q.from || !q.to || q.from <= q.to, 'from is after to')
export type SelfRangeQuery = z.infer<typeof selfRangeQuerySchema>

export const selfTeammatesQuerySchema = z.object({
	shiftId: z.string().min(1).max(64),
})

/** Longest range one self-service read covers. */
export const SELF_MAX_RANGE_DAYS = 62
/** Requests (of any kind) one person may have waiting for a decision at once. */
export const SELF_MAX_PENDING_REQUESTS = 10
/** Days of schedule the page opens with (back and forward from today). */
export const SELF_DEFAULT_DAYS_BACK = 1
export const SELF_DEFAULT_DAYS_FORWARD = 35

export type MyShift = {
	id: string
	scopeId: string
	positionName: string | null
	positionNameAr: string | null
	startsAt: number
	endsAt: number
	localDate: string
	timeZone: string
	unpaidBreakMinutes: number
	notes: string | null
}

export type MyScope = {
	id: string
	name: string | null
	timeZone: string
	/** `team` lets the person see teammates' shifts for swaps. */
	scheduleVisibility: 'own' | 'team'
}

export type MyScheduleView = {
	serverNow: number
	person: {
		firstName: string
		firstNameAr: string | null
		locale: string | null
	}
	scopes: MyScope[]
	from: string
	to: string
	shifts: MyShift[]
	/** Whether the capability may still be used (always true when this answers). */
	link: { expiresAt: number }
}

export type MyTimeCardEdit = {
	id: string
	/** `You`, `A manager` and so on are the page's words; this is the stable key. */
	action: string
	via: string
	reason: string
	hoursDeltaMinutes: number | null
	/** Times only: no pay, tips or notes. */
	before: { clockInAt: number | null; clockOutAt: number | null } | null
	after: { clockInAt: number | null; clockOutAt: number | null } | null
	createdAt: number
}

export type MyTimeCard = {
	id: string
	scopeId: string
	positionName: string | null
	positionNameAr: string | null
	timeZone: string
	localDate: string
	clockInAt: number
	clockOutAt: number | null
	status: string
	paidMinutes: number
	unpaidBreakMinutes: number
	edited: boolean
	edits: MyTimeCardEdit[]
}

export type MyTimeCardsView = {
	serverNow: number
	from: string
	to: string
	cards: MyTimeCard[]
}

export type MyTimeOffView = {
	id: string
	category: string
	startDate: string
	endDate: string
	allDay: boolean
	startMinute: number | null
	endMinute: number | null
	note: string | null
	status: string
	decisionNote: string | null
	createdAt: number
}

export type MyAvailabilityView = {
	id: string
	kind: string
	weekday: number | null
	date: string | null
	availability: string
	allDay: boolean
	startMinute: number | null
	endMinute: number | null
	effectiveFrom: string | null
	effectiveTo: string | null
	note: string | null
	status: string
	decisionNote: string | null
	createdAt: number
}

export type MyShiftRequestView = {
	id: string
	kind: string
	shiftId: string
	localDate: string
	startsAt: number
	endsAt: number
	timeZone: string
	targetName: string | null
	note: string | null
	status: string
	decisionNote: string | null
	createdAt: number
}

export type MyRequestsView = {
	timeOff: MyTimeOffView[]
	availability: MyAvailabilityView[]
	shiftRequests: MyShiftRequestView[]
}

/** A teammate as a person sees one: a first name and a last initial. */
export type Teammate = { id: string; name: string }

export type SwapCandidate = {
	id: string
	staffId: string
	startsAt: number
	endsAt: number
	localDate: string
	timeZone: string
	positionName: string | null
	positionNameAr: string | null
}

export type MyTeammatesView = {
	/** Who could take or swap the shift. */
	teammates: Teammate[]
	/** Their upcoming shifts at the same scope, only when the scope lets the team see the schedule. */
	swapCandidates: SwapCandidate[]
	canSwap: boolean
}

/** The stable failure vocabulary of `/schedule-link`. */
export const SCHEDULE_LINK_ERROR_CODES = [
	'invalid_link',
	'link_revoked',
	'link_expired',
	'staff_inactive',
	'too_many_pending',
	'not_found',
	'not_your_shift',
	'swap_not_allowed',
	'shift_started',
	'invalid_range',
	'already_decided',
	'not_published',
	'staff_not_found',
	'time_zone_unavailable',
	'range_too_large',
	'schedule_disabled',
] as const
export type ScheduleLinkErrorCode = (typeof SCHEDULE_LINK_ERROR_CODES)[number]
