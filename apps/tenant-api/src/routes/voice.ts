import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
	and,
	count,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	ne,
	or,
	type SQL,
	sql,
	type SQLWrapper,
} from 'drizzle-orm'
import { Hono, type Context, type Next } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { brand, getBrandDomain, getLocalDomain } from '@repo/config/brand'
import {
	autoResolveAt,
	CALL_CHANNELS,
	CALL_FOLLOW_UP_STATUSES,
	CALL_OUTCOMES,
	CALL_REQUEST_STATUSES,
	type CallFacts,
	type CallFinishExtras,
	CallFinishExtrasSchema,
	callLink,
	callNeedsFollowUp,
	callNotificationEvents,
	DefinitionIdSchema,
	E164Schema,
	formatStaffNotification,
	isUsOrCanadaNumber,
	LINK_HANDOFF_TTL_HOURS,
	LinkHandoffSchema,
	matchedNotificationEvents,
	SitePathSchema,
} from '@repo/phone-agent'
import { sendSms } from '@repo/sms'
import {
	customers,
	getTenantDb,
	type TenantDatabase,
	voiceCallRequests,
	voiceCalls,
	voiceLineVerifications,
	voiceLinkHandoffs,
	voiceRecordingDeletions,
	voiceSmsSends,
} from '@repo/tenant-db'
import { ENV } from 'varlock/env'
import { z } from 'zod'

import {
	findActiveOrganizationById,
	type PublishedOrganization,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
import { forEachWithBudget } from '../lib/concurrency.ts'
import {
	BUDGETED_REQUEST_TIMEOUT_MS,
	deleteRecordingObject,
	expectedRecordingKey,
	getRecordingStorageConfig,
	RECORDING_DELETE_CONCURRENCY,
} from '../lib/recording-storage.ts'
import { getNodeRegion, orgMatchesNodeRegion } from '../lib/region.ts'
import {
	bearerMatches,
	getInternalCommandToken,
	getVoiceAgentToken,
	logVoiceAgentTokenProblem,
	VOICE_AGENT_TOKEN_MIN_LENGTH,
	voiceAgentTokenProblem,
} from '../lib/secrets.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import { placeVerificationCall } from '../lib/twilio-voice.ts'
import { authenticateOperator } from './operator.ts'

/**
 * Voice worker → tenant-api (VOICE_AGENT_TOKEN), plus App → tenant-api
 * maintenance routes (INTERNAL_COMMAND_TOKEN).
 */
export const voiceSystemRoutes = new Hono()
/** App operators reading call history from the browser. */
export const voiceOperatorRoutes = new Hono()
/** Sites browser opening a texted link. */
export const publicVoiceRoutes = new Hono()

const MAX_BODY_BYTES = 1024 * 1024

// Stored caps, applied by truncation so an over-long call still gets logged.
// 400 turns covers a ~30 minute call; 1000 chars is about a minute of speech.
// Worst case 400 x 1000 chars of 2-byte UTF-8 (Arabic) plus JSON overhead is
// ~820KB, which keeps a maximal transcript under MAX_BODY_BYTES.
export const TRANSCRIPT_MAX_TURNS = 400
export const TRANSCRIPT_MAX_TURN_CHARS = 1000

/** Transcripts follow the recording retention setting; this is the fallback. */
const DEFAULT_TRANSCRIPT_RETENTION_DAYS = 90

const MAX_SMS_PER_CALL = 2
// Bounds toll-fraud cost per org to a few dollars a day while staying well
// above what one business's phone traffic produces (2 texts per call).
const MAX_SMS_PER_ORG_PER_DAY = 300
// Staff alerts go to numbers the org configured, so they are capped on their
// own and never use up the caller-link budget.
export const MAX_STAFF_ALERT_SMS_PER_ORG_PER_DAY = 200
const STAFF_ALERT_TIMEOUT_MS = 5000

const LINE_VERIFICATIONS_PER_HOUR = 5
// A forwarded line needs one or two codes; ten a day leaves room for typos
// while bounding what a compromised operator account can spend on calls.
export const MAX_LINE_VERIFICATIONS_PER_ORG_PER_DAY = 10

const PURGE_BATCH_SIZE = 500

const orgIdSchema = z.string().min(1).max(64)
/** Opaque id a vertical uses for part of the business; never interpreted here. */
const scopeIdSchema = z.string().max(64).nullable().optional()

/** Longest SMS template the worker may send, before `{url}` is filled in. */
export const LINK_MESSAGE_MAX_CHARS = 320
export const DEFAULT_WEBSITE_LINK_SMS =
	"{business}: here's the link you asked for: {url}"

const linkMessageSchema = z
	.string()
	.trim()
	.min(1)
	.max(LINK_MESSAGE_MAX_CHARS)
	.refine((message) => message.includes('{url}'), {
		message: 'The message must include {url}',
	})

const transcriptSchema = z
	.array(
		z.object({
			role: z.enum(['agent', 'caller']),
			text: z
				.string()
				.transform((text) => text.slice(0, TRANSCRIPT_MAX_TURN_CHARS)),
			at: z.number().int().nonnegative(),
		}),
	)
	.transform((turns) => turns.slice(0, TRANSCRIPT_MAX_TURNS))

const startCallSchema = z.object({
	orgId: orgIdSchema,
	channel: z.enum(CALL_CHANNELS),
	roomName: z.string().min(1).max(200),
	scopeId: scopeIdSchema,
	flowVersionId: z.string().max(64).nullable().optional(),
	callerPhone: E164Schema.nullable().optional(),
})

const finishCallSchema = z.object({
	orgId: orgIdSchema,
	// Any definition slug: the purposes come from the org's vertical, which
	// tenant-api doesn't know.
	purpose: DefinitionIdSchema.nullable().optional(),
	outcome: z.enum(CALL_OUTCOMES),
	summary: z.string().max(2000).nullable().optional(),
	transcript: transcriptSchema,
	durationSeconds: z
		.number()
		.int()
		.min(0)
		.max(24 * 60 * 60),
	recordingKey: z.string().max(500).nullable().optional(),
	recordingRetentionDays: z.number().int().min(1).max(3650).optional(),
})

// `{business}` in messages is filled in with the organization name from the
// control plane, not a name the worker sends.
const handoffSchema = z.object({
	orgId: orgIdSchema,
	callId: z.string().uuid(),
	scopeId: scopeIdSchema,
	path: SitePathSchema,
	payload: LinkHandoffSchema.shape.payload.refine(
		(value) => value !== null,
		'The link data is missing or too large',
	),
	message: linkMessageSchema,
	sendTo: E164Schema.nullable().optional(),
})

const websiteLinkSchema = z.object({
	orgId: orgIdSchema,
	callId: z.string().uuid(),
	scopeId: scopeIdSchema,
	path: SitePathSchema.default('/'),
	message: linkMessageSchema.optional(),
	sendTo: E164Schema.nullable().optional(),
})

const requestSchema = z.object({
	orgId: orgIdSchema,
	callId: z.string().uuid(),
	type: DefinitionIdSchema,
	callerName: z.string().trim().max(120).nullable().optional(),
	callerPhone: E164Schema.nullable().optional(),
	details: z
		.record(z.string().max(60), z.string().max(1000))
		.refine((value) => Object.keys(value).length <= 20, 'Too many fields'),
})

const lineVerificationSchema = z.object({
	orgId: orgIdSchema,
	phone: E164Schema,
	code: z.string().regex(/^\d{6}$/),
	method: z.enum(['sms', 'call']),
})

// App sends the org's region instead of tenant-api looking the org up, so
// inactive organizations still get their expired recordings purged.
const purgeSchema = z.object({
	orgId: orgIdSchema,
	dataRegion: z.enum(['us', 'ksa']),
})

const eraseTargetFields = {
	phone: E164Schema.optional(),
	customerId: z.string().min(1).max(64).optional(),
}

function hasEraseTarget(value: { phone?: string; customerId?: string }) {
	return Boolean(value.phone || value.customerId)
}

const eraseTargetSchema = z
	.object(eraseTargetFields)
	.refine(hasEraseTarget, 'phone or customerId')

const eraseSchema = z
	.object({ orgId: orgIdSchema, ...eraseTargetFields })
	.refine(hasEraseTarget, 'phone or customerId')

export type SmsBlockedReason =
	| 'not_allowed_number'
	| 'call_limit'
	| 'daily_limit'
	| 'test_call'
	| 'unavailable_region'
	| 'send_failed'

function hashToken(token: string) {
	return createHash('sha256').update(token).digest('hex')
}

function isProduction() {
	return ENV.NODE_ENV === 'production'
}

export function publicSiteOrigin(org: {
	slug: string
	customDomain: string | null
}) {
	if (org.customDomain) return `https://${org.customDomain}`
	return isProduction()
		? `https://${org.slug}.${getBrandDomain()}`
		: `https://${org.slug}.${getLocalDomain()}:2999`
}

function organizationName(organization: PublishedOrganization) {
	return organization.name?.trim() || organization.slug
}

export function fillLinkMessage(
	template: string,
	values: { business: string; url: string },
) {
	return template
		.replaceAll('{business}', values.business)
		.replaceAll('{url}', values.url)
}

async function requireVoiceAgent(c: Context, next: Next) {
	const problem = voiceAgentTokenProblem()
	if (problem) {
		logVoiceAgentTokenProblem(problem)
		return c.json({ error: 'Not configured' }, 503)
	}
	if (
		!bearerMatches(
			c.req.header('Authorization'),
			getVoiceAgentToken(),
			VOICE_AGENT_TOKEN_MIN_LENGTH,
		)
	) {
		return c.json({ error: 'Unauthorized' }, 401)
	}
	await next()
}

async function requireInternal(c: Context, next: Next) {
	if (
		!bearerMatches(c.req.header('Authorization'), getInternalCommandToken(), 16)
	) {
		return c.json({ error: 'Unauthorized' }, 401)
	}
	await next()
}

async function regionalOrganization(orgId: string) {
	const organization = await findActiveOrganizationById(orgId)
	if (!organization || !orgMatchesNodeRegion(organization.dataRegion)) {
		return null
	}
	return organization
}

function regionUnavailable(c: Context) {
	return c.json({ error: 'Organization is not available in this region' }, 404)
}

voiceSystemRoutes.use(
	'*',
	bodyLimit({
		maxSize: MAX_BODY_BYTES,
		onError: (c) => c.json({ error: 'Payload too large' }, 413),
	}),
)

voiceSystemRoutes.post('/calls', requireVoiceAgent, async (c) => {
	const parsed = startCallSchema.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success) return c.json({ error: 'Invalid call' }, 400)
	const organization = await regionalOrganization(parsed.data.orgId)
	if (!organization) return regionUnavailable(c)
	const db = await getTenantDb(organization.id)

	const callerPhone = parsed.data.callerPhone ?? null
	// Caller ID is spoofable, so the match only links the call for operators;
	// nothing about the customer goes back to the voice worker.
	const [customer] = callerPhone
		? await db
				.select({ id: customers.id })
				.from(customers)
				.where(eq(customers.phone, callerPhone))
				.limit(1)
		: []

	// The worker can retry or start twice for one room; the unique room name
	// makes the second insert a no-op instead of a constraint error.
	const [created] = await db
		.insert(voiceCalls)
		.values({
			channel: parsed.data.channel,
			roomName: parsed.data.roomName,
			scopeId: parsed.data.scopeId ?? null,
			flowVersionId: parsed.data.flowVersionId ?? null,
			callerPhone,
			customerId: customer?.id ?? null,
			startedAt: new Date(),
		})
		.onConflictDoNothing({ target: voiceCalls.roomName })
		.returning({ id: voiceCalls.id })
	if (created) return c.json({ callId: created.id }, 201)
	const [existing] = await db
		.select({ id: voiceCalls.id })
		.from(voiceCalls)
		.where(eq(voiceCalls.roomName, parsed.data.roomName))
		.limit(1)
	if (!existing) return c.json({ error: 'Could not start call' }, 500)
	return c.json({ callId: existing.id })
})

