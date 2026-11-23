import { createHmac, timingSafeEqual } from 'node:crypto'
import {
	VERIFICATION_EXPIRY_MS,
	VERIFICATION_FRESH_MS,
	VERIFICATION_LOCK_MS,
	VERIFICATION_MAX_ATTEMPTS,
	generateVerificationCode,
	normalizeVerificationCode,
} from '@repo/common/support-verification'
import {
	and,
	count,
	db,
	desc,
	eq,
	gt,
	gte,
	isNotNull,
	isNull,
	lt,
	sql,
	SupportVerification,
	User,
} from '@repo/database'
import { ENV } from './package-env.js'

/**
 * Caller verification (#291). A support agent asks; the operator, signed in to
 * the App, opens Profile, Security and reads a 6-digit code out; the agent types
 * it. The code is made when the operator opens the card, only a keyed hash is
 * stored, and it is never shown to the agent. It expires 10 minutes after the
 * request, works once, and five wrong entries lock verification for that user
 * for an hour. Sensitive Admin actions need a verification by the same agent,
 * for the same user, from the last 15 minutes.
 */

function secret(): string {
	return ENV.SESSION_SECRET.split(',')[0]!.trim()
}

/** A keyed hash that also binds the code to its request id. */
export function hashVerificationCode(code: string, verificationId: string) {
	return createHmac('sha256', secret())
		.update(`support-verification:${verificationId}:${code}`)
		.digest('hex')
}

function sameHash(a: string, b: string): boolean {
	const left = Buffer.from(a, 'hex')
	const right = Buffer.from(b, 'hex')
	return left.length === right.length && timingSafeEqual(left, right)
}

/** Requests one agent may make for one user in an hour. */
export const MAX_REQUESTS_PER_HOUR = 10

/** When verification for this user stays locked until, or null. */
export async function getVerificationLock(
	userId: string,
	now = new Date(),
): Promise<Date | null> {
	const [row] = await db
		.select({ lockedUntil: SupportVerification.lockedUntil })
		.from(SupportVerification)
		.where(
			and(
				eq(SupportVerification.userId, userId),
				gt(SupportVerification.lockedUntil, now),
			),
		)
		.orderBy(desc(SupportVerification.lockedUntil))
		.limit(1)
	return row?.lockedUntil ?? null
}

export type RequestResult =
	| { status: 'requested'; id: string; expiresAt: Date }
	| { status: 'locked'; lockedUntil: Date }
	| { status: 'too_many' }

/** An agent asks to confirm a caller. An earlier open request by the agent for the user stops. */
export async function requestCallerVerification(input: {
	agentId: string
	userId: string
	now?: Date
}): Promise<RequestResult> {
	const now = input.now ?? new Date()
	const lockedUntil = await getVerificationLock(input.userId, now)
	if (lockedUntil) return { status: 'locked', lockedUntil }

	const [recent] = await db
		.select({ total: count() })
		.from(SupportVerification)
		.where(
			and(
				eq(SupportVerification.agentId, input.agentId),
				eq(SupportVerification.userId, input.userId),
				gte(
					SupportVerification.createdAt,
					new Date(now.getTime() - 60 * 60 * 1000),
				),
			),
		)
	if ((recent?.total ?? 0) >= MAX_REQUESTS_PER_HOUR)
		return { status: 'too_many' }

	await db
		.update(SupportVerification)
		.set({ expiresAt: now })
		.where(
			and(
				eq(SupportVerification.agentId, input.agentId),
				eq(SupportVerification.userId, input.userId),
				isNull(SupportVerification.verifiedAt),
				gt(SupportVerification.expiresAt, now),
			),
		)
	const expiresAt = new Date(now.getTime() + VERIFICATION_EXPIRY_MS)
	const [row] = await db
		.insert(SupportVerification)
		.values({
			userId: input.userId,
			agentId: input.agentId,
			expiresAt,
			createdAt: now,
		})
		.returning({ id: SupportVerification.id })
	return { status: 'requested', id: row!.id, expiresAt }
}

export type PendingVerification = {
	id: string
	expiresAt: Date
	agentFirstName: string
}

/**
 * The open request the operator can act on, for the App's Security card. It
 * names the agent by first name so the operator knows who asked; it never holds
 * the code.
 */
