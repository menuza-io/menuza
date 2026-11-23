import { AuditAction } from '@repo/audit'
import {
	listSignInDeliveries,
	recordNumberCheck,
	type DeliveryRow,
} from '@repo/auth'
import { isValidE164Phone, normalizePhone } from '@repo/common/phone'
import {
	type NumberCheck,
	classifyLineType,
	describeFailureReason,
	numberProblem,
	NUMBER_PROBLEM_TEXT,
	type NumberProblem,
	type SignInChannel,
} from '@repo/common/sign-in-delivery'
import { RefreshToken, Session, User, and, db, eq } from '@repo/database'
import { postToApp } from './app-service.server.ts'
import { auditSupportAction } from './support.server.ts'

/**
 * Sign-in help (#246): look an operator up by email or phone and see whether
 * their last sign-in code was sent and delivered. Support never sees a code:
 * the log has no place for one. Every lookup and action is audited with the
 * support member's name, and a lookup records the masked destination, not the
 * address or number.
 */

export type DeliveryView = {
	id: string
	at: Date
	channel: SignInChannel
	purpose: string
	destinationHint: string
	provider: string
	status: string
	statusAt: Date
	failureReason: string | null
	lineType: string | null
	carrier: string | null
	numberValid: boolean | null
	problem: NumberProblem
	problemText: string | null
}

function toView(row: DeliveryRow): DeliveryView {
	const check =
		row.channel === 'sms' && row.numberValid !== null
			? {
					valid: row.numberValid,
					lineType: classifyLineType(row.lineType),
				}
			: null
	const problem = numberProblem(check)
	return {
		id: row.id,
		at: row.createdAt,
		channel: row.channel as SignInChannel,
		purpose: row.purpose,
		destinationHint: row.destinationHint,
		provider: row.provider,
		status: row.status,
		statusAt: row.statusAt,
		failureReason: describeFailureReason(
			row.channel as SignInChannel,
			row.failureReason,
		),
		lineType: row.lineType,
		carrier: row.carrier,
		numberValid: row.numberValid,
		problem,
		problemText: problem ? NUMBER_PROBLEM_TEXT[problem] : null,
	}
}

/** `+1 415 555 0100`, `4155550100` and `(415) 555-0100` all mean the same number. */
export function parseLookupQuery(
	raw: string,
):
	| { kind: 'email'; email: string }
	| { kind: 'phone'; phone: string }
	| { kind: 'invalid' } {
	const query = raw.trim()
	if (query.includes('@')) {
		return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query)
			? { kind: 'email', email: query.toLowerCase() }
			: { kind: 'invalid' }
	}
	const phone = normalizePhone(query, { region: 'us' })
	return isValidE164Phone(phone)
		? { kind: 'phone', phone }
		: { kind: 'invalid' }
}

export type LookupResult =
	| { status: 'invalid' }
	| {
			status: 'ok'
			kind: 'email' | 'phone'
			operator: {
				id: string
				name: string | null
				email: string
				activeSessions: number
			} | null
			deliveries: DeliveryView[]
			lastSent: DeliveryView | null
			/** The phone searched for, when it was a phone (for the line check). */
			phone: string | null
	  }

export async function lookupSignInHelp(input: {
	agentId: string
	query: string
	request?: Request
	now?: Date
}): Promise<LookupResult> {
	const now = input.now ?? new Date()
	const parsed = parseLookupQuery(input.query)
	if (parsed.kind === 'invalid') return { status: 'invalid' }

	let operator: {
		id: string
		name: string | null
		email: string
	} | null = null
	let rows: DeliveryRow[] = []
	if (parsed.kind === 'email') {
		const [user] = await db
			.select({ id: User.id, name: User.name, email: User.email })
			.from(User)
			.where(eq(User.email, parsed.email))
			.limit(1)
		operator = user ?? null
		const byAddress = await listSignInDeliveries({
			destination: { channel: 'email', value: parsed.email },
			now,
		})
		const byUser = user
			? await listSignInDeliveries({ userId: user.id, now })
			: []
		const seen = new Set<string>()
		rows = [...byAddress, ...byUser]
			.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)))
			.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
	} else {
		rows = await listSignInDeliveries({
			destination: { channel: 'sms', value: parsed.phone },
			now,
		})
		const userId = rows.find((row) => row.userId)?.userId
		if (userId) {
			const [user] = await db
				.select({ id: User.id, name: User.name, email: User.email })
				.from(User)
				.where(eq(User.id, userId))
				.limit(1)
			operator = user ?? null
		}
	}

	const sessions = operator
		? await db
				.select({ id: Session.id, expirationDate: Session.expirationDate })
				.from(Session)
				.where(eq(Session.userId, operator.id))
		: []
	const deliveries = rows.map(toView)

	await auditSupportAction({
		action: AuditAction.SIGN_IN_HELP_LOOKUP,
		agentId: input.agentId,
		targetUserId: operator?.id,
		details: 'Looked up sign-in code delivery',
		metadata: {
			by: parsed.kind,
			found: Boolean(operator),
			attempts: deliveries.length,
		},
		request: input.request,
	})

	return {
		status: 'ok',
		kind: parsed.kind,
		operator: operator
			? {
					...operator,
					activeSessions: sessions.filter(
						(session) => session.expirationDate > now,
					).length,
				}
			: null,
		deliveries,
		lastSent: deliveries[0] ?? null,
		phone: parsed.kind === 'phone' ? parsed.phone : null,
	}
}