voiceSystemRoutes.post(
	'/calls/:callId/finish',
	requireVoiceAgent,
	async (c) => {
		const body: unknown = await c.req.json().catch(() => null)
		const parsed = finishCallSchema.safeParse(body)
		if (!parsed.success) return c.json({ error: 'Invalid call summary' }, 400)
		const organization = await regionalOrganization(parsed.data.orgId)
		if (!organization) return regionUnavailable(c)
		const callId = c.req.param('callId') ?? ''
		if (
			parsed.data.recordingKey &&
			parsed.data.recordingKey !== expectedRecordingKey(organization.id, callId)
		) {
			return c.json({ error: 'Invalid recording key' }, 400)
		}
		const db = await getTenantDb(organization.id)
		const extras = parseFinishExtras(body)

		const now = new Date()
		const retentionMs =
			(parsed.data.recordingRetentionDays ??
				DEFAULT_TRANSCRIPT_RETENTION_DAYS) * 86_400_000
		const expiresAt = new Date(now.getTime() + retentionMs)
		const facts = await callFacts(db, callId, parsed.data.outcome, extras)
		const needsFollowUp = callNeedsFollowUp(facts, extras.followUp)
		const updated = await db
			.update(voiceCalls)
			.set({
				purpose: parsed.data.purpose ?? null,
				outcome: parsed.data.outcome,
				summary: parsed.data.summary ?? null,
				transcript: parsed.data.transcript,
				durationSeconds: parsed.data.durationSeconds,
				recordingKey: parsed.data.recordingKey ?? null,
				recordingExpiresAt: parsed.data.recordingKey ? expiresAt : null,
				transcriptExpiresAt: expiresAt,
				endedAt: now,
				tags: [...facts.tags],
				rating: facts.rating,
				sentiment: facts.sentiment,
				transferResult: facts.transferResult,
				transferContactId: extras.transferContactId,
				voicemail: facts.voicemail,
				calledWhileOpen: extras.calledWhileOpen,
				linkSent: facts.linkSent,
				followUpStatus: needsFollowUp ? 'open' : 'resolved',
				followUpResolvedAt: needsFollowUp ? null : now,
				autoResolveAt: needsFollowUp
					? autoResolveAt(facts, extras.followUp, now)
					: null,
			})
			.where(and(eq(voiceCalls.id, callId), isNull(voiceCalls.endedAt)))
			.returning({
				id: voiceCalls.id,
				channel: voiceCalls.channel,
				callerPhone: voiceCalls.callerPhone,
			})
		const finished = updated[0]
		if (finished) {
			if (finished.channel === 'phone') {
				await runAfterResponse(
					c,
					notifyStaff({
						db,
						organization,
						call: finished,
						summary: parsed.data.summary ?? null,
						facts,
						extras,
					}),
				)
			}
			return c.json({ success: true })
		}

		const [existing] = await db
			.select({ id: voiceCalls.id })
			.from(voiceCalls)
			.where(eq(voiceCalls.id, callId))
			.limit(1)
		return existing
			? c.json({ success: true, alreadyFinished: true })
			: c.json({ error: 'Call not found' }, 404)
	},
)

type CallForSms = {
	id: string
	channel: 'phone' | 'web_test'
	callerPhone: string | null
}

async function findCallForSms(db: TenantDatabase, callId: string) {
	const [call] = await db
		.select({
			id: voiceCalls.id,
			channel: voiceCalls.channel,
			callerPhone: voiceCalls.callerPhone,
		})
		.from(voiceCalls)
		.where(eq(voiceCalls.id, callId))
		.limit(1)
	return (call as CallForSms | undefined) ?? null
}

type SmsKind = 'handoff_link' | 'website_link' | 'staff_alert'

type SmsCap = {
	reason: Extract<SmsBlockedReason, 'call_limit' | 'daily_limit'>
	limit: number
	/** Counts the "sent" rows that use up this cap. */
	where: SQL
}