export async function getPendingVerificationForUser(
	userId: string,
	now = new Date(),
): Promise<PendingVerification | null> {
	if (await getVerificationLock(userId, now)) return null
	const [row] = await db
		.select({
			id: SupportVerification.id,
			expiresAt: SupportVerification.expiresAt,
			agentName: User.name,
			agentUsername: User.username,
		})
		.from(SupportVerification)
		.innerJoin(User, eq(User.id, SupportVerification.agentId))
		.where(
			and(
				eq(SupportVerification.userId, userId),
				isNull(SupportVerification.verifiedAt),
				gt(SupportVerification.expiresAt, now),
			),
		)
		.orderBy(desc(SupportVerification.createdAt))
		.limit(1)
	if (!row) return null
	return {
		id: row.id,
		expiresAt: row.expiresAt,
		agentFirstName:
			row.agentName?.trim().split(/\s+/)[0] || row.agentUsername || 'Menuza',
	}
}

export type RevealResult =
	| { status: 'ok'; code: string; expiresAt: Date }
	| { status: 'not_found' | 'expired' }
	| { status: 'locked'; lockedUntil: Date }

/**
 * Makes the code for a request and returns it, once, to the target user's own
 * session. Opening the card again makes a new code and the old one stops
 * working. Only the owner of the request can do this: a request for another
 * user is `not_found`.
 */
export async function revealVerificationCode(input: {
	userId: string
	verificationId: string
	now?: Date
}): Promise<RevealResult> {
	const now = input.now ?? new Date()
	const lockedUntil = await getVerificationLock(input.userId, now)
	if (lockedUntil) return { status: 'locked', lockedUntil }
	const [row] = await db
		.select({
			id: SupportVerification.id,
			expiresAt: SupportVerification.expiresAt,
			verifiedAt: SupportVerification.verifiedAt,
		})
		.from(SupportVerification)
		.where(
			and(
				eq(SupportVerification.id, input.verificationId),
				eq(SupportVerification.userId, input.userId),
			),
		)
		.limit(1)
	if (!row || row.verifiedAt) return { status: 'not_found' }
	if (row.expiresAt <= now) return { status: 'expired' }
	const code = generateVerificationCode()
	const updated = await db
		.update(SupportVerification)
		.set({ codeHash: hashVerificationCode(code, row.id) })
		.where(
			and(
				eq(SupportVerification.id, row.id),
				isNull(SupportVerification.verifiedAt),
				gt(SupportVerification.expiresAt, now),
			),
		)
		.returning({ id: SupportVerification.id })
	if (updated.length === 0) return { status: 'expired' }
	return { status: 'ok', code, expiresAt: row.expiresAt }
}

export type SubmitResult =
	| { status: 'verified'; verificationId: string; verifiedAt: Date }
	| { status: 'wrong'; attemptsLeft: number }
	| { status: 'locked'; lockedUntil: Date }
	| { status: 'expired' | 'no_request' | 'not_shown' | 'invalid_format' }

/** The agent types the code the operator read out. */
export async function submitCallerVerificationCode(input: {
	agentId: string
	userId: string
	code: unknown
	now?: Date
}): Promise<SubmitResult> {
	const now = input.now ?? new Date()
	const lockedUntil = await getVerificationLock(input.userId, now)
	if (lockedUntil) return { status: 'locked', lockedUntil }
	const code = normalizeVerificationCode(input.code)
	if (!code) return { status: 'invalid_format' }

	const [row] = await db
		.select({
			id: SupportVerification.id,
			codeHash: SupportVerification.codeHash,
			expiresAt: SupportVerification.expiresAt,
		})
		.from(SupportVerification)
		.where(
			and(
				eq(SupportVerification.agentId, input.agentId),
				eq(SupportVerification.userId, input.userId),
				isNull(SupportVerification.verifiedAt),
			),
		)
		.orderBy(desc(SupportVerification.createdAt))
		.limit(1)
	if (!row) return { status: 'no_request' }
	if (row.expiresAt <= now) return { status: 'expired' }
	if (!row.codeHash) return { status: 'not_shown' }

	// One conditional UPDATE takes the attempt before the code is compared, so
	// parallel guesses cannot beat the limit.
	const taken = await db
		.update(SupportVerification)
		.set({ attempts: sqlIncrement() })
		.where(
			and(
				eq(SupportVerification.id, row.id),
				isNull(SupportVerification.verifiedAt),
				lt(SupportVerification.attempts, VERIFICATION_MAX_ATTEMPTS),
			),
		)
		.returning({ attempts: SupportVerification.attempts })
	const attempts = taken[0]?.attempts
	if (attempts === undefined) {
		const until = new Date(now.getTime() + VERIFICATION_LOCK_MS)
		await db
			.update(SupportVerification)
			.set({ lockedUntil: until })
			.where(eq(SupportVerification.id, row.id))
		return { status: 'locked', lockedUntil: until }
	}

	if (!sameHash(hashVerificationCode(code, row.id), row.codeHash)) {
		if (attempts >= VERIFICATION_MAX_ATTEMPTS) {
			const until = new Date(now.getTime() + VERIFICATION_LOCK_MS)
			await db
				.update(SupportVerification)
				.set({ lockedUntil: until })
				.where(eq(SupportVerification.id, row.id))
			return { status: 'locked', lockedUntil: until }
		}
		return {
			status: 'wrong',
			attemptsLeft: VERIFICATION_MAX_ATTEMPTS - attempts,
		}
	}

	// Works once: only the request still unverified can be marked.
	const marked = await db
		.update(SupportVerification)
		.set({ verifiedAt: now })
		.where(
			and(
				eq(SupportVerification.id, row.id),
				isNull(SupportVerification.verifiedAt),
			),
		)
		.returning({ id: SupportVerification.id })
	if (marked.length === 0) return { status: 'no_request' }
	return { status: 'verified', verificationId: row.id, verifiedAt: now }
}

