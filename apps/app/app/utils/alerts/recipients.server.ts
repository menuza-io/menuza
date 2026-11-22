import {
	alertSmsText,
	alertSettingsNote,
} from '@repo/common/operator-alert-copy'
import {
	alertPhoneHash,
	ALERT_VERIFY_CODE_LENGTH,
	ALERT_VERIFY_MAX_ATTEMPTS,
	ALERT_VERIFY_SENDS_PER_HOUR,
	ALERT_VERIFY_TTL_MS,
	MAX_ALERT_RECIPIENTS_PER_LOCATION,
	resolveOrderAlertHashSecret,
	type AlertKeywordEvent,
} from '@repo/common/operator-alerts'
import { isValidE164Phone, normalizePhone } from '@repo/common/phone'
import {
	and,
	count,
	db,
	eq,
	isNotNull,
	isNull,
	lt,
	OrderAlertRecipient,
	sql,
} from '@repo/database'
import { sendEmail, StaffingAlertEmail } from '@repo/email'
import { ENV } from 'varlock/env'
import { z } from 'zod'
import { checkRateLimit } from '#app/utils/rate-limit.server.ts'
import { alertTextsAvailable, getAlertTextProvider } from './text.server.ts'

/**
 * The people a location tells about new online orders (#241): an email address
 * or a mobile number, not necessarily a member. Every one confirms with a
 * one-time code before any alert (an address nobody confirmed could be a
 * stranger's), a text recipient can reply STOP, and removing a recipient
 * deletes the row, so the next alert finds nobody. At most five per location.
 * These are staff contact details, never a guest's.
 */

export type RecipientRow = typeof OrderAlertRecipient.$inferSelect

export type RecipientView = {
	id: string
	kind: 'email' | 'phone'
	address: string
	verified: boolean
	stopped: boolean
	onlineOrders: boolean
	scheduledOrders: boolean
}

export function toRecipientView(row: RecipientRow): RecipientView {
	return {
		id: row.id,
		kind: row.kind === 'phone' ? 'phone' : 'email',
		address: row.address,
		verified: row.verifiedAt !== null,
		stopped: row.stoppedAt !== null,
		onlineOrders: row.onlineOrders,
		scheduledOrders: row.scheduledOrders,
	}
}

export async function listLocationRecipients(
	organizationId: string,
	locationId: string,
): Promise<RecipientRow[]> {
	return db
		.select()
		.from(OrderAlertRecipient)
		.where(
			and(
				eq(OrderAlertRecipient.organizationId, organizationId),
				eq(OrderAlertRecipient.locationId, locationId),
			),
		)
		.orderBy(OrderAlertRecipient.createdAt)
}

const emailSchema = z.string().trim().toLowerCase().email().max(254)

/** An address as typed: an email, or a number read in the organization's region. */
export function parseRecipientAddress(
	raw: string,
	dataRegion: string | null | undefined,
):
	| { ok: true; kind: 'email' | 'phone'; address: string }
	| { ok: false; error: 'invalid_address' | 'sms_unavailable' } {
	const typed = raw.trim()
	if (typed.includes('@')) {
		const email = emailSchema.safeParse(typed)
		return email.success
			? { ok: true, kind: 'email', address: email.data }
			: { ok: false, error: 'invalid_address' }
	}
	if (!alertTextsAvailable(dataRegion)) {
		return { ok: false, error: 'sms_unavailable' }
	}
	const phone = normalizePhone(typed, { region: 'us' })
	return isValidE164Phone(phone)
		? { ok: true, kind: 'phone', address: phone }
		: { ok: false, error: 'invalid_address' }
}

/**
 * `ORDER_ALERT_HASH_SECRET`: keys the code hash and the phone hash. Its own
 * secret (never `INTERNAL_COMMAND_TOKEN`, which every node and the cron worker
 * hold and whose rotation must not break STOP matching).
 */
function secret(): string {
	const nodeEnv = process.env.NODE_ENV
	const value = resolveOrderAlertHashSecret({
		secret: ENV.ORDER_ALERT_HASH_SECRET,
		internalCommandToken: ENV.INTERNAL_COMMAND_TOKEN,
		placeholderAllowed: nodeEnv === 'development' || nodeEnv === 'test',
	})
	if (!value) {
		throw new Error(
			'ORDER_ALERT_HASH_SECRET must be configured (32+ chars, different from INTERNAL_COMMAND_TOKEN, not the development default)',
		)
	}
	return value
}