function sinceOneDayAgo() {
	return new Date(Date.now() - 86_400_000)
}

/** Caller-link caps: per call and per org per day; staff alerts excluded. */
function callerSmsCaps(callId: string): SmsCap[] {
	const callerSent = and(
		eq(voiceSmsSends.status, 'sent'),
		ne(voiceSmsSends.kind, 'staff_alert'),
	)!
	return [
		{
			reason: 'call_limit',
			limit: MAX_SMS_PER_CALL,
			where: and(callerSent, eq(voiceSmsSends.callId, callId))!,
		},
		{
			reason: 'daily_limit',
			limit: MAX_SMS_PER_ORG_PER_DAY,
			where: and(callerSent, gte(voiceSmsSends.createdAt, sinceOneDayAgo()))!,
		},
	]
}

function staffSmsCaps(): SmsCap[] {
	return [
		{
			reason: 'daily_limit',
			limit: MAX_STAFF_ALERT_SMS_PER_ORG_PER_DAY,
			where: and(
				eq(voiceSmsSends.kind, 'staff_alert'),
				eq(voiceSmsSends.status, 'sent'),
				gte(voiceSmsSends.createdAt, sinceOneDayAgo()),
			)!,
		},
	]
}

/**
 * Writes the "sent" log row only if every cap still has room, in a single
 * INSERT ... SELECT. SQLite runs one statement under its write lock, so two
 * concurrent requests cannot both take the last slot the way a separate
 * count-then-insert could.
 */
async function reserveSms(
	db: TenantDatabase,
	{
		callId,
		kind,
		to,
		caps,
	}: { callId: string; kind: SmsKind; to: string; caps: SmsCap[] },
): Promise<{ id: string } | { blocked: SmsCap['reason'] }> {
	const capsHaveRoom = sql.join(
		caps.map(
			(cap) =>
				sql`(select count(*) from ${voiceSmsSends} where ${cap.where}) < ${cap.limit}`,
		),
		sql` and `,
	)
	// Column order must match the voice_sms_sends definition.
	const [reserved] = await db
		.insert(voiceSmsSends)
		.select(
			sql`select ${randomUUID()}, ${callId}, ${kind}, ${to}, 'sent', null, strftime('%s', 'now') where ${capsHaveRoom}`,
		)
		.returning({ id: voiceSmsSends.id })
	if (reserved) return { id: reserved.id }
	for (const cap of caps) {
		const [row] = await db
			.select({ total: count() })
			.from(voiceSmsSends)
			.where(cap.where)
		if ((row?.total ?? 0) >= cap.limit) return { blocked: cap.reason }
	}
	// A slot freed up (a send failed) after the insert was refused.
	return { blocked: caps.at(-1)!.reason }
}

/**
 * Applies the SMS policy and logs every attempt in voice_sms_sends. The row
 * is reserved as "sent" before calling Twilio so it counts against the caps
 * while the text is in flight; it is flipped to "failed" if delivery throws.
 */
async function deliverSms({
	db,
	callId,
	kind,
	to,
	message,
	caps,
	precheck,
}: {
	db: TenantDatabase
	callId: string
	kind: SmsKind
	to: string
	message: string
	caps: SmsCap[]
	precheck: SmsBlockedReason | null
}): Promise<{ smsSent: boolean; smsBlockedReason?: SmsBlockedReason }> {
	const reservation: { id: string } | { blocked: SmsBlockedReason } = precheck
		? { blocked: precheck }
		: await reserveSms(db, { callId, kind, to, caps })
	if ('blocked' in reservation) {
		await db.insert(voiceSmsSends).values({
			callId,
			kind,
			toPhone: to,
			status: reservation.blocked === 'test_call' ? 'skipped' : 'blocked',
			reason: reservation.blocked,
		})
		return { smsSent: false, smsBlockedReason: reservation.blocked }
	}

	try {
		await sendSms({ to, message })
		return { smsSent: true }
	} catch (error) {
		console.error(`Failed to send ${kind} SMS`, error)
		await db
			.update(voiceSmsSends)
			.set({ status: 'failed', reason: 'send_failed' })
			.where(eq(voiceSmsSends.id, reservation.id))
		return { smsSent: false, smsBlockedReason: 'send_failed' }
	}
}

/**
 * Every text, including one to the caller's own number, must go to a US or
 * Canadian number: caller ID is spoofable, so "the caller's number" proves
 * nothing about where the SMS is billed.
 */
function smsDestinationBlock(to: string): SmsBlockedReason | null {
	if (getNodeRegion() !== 'us') return 'unavailable_region'
	if (!isUsOrCanadaNumber(to)) return 'not_allowed_number'
	return null
}

async function sendCallSms({
	db,
	call,
	kind,
	to,
	message,
}: {
	db: TenantDatabase
	call: CallForSms
	kind: 'handoff_link' | 'website_link'
	to: string
	message: string
}) {
	return deliverSms({
		db,
		callId: call.id,
		kind,
		to,
		message,
		caps: callerSmsCaps(call.id),
		precheck:
			call.channel === 'web_test' ? 'test_call' : smsDestinationBlock(to),
	})
}

const DEFAULT_FINISH_EXTRAS = CallFinishExtrasSchema.parse({})

/**
 * Reads the follow-up extras from a finish body field by field: a bad value
 * falls back to its default instead of failing the finish or dropping the
 * other fields.
 */
export function parseFinishExtras(body: unknown): CallFinishExtras {
	const parsed = CallFinishExtrasSchema.safeParse(body ?? {})
	if (parsed.success) return parsed.data
	const source =
		body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
	const extras: Record<string, unknown> = { ...DEFAULT_FINISH_EXTRAS }
	const invalid: string[] = []
	for (const [key, schema] of Object.entries(CallFinishExtrasSchema.shape)) {
		const field = schema.safeParse(source[key])
		if (field.success) extras[key] = field.data
		else invalid.push(key)
	}
	console.warn(
		`Ignoring invalid call finish extras: ${invalid.join(', ') || 'body'}`,
	)
	return extras as CallFinishExtras
}

async function callFacts(
	db: TenantDatabase,
	callId: string,
	outcome: CallFacts['outcome'],
	extras: CallFinishExtras,
): Promise<CallFacts> {
	const [requests, [sentSms], [handoff]] = await Promise.all([
		db
			.select({ type: voiceCallRequests.type })
			.from(voiceCallRequests)
			.where(eq(voiceCallRequests.callId, callId)),
		db
			.select({ id: voiceSmsSends.id })
			.from(voiceSmsSends)
			.where(
				and(
					eq(voiceSmsSends.callId, callId),
					eq(voiceSmsSends.status, 'sent'),
					ne(voiceSmsSends.kind, 'staff_alert'),
				),
			)
			.limit(1),
		// Undelivered handoffs on real calls are deleted, so any remaining one
		// was texted (or created on a test call, where nothing is texted).
		db
			.select({ id: voiceLinkHandoffs.id })
			.from(voiceLinkHandoffs)
			.where(eq(voiceLinkHandoffs.callId, callId))
			.limit(1),
	])
	return {
		outcome,
		tags: [...new Set(extras.tags)],
		importantTagIds: extras.importantTagIds,
		rating: extras.rating,
		sentiment: extras.sentiment,
		transferResult: extras.transferResult,
		voicemail: extras.voicemail,
		requestTypes: [...new Set(requests.map((request) => request.type))],
		linkSent: Boolean(sentSms || handoff),
	}
}

/** `needs_review` → `Needs review`; tenant-api only stores tag ids. */
export function tagLabel(id: string) {
	const words = id.replace(/_+/g, ' ').trim()
	return words.charAt(0).toUpperCase() + words.slice(1)
}

function escapeHtml(value: string) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

/**
 * Lets slow Twilio/email calls finish after the response where the runtime
 * supports it; on Node it waits a bounded time so the worker is not held up.
 */