/** A verification by this agent for this user from the last 15 minutes, or null. */
export async function findFreshVerification(input: {
	agentId: string
	userId: string
	now?: Date
}): Promise<{ id: string; verifiedAt: Date } | null> {
	const now = input.now ?? new Date()
	const [row] = await db
		.select({
			id: SupportVerification.id,
			verifiedAt: SupportVerification.verifiedAt,
		})
		.from(SupportVerification)
		.where(
			and(
				eq(SupportVerification.agentId, input.agentId),
				eq(SupportVerification.userId, input.userId),
				isNotNull(SupportVerification.verifiedAt),
				gte(
					SupportVerification.verifiedAt,
					new Date(now.getTime() - VERIFICATION_FRESH_MS),
				),
			),
		)
		.orderBy(desc(SupportVerification.verifiedAt))
		.limit(1)
	return row?.verifiedAt ? { id: row.id, verifiedAt: row.verifiedAt } : null
}

/**
 * The gate of the sensitive Admin actions. Throws a 403 response when the agent
 * has no fresh verification of the user the action affects. Call it first in
 * the action, before anything is read from the form or changed.
 */
export async function requireFreshCallerVerification(input: {
	agentId: string
	userId: string
	now?: Date
}) {
	const fresh = await findFreshVerification(input)
	if (!fresh) {
		throw Response.json(
			{
				error: 'verification_required',
				message:
					'Confirm the caller first: this action needs a verification from the last 15 minutes.',
			},
			{ status: 403 },
		)
	}
	return fresh
}

function sqlIncrement() {
	return sql`${SupportVerification.attempts} + 1`
}

export type CallerVerificationState =
	| { status: 'none' }
	| { status: 'pending'; expiresAt: Date; codeShown: boolean }
	| { status: 'verified'; verifiedAt: Date; validUntil: Date }
	| { status: 'locked'; lockedUntil: Date }

/** What Admin shows next to Verify caller: nothing, waiting for the code, verified, or locked. */
export async function getCallerVerificationState(input: {
	agentId: string
	userId: string
	now?: Date
}): Promise<CallerVerificationState> {
	const now = input.now ?? new Date()
	const lockedUntil = await getVerificationLock(input.userId, now)
	if (lockedUntil) return { status: 'locked', lockedUntil }
	const fresh = await findFreshVerification({ ...input, now })
	if (fresh) {
		return {
			status: 'verified',
			verifiedAt: fresh.verifiedAt,
			validUntil: new Date(fresh.verifiedAt.getTime() + VERIFICATION_FRESH_MS),
		}
	}
	const [pending] = await db
		.select({
			expiresAt: SupportVerification.expiresAt,
			codeHash: SupportVerification.codeHash,
		})
		.from(SupportVerification)
		.where(
			and(
				eq(SupportVerification.agentId, input.agentId),
				eq(SupportVerification.userId, input.userId),
				isNull(SupportVerification.verifiedAt),
				gt(SupportVerification.expiresAt, now),
			),
		)
		.orderBy(desc(SupportVerification.createdAt))
		.limit(1)
	return pending
		? {
				status: 'pending',
				expiresAt: pending.expiresAt,
				codeShown: pending.codeHash !== null,
			}
		: { status: 'none' }
}