async function hashCode(code: string, recipientId: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret()),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(`alert-verify:v1:${recipientId}:${code}`),
	)
	return [...new Uint8Array(signature)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

/** A throttle key for a destination that survives deleting its recipient row. */
async function destinationKey(row: RecipientRow): Promise<string> {
	if (row.phoneHash) return row.phoneHash
	return hashCode(`${row.kind}:${row.address.toLowerCase()}`, 'destination')
}

/** Per destination, across every organization and location. */
const DESTINATION_CODES_PER_HOUR = 3
const DESTINATION_CODES_PER_DAY = 10
/** Per organization: code texts and emails cost money and reach strangers. */
const ORGANIZATION_CODES_PER_DAY = 30

async function codeSendAllowed(
	organizationId: string,
	row: RecipientRow,
): Promise<boolean> {
	const destination = await destinationKey(row)
	const hour = await checkRateLimit(
		{ type: 'token', value: destination },
		{
			scope: 'order-alert-code-destination-hour',
			maxRequests: DESTINATION_CODES_PER_HOUR,
			windowMs: 60 * 60 * 1000,
		},
	)
	if (!hour.allowed) return false
	const day = await checkRateLimit(
		{ type: 'token', value: destination },
		{
			scope: 'order-alert-code-destination-day',
			maxRequests: DESTINATION_CODES_PER_DAY,
			windowMs: 24 * 60 * 60 * 1000,
		},
	)
	if (!day.allowed) return false
	const org = await checkRateLimit(
		{ type: 'org', value: organizationId },
		{
			scope: 'order-alert-code-org-day',
			maxRequests: ORGANIZATION_CODES_PER_DAY,
			windowMs: 24 * 60 * 60 * 1000,
		},
	)
	return org.allowed
}

function sameString(a: string, b: string): boolean {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
	return diff === 0
}

function newCode(): string {
	const bytes = crypto.getRandomValues(new Uint32Array(1))
	return String(bytes[0]! % 10 ** ALERT_VERIFY_CODE_LENGTH).padStart(
		ALERT_VERIFY_CODE_LENGTH,
		'0',
	)
}

export type AddRecipientResult =
	| { ok: true; recipient: RecipientRow }
	| {
			ok: false
			error:
				| 'invalid_address'
				| 'sms_unavailable'
				| 'limit_reached'
				| 'already_added'
	  }

/** Adds an unverified recipient; the caller then sends the code. */
export async function addLocationRecipient(input: {
	organizationId: string
	locationId: string
	rawAddress: string
	dataRegion: string | null | undefined
	createdBy: string | null
}): Promise<AddRecipientResult> {
	const parsed = parseRecipientAddress(input.rawAddress, input.dataRegion)
	if (!parsed.ok) return parsed
	const [existing] = await db
		.select({ value: count() })
		.from(OrderAlertRecipient)
		.where(
			and(
				eq(OrderAlertRecipient.organizationId, input.organizationId),
				eq(OrderAlertRecipient.locationId, input.locationId),
			),
		)
	if ((existing?.value ?? 0) >= MAX_ALERT_RECIPIENTS_PER_LOCATION) {
		return { ok: false, error: 'limit_reached' }
	}
	const [created] = await db
		.insert(OrderAlertRecipient)
		.values({
			organizationId: input.organizationId,
			locationId: input.locationId,
			kind: parsed.kind,
			address: parsed.address,
			phoneHash:
				parsed.kind === 'phone'
					? await alertPhoneHash(parsed.address, secret())
					: null,
			createdBy: input.createdBy,
		})
		.onConflictDoNothing()
		.returning()
	if (!created) return { ok: false, error: 'already_added' }
	return { ok: true, recipient: created }
}

export type SendCodeResult =
	| { ok: true }
	| {
			ok: false
			error: 'rate_limited' | 'unavailable' | 'failed' | 'not_found'
	  }

/**
 * Sends a fresh one-time code (10 minutes, five tries, three sends an hour).
 * An email recipient gets it by email; a phone recipient by text.
 */
export async function sendRecipientCode(input: {
	organizationId: string
	recipientId: string
	organizationName: string
	dataRegion: string | null | undefined
	settingsUrl: string
	now?: number
}): Promise<SendCodeResult> {
	const now = input.now ?? Date.now()
	const [row] = await db
		.select()
		.from(OrderAlertRecipient)
		.where(
			and(
				eq(OrderAlertRecipient.id, input.recipientId),
				eq(OrderAlertRecipient.organizationId, input.organizationId),
			),
		)
		.limit(1)
	if (!row) return { ok: false, error: 'not_found' }
	const hourAgo = now - 60 * 60 * 1000
	const sentThisHour =
		row.verifySentAt && row.verifySentAt.getTime() > hourAgo
			? row.verifySentCount
			: 0
	if (sentThisHour >= ALERT_VERIFY_SENDS_PER_HOUR) {
		return { ok: false, error: 'rate_limited' }
	}
	if (!(await codeSendAllowed(input.organizationId, row))) {
		return { ok: false, error: 'rate_limited' }
	}
	const code = newCode()
	await db
		.update(OrderAlertRecipient)
		.set({
			verifyCodeHash: await hashCode(code, row.id),
			verifyExpiresAt: new Date(now + ALERT_VERIFY_TTL_MS),
			verifyAttempts: 0,
			verifySentAt: new Date(now),
			verifySentCount: sentThisHour + 1,
		})
		.where(eq(OrderAlertRecipient.id, row.id))

	if (row.kind === 'phone') {
		if (!alertTextsAvailable(input.dataRegion)) {
			return { ok: false, error: 'unavailable' }
		}
		const result = await getAlertTextProvider().send({
			orgId: input.organizationId,
			to: row.address,
			text: `Your ${input.organizationName} order alert code is ${code}. Reply STOP to opt out.`,
		})
		return result.ok ? { ok: true } : { ok: false, error: 'failed' }
	}
	try {
		const result = await sendEmail({
			to: row.address,
			subject: `Your order alert code is ${code}`,
			react: StaffingAlertEmail({
				eyebrow: 'Order alerts',
				headline: `Your code is ${code}`,
				detail: `${input.organizationName} would like to send you an alert when an online order arrives. Enter this code in the location's order alert settings to confirm. It works for 10 minutes. If you did not expect this, ignore it and nothing is sent.`,
				actionLabel: 'Open order alert settings',
				actionUrl: input.settingsUrl,
				settingsNote: alertSettingsNote('en'),
			}),
		})
		return result.status === 'error'
			? { ok: false, error: 'failed' }
			: { ok: true }
	} catch {
		return { ok: false, error: 'failed' }
	}
}

export type ConfirmResult =
	| { ok: true }
	| {
			ok: false
			error: 'not_found' | 'expired' | 'wrong_code' | 'too_many_tries'
	  }

export async function confirmRecipientCode(input: {
	organizationId: string
	recipientId: string
	code: string
	now?: number
}): Promise<ConfirmResult> {
	const now = input.now ?? Date.now()
	const [row] = await db
		.select()
		.from(OrderAlertRecipient)
		.where(
			and(
				eq(OrderAlertRecipient.id, input.recipientId),
				eq(OrderAlertRecipient.organizationId, input.organizationId),
			),
		)
		.limit(1)
	if (!row) return { ok: false, error: 'not_found' }
	if (row.verifiedAt) return { ok: true }
	if (
		!row.verifyCodeHash ||
		!row.verifyExpiresAt ||
		row.verifyExpiresAt.getTime() < now
	) {
		return { ok: false, error: 'expired' }
	}
	// One atomic statement takes the try BEFORE the code is compared: parallel
	// guesses cannot all read the same count, and only a row that came back
	// means a guess is allowed.
	const taken = await db
		.update(OrderAlertRecipient)
		.set({ verifyAttempts: sql`${OrderAlertRecipient.verifyAttempts} + 1` })
		.where(
			and(
				eq(OrderAlertRecipient.id, row.id),
				isNull(OrderAlertRecipient.verifiedAt),
				lt(OrderAlertRecipient.verifyAttempts, ALERT_VERIFY_MAX_ATTEMPTS),
			),
		)
		.returning({ id: OrderAlertRecipient.id })
	if (taken.length === 0) return { ok: false, error: 'too_many_tries' }
	const submitted = input.code.replace(/\D/g, '')
	const matches = sameString(
		await hashCode(submitted, row.id),
		row.verifyCodeHash,
	)
	if (!matches) {
		return { ok: false, error: 'wrong_code' }
	}
	await db
		.update(OrderAlertRecipient)
		.set({
			verifiedAt: new Date(now),
			stoppedAt: null,
			verifyCodeHash: null,
			verifyExpiresAt: null,
			verifyAttempts: 0,
		})
		.where(eq(OrderAlertRecipient.id, row.id))
	return { ok: true }
}

export async function removeLocationRecipient(input: {
	organizationId: string
	recipientId: string
}): Promise<boolean> {
	const removed = await db
		.delete(OrderAlertRecipient)
		.where(
			and(
				eq(OrderAlertRecipient.id, input.recipientId),
				eq(OrderAlertRecipient.organizationId, input.organizationId),
			),
		)
		.returning({ id: OrderAlertRecipient.id })
	return removed.length > 0
}

export async function updateRecipientSwitches(input: {
	organizationId: string
	recipientId: string
	onlineOrders?: boolean
	scheduledOrders?: boolean
}): Promise<boolean> {
	const set: Partial<typeof OrderAlertRecipient.$inferInsert> = {}
	if (input.onlineOrders !== undefined) set.onlineOrders = input.onlineOrders
	if (input.scheduledOrders !== undefined) {
		set.scheduledOrders = input.scheduledOrders
	}
	if (Object.keys(set).length === 0) return true
	const updated = await db
		.update(OrderAlertRecipient)
		.set(set)
		.where(
			and(
				eq(OrderAlertRecipient.id, input.recipientId),
				eq(OrderAlertRecipient.organizationId, input.organizationId),
			),
		)
		.returning({ id: OrderAlertRecipient.id })
	return updated.length > 0
}

/** Which switch an alert is for. */
export type RecipientTopic = 'online' | 'scheduled'

/**
 * The recipients an alert goes to now: confirmed, not stopped, with the switch
 * for the topic on. Read from the database at send time, so a removed recipient
 * is gone from the very next alert.
 */
export async function resolveLocationRecipients(input: {
	organizationId: string
	locationId: string
	topic: RecipientTopic
	dataRegion: string | null | undefined
}): Promise<RecipientRow[]> {
	const rows = await db
		.select()
		.from(OrderAlertRecipient)
		.where(
			and(
				eq(OrderAlertRecipient.organizationId, input.organizationId),
				eq(OrderAlertRecipient.locationId, input.locationId),
				isNotNull(OrderAlertRecipient.verifiedAt),
				isNull(OrderAlertRecipient.stoppedAt),
			),
		)
	return rows.filter(
		(row) =>
			(input.topic === 'online' ? row.onlineOrders : row.scheduledOrders) &&
			(row.kind === 'email' || alertTextsAvailable(input.dataRegion)),
	)
}

/**
 * STOP and START replies, matched by the hash of the number (never the number).
 * STOP ends alerts to every recipient with that number; START brings back one
 * that was confirmed. Returns how many recipients changed.
 */
export async function applyAlertKeyword(
	event: Pick<AlertKeywordEvent, 'keyword' | 'phoneHash'>,
	now = new Date(),
): Promise<number> {
	const where = and(
		eq(OrderAlertRecipient.kind, 'phone'),
		eq(OrderAlertRecipient.phoneHash, event.phoneHash),
	)
	const rows =
		event.keyword === 'stop'
			? await db
					.update(OrderAlertRecipient)
					.set({ stoppedAt: now })
					.where(and(where, isNull(OrderAlertRecipient.stoppedAt)))
					.returning({ id: OrderAlertRecipient.id })
			: await db
					.update(OrderAlertRecipient)
					.set({ stoppedAt: null })
					.where(and(where, isNotNull(OrderAlertRecipient.stoppedAt)))
					.returning({ id: OrderAlertRecipient.id })
	return rows.length
}

export { alertSmsText }