async function runAfterResponse(c: Context, task: Promise<void>) {
	const safeTask = task.catch((error) => {
		console.error('Background voice task failed', error)
	})
	try {
		c.executionCtx.waitUntil(safeTask)
		return
	} catch {
		// Hono throws when there is no execution context (Node).
	}
	let timer: ReturnType<typeof setTimeout> | undefined
	await Promise.race([
		safeTask,
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, STAFF_ALERT_TIMEOUT_MS)
		}),
	])
	clearTimeout(timer)
}

async function sendStaffSms(
	db: TenantDatabase,
	callId: string,
	to: string,
	message: string,
) {
	await deliverSms({
		db,
		callId,
		kind: 'staff_alert',
		to,
		message,
		caps: staffSmsCaps(),
		precheck: smsDestinationBlock(to),
	})
}

/** Texts and emails the org's team about a finished call, once per call. */
async function notifyStaff({
	db,
	organization,
	call,
	summary,
	facts,
	extras,
}: {
	db: TenantDatabase
	organization: PublishedOrganization
	call: { id: string; callerPhone: string | null }
	summary: string | null
	facts: CallFacts
	extras: CallFinishExtras
}) {
	const notifications = extras.notifications
	if (!notifications) return
	if (!notifications.smsNumbers.length && !notifications.emails.length) return
	const events = matchedNotificationEvents(
		callNotificationEvents(facts),
		notifications.events,
	)
	if (!events.length) return

	const callUrl = notifications.includeCallLink
		? callLink(extras.callsUrl, call.id)
		: null
	const message = formatStaffNotification({
		businessName: organizationName(organization),
		events,
		callerPhone: call.callerPhone,
		summary,
		tags: facts.tags.map((id) => ({
			id,
			name: extras.tagNames[id] ?? tagLabel(id),
		})),
		callUrl,
	})
	const subject = message.split('\n')[0]!
	const html = message
		.split('\n')
		.map((line) =>
			line === callUrl
				? `<a href="${escapeHtml(line)}">View call</a>`
				: escapeHtml(line),
		)
		.join('<br>')

	const results = await Promise.allSettled([
		...[...new Set(notifications.smsNumbers)].map((to) =>
			sendStaffSms(db, call.id, to, message),
		),
		...[...new Set(notifications.emails)].map(async (to) => {
			const result = await sendTenantEmail({
				to,
				subject,
				text: message,
				html: `<p>${html}</p>`,
			})
			if (result.status === 'error') {
				console.error('Failed to send staff alert email', result.error)
			}
		}),
	])
	for (const result of results) {
		if (result.status === 'rejected') {
			console.error('Staff alert failed', result.reason)
		}
	}
}

voiceSystemRoutes.post('/handoffs', requireVoiceAgent, async (c) => {
	const parsed = handoffSchema.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success) {
		return c.json(
			{ error: parsed.error.issues[0]?.message ?? 'Invalid link' },
			400,
		)
	}
	const organization = await regionalOrganization(parsed.data.orgId)
	if (!organization) return regionUnavailable(c)
	const db = await getTenantDb(organization.id)
	const call = await findCallForSms(db, parsed.data.callId)
	if (!call) return c.json({ error: 'Call not found' }, 404)

	const recipient = parsed.data.sendTo ?? call.callerPhone
	const token = randomBytes(24).toString('base64url')
	const expiresAt = new Date(Date.now() + LINK_HANDOFF_TTL_HOURS * 3_600_000)
	// Inserted before texting so the link already resolves when the SMS lands;
	// removed again on real calls if the text is not delivered.
	const [handoff] = await db
		.insert(voiceLinkHandoffs)
		.values({
			callId: call.id,
			tokenHash: hashToken(token),
			scopeId: parsed.data.scopeId ?? null,
			path: parsed.data.path,
			payload: parsed.data.payload,
			sentToPhone: recipient,
			expiresAt,
		})
		.returning({ id: voiceLinkHandoffs.id })

	// The token lives in the fragment so it never reaches Sites server logs.
	const url = `${publicSiteOrigin(organization)}${parsed.data.path}#handoff=${token}`

	const result: { smsSent: boolean; smsBlockedReason?: SmsBlockedReason } =
		recipient
			? await sendCallSms({
					db,
					call,
					kind: 'handoff_link',
					to: recipient,
					message: fillLinkMessage(parsed.data.message, {
						business: organizationName(organization),
						url,
					}),
				})
			: {
					smsSent: false,
					smsBlockedReason:
						call.channel === 'web_test' ? 'test_call' : 'not_allowed_number',
				}

	if (result.smsSent) {
		await db
			.update(voiceLinkHandoffs)
			.set({ smsSentAt: new Date() })
			.where(eq(voiceLinkHandoffs.id, handoff!.id))
	} else if (call.channel !== 'web_test') {
		await db
			.delete(voiceLinkHandoffs)
			.where(eq(voiceLinkHandoffs.id, handoff!.id))
		return c.json(
			{ handoffId: null, url: null, expiresAt: null, ...result },
			201,
		)
	}

	return c.json({ handoffId: handoff!.id, url, expiresAt, ...result }, 201)
})

/** Texts a site link from a phone menu step; nothing from the call is attached. */
voiceSystemRoutes.post('/website-links', requireVoiceAgent, async (c) => {
	const parsed = websiteLinkSchema.safeParse(
		await c.req.json().catch(() => null),
	)
	if (!parsed.success) return c.json({ error: 'Invalid link request' }, 400)
	const organization = await regionalOrganization(parsed.data.orgId)
	if (!organization) return regionUnavailable(c)
	const db = await getTenantDb(organization.id)
	const call = await findCallForSms(db, parsed.data.callId)
	if (!call) return c.json({ error: 'Call not found' }, 404)

	const url = `${publicSiteOrigin(organization)}${parsed.data.path}`

	const recipient = parsed.data.sendTo ?? call.callerPhone
	const result: { smsSent: boolean; smsBlockedReason?: SmsBlockedReason } =
		recipient
			? await sendCallSms({
					db,
					call,
					kind: 'website_link',
					to: recipient,
					message: fillLinkMessage(
						parsed.data.message ?? DEFAULT_WEBSITE_LINK_SMS,
						{ business: organizationName(organization), url },
					),
				})
			: {
					smsSent: false,
					smsBlockedReason:
						call.channel === 'web_test' ? 'test_call' : 'not_allowed_number',
				}
	return c.json({ url, ...result }, 201)
})

voiceSystemRoutes.post('/requests', requireVoiceAgent, async (c) => {
	const parsed = requestSchema.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success) return c.json({ error: 'Invalid request' }, 400)
	const organization = await regionalOrganization(parsed.data.orgId)
	if (!organization) return regionUnavailable(c)
	const db = await getTenantDb(organization.id)
	const [call] = await db
		.select({ id: voiceCalls.id, callerPhone: voiceCalls.callerPhone })
		.from(voiceCalls)
		.where(eq(voiceCalls.id, parsed.data.callId))
		.limit(1)
	if (!call) return c.json({ error: 'Call not found' }, 404)
	const [request] = await db
		.insert(voiceCallRequests)
		.values({
			callId: call.id,
			type: parsed.data.type,
			callerName: parsed.data.callerName ?? null,
			callerPhone: parsed.data.callerPhone ?? call.callerPhone ?? null,
			details: parsed.data.details,
		})
		.returning({ id: voiceCallRequests.id })
	return c.json({ requestId: request!.id }, 201)
})

type LineVerificationCap = {
	error: 'rate_limit_exceeded' | 'daily_limit_exceeded'
	limit: number
	where: SQL
}

// Both caps count this org's own log, since each org has its own database;
// App additionally throttles code issuance per platform number.
function lineVerificationCaps(phone: string): LineVerificationCap[] {
	return [
		{
			error: 'rate_limit_exceeded',
			limit: LINE_VERIFICATIONS_PER_HOUR,
			where: and(
				eq(voiceLineVerifications.toPhone, phone),
				gte(voiceLineVerifications.createdAt, new Date(Date.now() - 3_600_000)),
			)!,
		},
		{
			error: 'daily_limit_exceeded',
			limit: MAX_LINE_VERIFICATIONS_PER_ORG_PER_DAY,
			where: gte(voiceLineVerifications.createdAt, sinceOneDayAgo()),
		},
	]
}