export type PhoneCheckOutcome =
	| {
			status: 'ok'
			check: NumberCheck
			problem: NumberProblem
			problemText: string | null
	  }
	| { status: 'unavailable' | 'invalid' }

/** Asks the text provider (through the App) what a number is, and remembers the answer. */
export async function checkPhone(input: {
	agentId: string
	phone: string
	request?: Request
}): Promise<PhoneCheckOutcome> {
	const phone = normalizePhone(input.phone, { region: 'us' })
	if (!isValidE164Phone(phone)) return { status: 'invalid' }
	const result = await postToApp(
		'/resources/support/sign-in-help',
		{ intent: 'check_phone', phone },
		{ timeoutMs: 20_000 },
	)
	let check: NumberCheck | null = null
	if (result.status === 'answered' && result.response.ok) {
		const body = (await result.response.json().catch(() => null)) as {
			status?: string
			check?: { valid?: unknown; lineType?: unknown; carrier?: unknown }
		} | null
		if (body?.status === 'ok' && body.check) {
			check = {
				valid: body.check.valid === true,
				lineType: classifyLineType(body.check.lineType),
				carrier:
					typeof body.check.carrier === 'string' ? body.check.carrier : null,
			}
		}
	}
	await auditSupportAction({
		action: AuditAction.SIGN_IN_HELP_PHONE_CHECK,
		agentId: input.agentId,
		details: 'Checked a phone number',
		metadata: {
			result: check ? 'checked' : 'unavailable',
			...(check && {
				valid: check.valid,
				lineType: check.lineType,
			}),
		},
		request: input.request,
	})
	if (!check) return { status: 'unavailable' }
	// The App already remembers it; remember it here too so the page reads it back.
	await recordNumberCheck({ phone, check })
	const problem = numberProblem(check)
	return {
		status: 'ok',
		check,
		problem,
		problemText: problem ? NUMBER_PROBLEM_TEXT[problem] : null,
	}
}

export type ResendOutcome =
	| {
			status:
				'sent' | 'failed' | 'no_phone_on_file' | 'unavailable' | 'rate_limited'
	  }
	| { status: 'app_unreachable' }

/**
 * Sends a fresh code by the chosen channel through the App's own senders. The
 * answer says whether it was sent; the code is in the operator's inbox or phone
 * only.
 */
export async function resendSignInCode(input: {
	agentId: string
	userId: string
	channel: SignInChannel
	request?: Request
}): Promise<ResendOutcome> {
	const result = await postToApp(
		'/resources/support/sign-in-help',
		{ intent: 'resend', userId: input.userId, channel: input.channel },
		{ timeoutMs: 20_000 },
	)
	let outcome: ResendOutcome = { status: 'app_unreachable' }
	if (result.status === 'answered') {
		const body = (await result.response.json().catch(() => null)) as {
			status?: string
		} | null
		const status = body?.status
		outcome =
			status === 'sent' ||
			status === 'failed' ||
			status === 'no_phone_on_file' ||
			status === 'unavailable' ||
			status === 'rate_limited'
				? { status }
				: { status: 'failed' }
	}
	await auditSupportAction({
		action: AuditAction.SIGN_IN_HELP_RESEND,
		agentId: input.agentId,
		targetUserId: input.userId,
		details: `Resent a sign-in code by ${input.channel}`,
		metadata: { channel: input.channel, outcome: outcome.status },
		request: input.request,
	})
	return outcome
}

/** Ends every session of the operator, on the web and on the phone app. */
export async function endAllSessions(input: {
	agentId: string
	userId: string
	request?: Request
}): Promise<{ ended: number }> {
	const removed = await db
		.delete(Session)
		.where(eq(Session.userId, input.userId))
		.returning({ id: Session.id })
	await db
		.update(RefreshToken)
		.set({ revoked: true })
		.where(
			and(
				eq(RefreshToken.userId, input.userId),
				eq(RefreshToken.revoked, false),
			),
		)
	await auditSupportAction({
		action: AuditAction.SIGN_IN_HELP_SESSIONS_ENDED,
		agentId: input.agentId,
		targetUserId: input.userId,
		details: 'Ended all sessions of an operator',
		metadata: { ended: removed.length },
		request: input.request,
		severity: 'warning',
	})
	return { ended: removed.length }
}