/**
 * Logs the attempt only if both the per-phone and per-org caps have room, in
 * one INSERT ... SELECT so concurrent requests (or processes) cannot both take
 * the last slot. Failed attempts count too: a placed call can be billed even
 * if it errors.
 */
async function reserveLineVerification(
	db: TenantDatabase,
	{ phone, method }: { phone: string; method: 'sms' | 'call' },
): Promise<{ id: string } | { blocked: LineVerificationCap['error'] }> {
	const caps = lineVerificationCaps(phone)
	const capsHaveRoom = sql.join(
		caps.map(
			(cap) =>
				sql`(select count(*) from ${voiceLineVerifications} where ${cap.where}) < ${cap.limit}`,
		),
		sql` and `,
	)
	// Column order must match the voice_line_verifications definition.
	const [attempt] = await db
		.insert(voiceLineVerifications)
		.select(
			sql`select ${randomUUID()}, ${phone}, ${method}, 'sent', strftime('%s', 'now') where ${capsHaveRoom}`,
		)
		.returning({ id: voiceLineVerifications.id })
	if (attempt) return { id: attempt.id }
	for (const cap of caps) {
		const [row] = await db
			.select({ total: count() })
			.from(voiceLineVerifications)
			.where(cap.where)
		if ((row?.total ?? 0) >= cap.limit) return { blocked: cap.error }
	}
	return { blocked: caps.at(-1)!.error }
}

/** App → US tenant-api: proves an operator controls a phone line. */
voiceSystemRoutes.post('/line-verifications', requireInternal, async (c) => {
	if (getNodeRegion() !== 'us') {
		return c.json({ error: 'Line verification is only available in us' }, 409)
	}
	const parsed = lineVerificationSchema.safeParse(
		await c.req.json().catch(() => null),
	)
	if (!parsed.success) return c.json({ error: 'Invalid verification' }, 400)
	const { phone, code, method } = parsed.data
	// Forwarded lines are US or Canadian; anything else (premium or
	// Caribbean "+1" numbers) is a toll-fraud target.
	if (!isUsOrCanadaNumber(phone)) {
		return c.json({ error: 'not_allowed_number' }, 400)
	}
	const organization = await regionalOrganization(parsed.data.orgId)
	if (!organization) return regionUnavailable(c)
	const db = await getTenantDb(organization.id)
	const attempt = await reserveLineVerification(db, { phone, method })
	if ('blocked' in attempt) return c.json({ error: attempt.blocked }, 429)
	try {
		if (method === 'sms') {
			await sendSms({
				to: phone,
				message: `Your ${brand.name} verification code is ${code}`,
			})
		} else {
			await placeVerificationCall({ to: phone, code, brandName: brand.name })
		}
	} catch (error) {
		console.error(`Failed to send line verification by ${method}`, error)
		await db
			.update(voiceLineVerifications)
			.set({ status: 'failed' })
			.where(eq(voiceLineVerifications.id, attempt.id))
		return c.json({ error: 'Could not send verification' }, 502)
	}
	return c.json({ sent: true })
})

type RecordingRemoval = 'deleted' | 'queued' | 'failed'

/**
 * Every key a call's recording may be stored under. The expected key is
 * included even when the row has none: a recording that started after the
 * call finished exists in storage without ever reaching recording_key.
 */
function callRecordingKeys(
	orgId: string,
	call: { id: string; recordingKey: string | null },
) {
	const expected = expectedRecordingKey(orgId, call.id)
	return call.recordingKey && call.recordingKey !== expected
		? [call.recordingKey, expected]
		: [expected]
}

/**
 * Deletes a call's recording before its row goes away; a missing object
 * counts as deleted. Without storage credentials the keys are queued in
 * voice_recording_deletions (they hold only org and call ids) so the daily
 * purge deletes the objects later instead of them being orphaned once the
 * row that pointed at them is gone.
 */
async function removeCallRecordings(
	db: TenantDatabase,
	orgId: string,
	call: { id: string; recordingKey: string | null },
): Promise<RecordingRemoval> {
	let queued = false
	for (const recordingKey of callRecordingKeys(orgId, call)) {
		const result = await deleteRecordingObject(recordingKey)
		if (result === 'failed') return 'failed'
		if (result === 'not_configured') {
			await db
				.insert(voiceRecordingDeletions)
				.values({ recordingKey })
				.onConflictDoNothing()
			queued = true
		}
	}
	return queued ? 'queued' : 'deleted'
}

type RecordingPurgeCounts = {
	recordingsDeleted: number
	recordingsPending: number
	recordingsFailed: number
	/** Left for the next run because the purge ran out of time. */
	recordingsDeferred: number
}

/**
 * App's daily job gives each org's purge 30s. Deletes stop starting after
 * this budget; each one is bounded by BUDGETED_REQUEST_TIMEOUT_MS, which
 * leaves time for the database clean-up that follows.
 */
export const RECORDING_PURGE_BUDGET_MS = 15_000

type RecordingDeleteBatch = {
	deadline: number
	counts: RecordingPurgeCounts
}

/**
 * Deletes the objects with bounded concurrency until the deadline. Keys not
 * reached stay where they are (on the call row or in the queue), so the next
 * run picks them up.
 */
async function deleteRecordingBatch<T extends { recordingKey: string }>(
	items: readonly T[],
	{ deadline, counts }: RecordingDeleteBatch,
	onDeleted: (item: T) => Promise<void>,
) {
	const run = await forEachWithBudget(
		items,
		{ concurrency: RECORDING_DELETE_CONCURRENCY, deadline },
		async (item) => {
			const result = await deleteRecordingObject(
				item.recordingKey,
				BUDGETED_REQUEST_TIMEOUT_MS,
			)
			if (result === 'deleted') {
				await onDeleted(item)
				counts.recordingsDeleted++
			} else if (result === 'not_configured') {
				counts.recordingsPending++
			} else {
				counts.recordingsFailed++
			}
		},
	)
	counts.recordingsDeferred += run.skipped
}

async function purgeExpiredRecordings(
	db: TenantDatabase,
	orgId: string,
	now: Date,
	batch: RecordingDeleteBatch,
) {
	const expiredRecordings = await db
		.select({ id: voiceCalls.id, recordingKey: voiceCalls.recordingKey })
		.from(voiceCalls)
		.where(
			and(
				isNotNull(voiceCalls.recordingKey),
				lte(voiceCalls.recordingExpiresAt, now),
			),
		)
		.limit(PURGE_BATCH_SIZE)
	await deleteRecordingBatch(
		expiredRecordings as Array<{ id: string; recordingKey: string }>,
		batch,
		async (call) => {
			await db
				.update(voiceCalls)
				.set({
					recordingKey: null,
					recordingExpiresAt: null,
					// The expected key is the one just deleted; no sweep needed.
					...(call.recordingKey === expectedRecordingKey(orgId, call.id)
						? { recordingSweptAt: now }
						: {}),
				})
				.where(eq(voiceCalls.id, call.id))
		},
	)
}

async function purgeQueuedRecordings(
	db: TenantDatabase,
	batch: RecordingDeleteBatch,
) {
	const queued = await db
		.select({ recordingKey: voiceRecordingDeletions.recordingKey })
		.from(voiceRecordingDeletions)
		.orderBy(voiceRecordingDeletions.createdAt)
		.limit(PURGE_BATCH_SIZE)
	await deleteRecordingBatch(queued, batch, async ({ recordingKey }) => {
		await db
			.delete(voiceRecordingDeletions)
			.where(eq(voiceRecordingDeletions.recordingKey, recordingKey))
	})
}

/**
 * Queues the expected recording key of calls past retention that never got
 * a recording_key (see callRecordingKeys), once per call. Skipped without
 * storage credentials, where it would only grow the queue with keys that
 * mostly do not exist.
 */
async function queueUnreferencedRecordings(
	db: TenantDatabase,
	orgId: string,
	expiredCalls: SQLWrapper,
	now: Date,
) {
	if (!getRecordingStorageConfig()) return
	const calls = await db
		.select({ id: voiceCalls.id })
		.from(voiceCalls)
		.where(
			and(
				inArray(voiceCalls.id, expiredCalls),
				isNull(voiceCalls.recordingKey),
				isNull(voiceCalls.recordingSweptAt),
			),
		)
		.limit(PURGE_BATCH_SIZE)
	if (!calls.length) return
	// Queue before marking: a crash in between only re-queues the same keys.
	await db
		.insert(voiceRecordingDeletions)
		.values(
			calls.map((call) => ({
				recordingKey: expectedRecordingKey(orgId, call.id),
			})),
		)
		.onConflictDoNothing()
	await db
		.update(voiceCalls)
		.set({ recordingSweptAt: now })
		.where(
			inArray(
				voiceCalls.id,
				calls.map((call) => call.id),
			),
		)
}

/** Line-verification logs only feed the daily cap; keep a month for audits. */
const LINE_VERIFICATION_LOG_DAYS = 30

/**
 * Texted links stay in the call detail this long after they stop working,
 * then go: payloads can hold what the caller dictated (notes, names).
 */
export const HANDOFF_GRACE_DAYS = 7

/**
 * App → tenant-api daily job: deletes expired and queued recordings, clears
 * caller data (transcript, summary, phone, customer link, and the caller
 * details on its requests) from calls past their transcript retention, and
 * deletes texted links past their grace period or their call's retention.
 */
voiceSystemRoutes.post('/retention/purge', requireInternal, async (c) => {
	const parsed = purgeSchema.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success) return c.json({ error: 'Invalid purge request' }, 400)
	if (!orgMatchesNodeRegion(parsed.data.dataRegion)) {
		return regionUnavailable(c)
	}
	let db: TenantDatabase
	try {
		// Never create a database here; a missing one has nothing to purge.
		db = await getTenantDb(parsed.data.orgId)
	} catch {
		return c.json({ error: 'Tenant database not found' }, 404)
	}
	const { orgId } = parsed.data
	const now = new Date()

	// Calls the worker never finished have no expiry; age them out from start.
	const unfinishedCutoff = new Date(
		now.getTime() - DEFAULT_TRANSCRIPT_RETENTION_DAYS * 86_400_000,
	)
	const expiredCalls = db
		.select({ id: voiceCalls.id })
		.from(voiceCalls)
		.where(
			or(
				lte(voiceCalls.transcriptExpiresAt, now),
				and(
					isNull(voiceCalls.transcriptExpiresAt),
					isNull(voiceCalls.endedAt),
					lt(voiceCalls.startedAt, unfinishedCutoff),
				),
			),
		)

	const counts: RecordingPurgeCounts = {
		recordingsDeleted: 0,
		recordingsPending: 0,
		recordingsFailed: 0,
		recordingsDeferred: 0,
	}
	const batch = { deadline: now.getTime() + RECORDING_PURGE_BUDGET_MS, counts }
	await queueUnreferencedRecordings(db, orgId, expiredCalls, now)
	await purgeExpiredRecordings(db, orgId, now, batch)
	await purgeQueuedRecordings(db, batch)

	const cleared = await db
		.update(voiceCalls)
		.set({ transcript: [], summary: null, callerPhone: null, customerId: null })
		.where(
			and(
				inArray(voiceCalls.id, expiredCalls),
				or(
					ne(voiceCalls.transcript, sql`'[]'`),
					isNotNull(voiceCalls.summary),
					isNotNull(voiceCalls.callerPhone),
					isNotNull(voiceCalls.customerId),
				),
			),
		)
		.returning({ id: voiceCalls.id })
	const requestsCleared = await db
		.update(voiceCallRequests)
		.set({ callerName: null, callerPhone: null, details: {} })
		.where(
			and(
				inArray(voiceCallRequests.callId, expiredCalls),
				or(
					isNotNull(voiceCallRequests.callerName),
					isNotNull(voiceCallRequests.callerPhone),
					ne(voiceCallRequests.details, sql`'{}'`),
				),
			),
		)
		.returning({ id: voiceCallRequests.id })
	const handoffsDeleted = await db
		.delete(voiceLinkHandoffs)
		.where(
			or(
				lt(
					voiceLinkHandoffs.expiresAt,
					new Date(now.getTime() - HANDOFF_GRACE_DAYS * 86_400_000),
				),
				inArray(voiceLinkHandoffs.callId, expiredCalls),
			),
		)
		.returning({ id: voiceLinkHandoffs.id })
	await db
		.delete(voiceSmsSends)
		.where(inArray(voiceSmsSends.callId, expiredCalls))
	await db
		.delete(voiceLineVerifications)
		.where(
			lt(
				voiceLineVerifications.createdAt,
				new Date(now.getTime() - LINE_VERIFICATION_LOG_DAYS * 86_400_000),
			),
		)

	const autoResolved = await db
		.update(voiceCalls)
		.set({
			followUpStatus: 'resolved',
			followUpResolvedAt: now,
			autoResolveAt: null,
		})
		.where(
			and(
				eq(voiceCalls.followUpStatus, 'open'),
				lte(voiceCalls.autoResolveAt, now),
			),
		)
		.returning({ id: voiceCalls.id })

	return c.json({
		success: counts.recordingsFailed === 0,
		...counts,
		transcriptsCleared: cleared.length,
		requestsCleared: requestsCleared.length,
		handoffsDeleted: handoffsDeleted.length,
		followUpsResolved: autoResolved.length,
	})
})

type EraseResult =
	| { error: 'recording_failed' }
	| {
			callsDeleted: number
			requestsDeleted: number
			smsLogsDeleted: number
			recordingsQueued: number
	  }

/**
 * Erases a caller's voice data: calls by customer or phone (with their
 * requests, handoffs, SMS log and recordings), plus requests, texts and
 * handoff recipients left on other calls with that phone. A customer id also
 * erases by that customer's phone.
 */
export async function eraseCallerVoiceData(
	db: TenantDatabase,
	orgId: string,
	target: { phone?: string; customerId?: string },
): Promise<EraseResult> {
	const customerIds = new Set<string>()
	const phones = new Set<string>()
	if (target.customerId) customerIds.add(target.customerId)
	if (target.phone) phones.add(target.phone)
	const matches = await db
		.select({ id: customers.id, phone: customers.phone })
		.from(customers)
		.where(
			or(
				target.customerId ? eq(customers.id, target.customerId) : undefined,
				target.phone ? eq(customers.phone, target.phone) : undefined,
			),
		)
	for (const match of matches) {
		customerIds.add(match.id)
		if (match.phone) phones.add(match.phone)
	}

	const calls = await db
		.select({ id: voiceCalls.id, recordingKey: voiceCalls.recordingKey })
		.from(voiceCalls)
		.where(
			or(
				customerIds.size
					? inArray(voiceCalls.customerId, [...customerIds])
					: undefined,
				phones.size ? inArray(voiceCalls.callerPhone, [...phones]) : undefined,
			),
		)

	let recordingsQueued = 0
	for (const call of calls) {
		const result = await removeCallRecordings(db, orgId, call)
		// Keep the rows so the erasure can be retried and still find the key.
		if (result === 'failed') return { error: 'recording_failed' }
		// Only known recordings count; the expected key is queued just in case.
		if (result === 'queued' && call.recordingKey) recordingsQueued++
	}

	const callIds = calls.map((call) => call.id)
	if (callIds.length) {
		await db.delete(voiceCalls).where(inArray(voiceCalls.id, callIds))
	}
	let requestsDeleted = 0
	let smsLogsDeleted = 0
	if (phones.size) {
		const phoneList = [...phones]
		const requests = await db
			.delete(voiceCallRequests)
			.where(inArray(voiceCallRequests.callerPhone, phoneList))
			.returning({ id: voiceCallRequests.id })
		requestsDeleted = requests.length
		const smsLogs = await db
			.delete(voiceSmsSends)
			.where(inArray(voiceSmsSends.toPhone, phoneList))
			.returning({ id: voiceSmsSends.id })
		smsLogsDeleted = smsLogs.length
		await db
			.update(voiceLinkHandoffs)
			.set({ sentToPhone: null })
			.where(inArray(voiceLinkHandoffs.sentToPhone, phoneList))
	}

	return {
		callsDeleted: callIds.length,
		requestsDeleted,
		smsLogsDeleted,
		recordingsQueued,
	}
}

function eraseResponse(c: Context, result: EraseResult) {
	if ('error' in result) {
		return c.json({ error: 'Could not delete a call recording' }, 502)
	}
	return c.json({ success: true, ...result })
}

/** App server → tenant-api (INTERNAL_COMMAND_TOKEN): erases a caller. */
voiceSystemRoutes.post('/erase', requireInternal, async (c) => {
	const parsed = eraseSchema.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success) return c.json({ error: 'Invalid erase request' }, 400)
	const organization = await regionalOrganization(parsed.data.orgId)
	if (!organization) return regionUnavailable(c)
	const db = await getTenantDb(organization.id)
	return eraseResponse(
		c,
		await eraseCallerVoiceData(db, organization.id, parsed.data),
	)
})

const PHONE_CALLS_SCOPE = 'phone_calls'

/**
 * Authenticates the operator, checks the App-granted permission, and, like
 * the system routes, that the org lives on this node with a provisioned
 * database. Throws the error response.
 */
async function operatorOrgId(
	c: Context,
	permission: 'read' | 'update' | 'delete' = 'read',
) {
	const operator = await authenticateOperator(c, PHONE_CALLS_SCOPE)
	if (
		(permission === 'update' && operator.canUpdate !== true) ||
		(permission === 'delete' && operator.canDelete !== true)
	) {
		throw c.json({ error: 'Forbidden' }, 403)
	}
	const organization = await findActiveOrganizationById(operator.orgId)
	if (!organization) throw regionUnavailable(c)
	if (!orgMatchesNodeRegion(organization.dataRegion)) {
		throw c.json(
			{
				error: 'region_mismatch',
				message: `Organization dataRegion "${organization.dataRegion}" does not match this node ("${getNodeRegion()}")`,
			},
			409,
		)
	}
	if (!organization.hasProvisionedDb) {
		throw c.json(
			{
				error: 'tenant_not_provisioned',
				message: 'This organization has not provisioned a customer database.',
			},
			409,
		)
	}
	return organization.id
}

/** Follow-up and review fields shared by the call list and detail. */
const callReviewColumns = {
	followUpStatus: voiceCalls.followUpStatus,
	followUpResolvedAt: voiceCalls.followUpResolvedAt,
	tags: voiceCalls.tags,
	rating: voiceCalls.rating,
	sentiment: voiceCalls.sentiment,
	transferResult: voiceCalls.transferResult,
	voicemail: voiceCalls.voicemail,
	calledWhileOpen: voiceCalls.calledWhileOpen,
	linkSent: voiceCalls.linkSent,
}

const updateCallSchema = z
	.object({
		followUpStatus: z.enum(CALL_FOLLOW_UP_STATUSES).optional(),
		tags: z
			.array(
				z
					.string()
					.trim()
					.regex(/^[a-z0-9_]{1,60}$/u),
			)
			.max(10)
			.transform((tags) => [...new Set(tags)])
			.optional(),
	})
	.refine(
		(value) => value.followUpStatus !== undefined || value.tags !== undefined,
		'Nothing to update',
	)

const CURSOR_PATTERN = /^(\d{1,12})\.([0-9a-f-]{36})$/

const listQuerySchema = z.object({
	purpose: DefinitionIdSchema.optional(),
	channel: z.enum(CALL_CHANNELS).optional(),
	followUp: z.enum(CALL_FOLLOW_UP_STATUSES).optional(),
	tag: z
		.string()
		.regex(/^[a-z0-9_]{1,60}$/u)
		.optional(),
	/** Opaque keyset cursor `<startedAt seconds>.<call id>` from `nextCursor`. */
	cursor: z.string().regex(CURSOR_PATTERN).optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
})

function cursorCondition(cursor: string | undefined) {
	const match = cursor ? CURSOR_PATTERN.exec(cursor) : null
	if (!match) return undefined
	const startedAt = new Date(Number(match[1]) * 1000)
	return or(
		lt(voiceCalls.startedAt, startedAt),
		and(eq(voiceCalls.startedAt, startedAt), lt(voiceCalls.id, match[2]!)),
	)
}

voiceOperatorRoutes.get('/', async (c) => {
	let orgId: string
	try {
		orgId = await operatorOrgId(c)
	} catch (response) {
		return response as Response
	}
	const query = listQuerySchema.safeParse(c.req.query())
	if (!query.success) return c.json({ error: 'Invalid filters' }, 400)
	const db = await getTenantDb(orgId)
	const filters = [
		query.data.purpose ? eq(voiceCalls.purpose, query.data.purpose) : undefined,
		query.data.channel ? eq(voiceCalls.channel, query.data.channel) : undefined,
		query.data.followUp
			? eq(voiceCalls.followUpStatus, query.data.followUp)
			: undefined,
		query.data.tag
			? sql`exists (select 1 from json_each(${voiceCalls.tags}) where json_each.value = ${query.data.tag})`
			: undefined,
		cursorCondition(query.data.cursor),
	].filter((value) => value !== undefined)

	const calls = await db
		.select({
			id: voiceCalls.id,
			channel: voiceCalls.channel,
			scopeId: voiceCalls.scopeId,
			callerPhone: voiceCalls.callerPhone,
			customerName: customers.name,
			purpose: voiceCalls.purpose,
			outcome: voiceCalls.outcome,
			summary: voiceCalls.summary,
			startedAt: voiceCalls.startedAt,
			durationSeconds: voiceCalls.durationSeconds,
			hasRecording: sql<number>`${voiceCalls.recordingKey} is not null`,
			...callReviewColumns,
		})
		.from(voiceCalls)
		.leftJoin(customers, eq(customers.id, voiceCalls.customerId))
		.where(filters.length ? and(...filters) : undefined)
		.orderBy(desc(voiceCalls.startedAt), desc(voiceCalls.id))
		.limit(query.data.limit)

	const last = calls.at(-1)
	const nextCursor =
		last && calls.length === query.data.limit
			? `${Math.floor(last.startedAt.getTime() / 1000)}.${last.id}`
			: null

	const since = new Date(Date.now() - 30 * 86_400_000)
	const purposeCounts = await db
		.select({ purpose: voiceCalls.purpose, total: count() })
		.from(voiceCalls)
		.where(gte(voiceCalls.startedAt, since))
		.groupBy(voiceCalls.purpose)
	const [openRequests] = await db
		.select({ total: count() })
		.from(voiceCallRequests)
		.where(eq(voiceCallRequests.status, 'open'))
	const [openFollowUps] = await db
		.select({ total: count() })
		.from(voiceCalls)
		.where(eq(voiceCalls.followUpStatus, 'open'))

	return c.json({
		calls: calls.map((call) => ({
			...call,
			hasRecording: Boolean(call.hasRecording),
		})),
		nextCursor,
		purposeCounts,
		openRequests: openRequests?.total ?? 0,
		openFollowUps: openFollowUps?.total ?? 0,
	})
})

const requestsQuerySchema = z.object({
	status: z.enum(CALL_REQUEST_STATUSES).optional(),
})

voiceOperatorRoutes.get('/requests', async (c) => {
	let orgId: string
	try {
		orgId = await operatorOrgId(c)
	} catch (response) {
		return response as Response
	}
	const query = requestsQuerySchema.safeParse(c.req.query())
	if (!query.success) return c.json({ error: 'Invalid filters' }, 400)
	const db = await getTenantDb(orgId)
	const requests = await db
		.select()
		.from(voiceCallRequests)
		.where(
			query.data.status
				? eq(voiceCallRequests.status, query.data.status)
				: undefined,
		)
		.orderBy(desc(voiceCallRequests.createdAt))
		.limit(200)
	return c.json({ requests })
})

voiceOperatorRoutes.patch('/requests/:requestId', async (c) => {
	let orgId: string
	try {
		orgId = await operatorOrgId(c, 'update')
	} catch (response) {
		return response as Response
	}
	const parsed = z
		.object({ status: z.enum(CALL_REQUEST_STATUSES) })
		.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success) return c.json({ error: 'Invalid status' }, 400)
	const db = await getTenantDb(orgId)
	const updated = await db
		.update(voiceCallRequests)
		.set({
			status: parsed.data.status,
			updatedAt: sql`(strftime('%s', 'now'))`,
		})
		.where(eq(voiceCallRequests.id, c.req.param('requestId')))
		.returning({ id: voiceCallRequests.id })
	return updated.length
		? c.json({ success: true })
		: c.json({ error: 'Request not found' }, 404)
})

voiceOperatorRoutes.get('/:callId', async (c) => {
	let orgId: string
	try {
		orgId = await operatorOrgId(c)
	} catch (response) {
		return response as Response
	}
	const db = await getTenantDb(orgId)
	const [row] = await db
		.select({
			id: voiceCalls.id,
			channel: voiceCalls.channel,
			scopeId: voiceCalls.scopeId,
			flowVersionId: voiceCalls.flowVersionId,
			callerPhone: voiceCalls.callerPhone,
			customerName: customers.name,
			purpose: voiceCalls.purpose,
			outcome: voiceCalls.outcome,
			summary: voiceCalls.summary,
			transcript: voiceCalls.transcript,
			hasRecording: sql<number>`${voiceCalls.recordingKey} is not null`,
			startedAt: voiceCalls.startedAt,
			endedAt: voiceCalls.endedAt,
			durationSeconds: voiceCalls.durationSeconds,
			...callReviewColumns,
			autoResolveAt: voiceCalls.autoResolveAt,
			transferContactId: voiceCalls.transferContactId,
		})
		.from(voiceCalls)
		.leftJoin(customers, eq(customers.id, voiceCalls.customerId))
		.where(eq(voiceCalls.id, c.req.param('callId')))
		.limit(1)
	if (!row) return c.json({ error: 'Call not found' }, 404)
	const call = { ...row, hasRecording: Boolean(row.hasRecording) }
	const [handoffs, requests] = await Promise.all([
		db
			.select({
				id: voiceLinkHandoffs.id,
				scopeId: voiceLinkHandoffs.scopeId,
				path: voiceLinkHandoffs.path,
				payload: voiceLinkHandoffs.payload,
				sentToPhone: voiceLinkHandoffs.sentToPhone,
				smsSentAt: voiceLinkHandoffs.smsSentAt,
				openedAt: voiceLinkHandoffs.openedAt,
				expiresAt: voiceLinkHandoffs.expiresAt,
				createdAt: voiceLinkHandoffs.createdAt,
			})
			.from(voiceLinkHandoffs)
			.where(eq(voiceLinkHandoffs.callId, call.id))
			.orderBy(voiceLinkHandoffs.createdAt),
		db
			.select()
			.from(voiceCallRequests)
			.where(eq(voiceCallRequests.callId, call.id)),
	])
	return c.json({ call, handoffs, requests })
})

voiceOperatorRoutes.patch('/:callId', async (c) => {
	let orgId: string
	try {
		orgId = await operatorOrgId(c, 'update')
	} catch (response) {
		return response as Response
	}
	const parsed = updateCallSchema.safeParse(
		await c.req.json().catch(() => null),
	)
	if (!parsed.success) return c.json({ error: 'Invalid update' }, 400)
	const { followUpStatus, tags } = parsed.data
	const db = await getTenantDb(orgId)
	const now = new Date()
	const [call] = await db
		.update(voiceCalls)
		.set({
			...(tags ? { tags } : {}),
			...(followUpStatus === 'resolved'
				? { followUpStatus, followUpResolvedAt: now, autoResolveAt: null }
				: {}),
			...(followUpStatus === 'open'
				? { followUpStatus, followUpResolvedAt: null }
				: {}),
		})
		.where(eq(voiceCalls.id, c.req.param('callId')))
		.returning({
			id: voiceCalls.id,
			followUpStatus: voiceCalls.followUpStatus,
			followUpResolvedAt: voiceCalls.followUpResolvedAt,
			autoResolveAt: voiceCalls.autoResolveAt,
			tags: voiceCalls.tags,
		})
	return call
		? c.json({ success: true, call })
		: c.json({ error: 'Call not found' }, 404)
})

voiceOperatorRoutes.delete('/:callId', async (c) => {
	let orgId: string
	try {
		orgId = await operatorOrgId(c, 'delete')
	} catch (response) {
		return response as Response
	}
	const db = await getTenantDb(orgId)
	const callId = c.req.param('callId')
	const [call] = await db
		.select({ id: voiceCalls.id, recordingKey: voiceCalls.recordingKey })
		.from(voiceCalls)
		.where(eq(voiceCalls.id, callId))
		.limit(1)
	if (!call) return c.json({ error: 'Call not found' }, 404)
	const result = await removeCallRecordings(db, orgId, call)
	// Keep the row so a retry can still find and delete the recording.
	if (result === 'failed') {
		return c.json({ error: 'Could not delete the call recording' }, 502)
	}
	await db.delete(voiceCalls).where(eq(voiceCalls.id, callId))
	return c.json({ success: true })
})

/**
 * App browser → tenant-api: an operator erases one caller's voice data (a
 * data-subject deletion request). The phone travels browser → regional node
 * only, never through App servers, like the rest of the operator call routes.
 */
voiceOperatorRoutes.post('/erase', async (c) => {
	let orgId: string
	try {
		orgId = await operatorOrgId(c, 'delete')
	} catch (response) {
		return response as Response
	}
	const parsed = eraseTargetSchema.safeParse(
		await c.req.json().catch(() => null),
	)
	if (!parsed.success) return c.json({ error: 'Invalid erase request' }, 400)
	const db = await getTenantDb(orgId)
	return eraseResponse(c, await eraseCallerVoiceData(db, orgId, parsed.data))
})

const publicIdentitySchema = z.object({
	slug: z.string().max(120).optional(),
	host: z.string().max(253).optional(),
})

publicVoiceRoutes.get('/handoffs/:token', async (c) => {
	const token = c.req.param('token')
	if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) {
		return c.json({ error: 'Link not found' }, 404)
	}
	const identity = publicIdentitySchema.safeParse({
		slug: c.req.query('slug'),
		host: c.req.query('host'),
	})
	if (!identity.success) return c.json({ error: 'Link not found' }, 404)
	const organization = await resolveOrganizationForBrowserAuth(
		c.req.header('Origin'),
		identity.data,
	)
	if (!organization) return c.json({ error: 'Link not found' }, 404)

	const db = await getTenantDb(organization.id)
	const [handoff] = await db
		.select({
			id: voiceLinkHandoffs.id,
			scopeId: voiceLinkHandoffs.scopeId,
			path: voiceLinkHandoffs.path,
			payload: voiceLinkHandoffs.payload,
			expiresAt: voiceLinkHandoffs.expiresAt,
			openedAt: voiceLinkHandoffs.openedAt,
		})
		.from(voiceLinkHandoffs)
		.where(eq(voiceLinkHandoffs.tokenHash, hashToken(token)))
		.limit(1)
	if (!handoff || handoff.expiresAt.getTime() < Date.now()) {
		return c.json({ error: 'This link has expired' }, 410)
	}
	if (!handoff.openedAt) {
		await db
			.update(voiceLinkHandoffs)
			.set({ openedAt: new Date() })
			.where(eq(voiceLinkHandoffs.id, handoff.id))
	}
	c.header('Cache-Control', 'private, no-store')
	return c.json({
		path: handoff.path,
		payload: handoff.payload,
		scopeId: handoff.scopeId,
		expiresAt: handoff.expiresAt,
	})
})
