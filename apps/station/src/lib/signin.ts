import { t } from '@lingui/macro'
import { z } from 'zod'
import { monotonicNow, noteServerDate } from './clock.ts'
import {
	db,
	getMeta,
	setMeta,
	type CachedStaff,
	type SignInMode,
	type StaffRef,
	type StaffRole,
} from './db.ts'
import {
	EMPTY_GUARD,
	afterFailure,
	afterSuccess,
	waitSeconds,
	type PinGuard,
} from './pin-guard.ts'
import { PIN_PATTERN, SALT_KEY, derivePinKey, newSalt } from './pin.ts'

/**
 * Remembered people stop working offline after this long without an online
 * sign-in. Short, because someone who left can sign in offline until then (the
 * server flags their sales as `inactive_staff`, but cannot stop them).
 */
export const CACHE_MAX_AGE_MS = 72 * 60 * 60 * 1000

export const DEMO_PIN = '1234'
export const DEMO_STAFF: StaffRef & { role: StaffRole } = {
	id: 'demo-staff',
	name: 'Demo Cashier',
	role: 'manager',
}

export type Session = {
	staff: StaffRef
	role: StaffRole
	mode: SignInMode
	at: number
}

export type SignInOutcome =
	| { ok: true; session: Session }
	| {
			ok: false
			reason:
				| 'wrong_pin'
				| 'wait'
				| 'needs_connection'
				| 'terminal_removed'
				| 'sign_in_off'
				| 'bad_pin'
				/** This device could not check the PIN (its storage failed). */
				| 'unavailable'
			message: string
			retryAfterSeconds?: number
	  }

const GUARD_KEY = 'pin-guard'

async function deviceSalt(): Promise<string> {
	const existing = await getMeta<string>(SALT_KEY)
	if (existing) return existing
	const salt = newSalt()
	await setMeta(SALT_KEY, salt)
	return salt
}

/** Drops everyone remembered for offline sign-in, and the offline attempt counter. Used when the till moves to another restaurant or workplace. */
export async function forgetCachedStaff(): Promise<void> {
	await db.transaction('rw', db.staff, db.meta, async () => {
		await db.staff.clear()
		await db.meta.delete(GUARD_KEY)
	})
}

/** Remembers a person who just signed in online, so they can sign in offline later. */
export async function rememberStaff(
	pin: string,
	staff: StaffRef,
	role: StaffRole,
	now = Date.now(),
): Promise<void> {
	const key = await derivePinKey(pin, await deviceSalt())
	await db.transaction('rw', db.staff, async () => {
		// A PIN names one person: anyone else holding this key is out of date.
		await db.staff
			.where('key')
			.equals(key)
			.filter((s) => s.id !== staff.id)
			.delete()
		await db.staff.put({
			id: staff.id,
			name: staff.name,
			role,
			key,
			cachedAt: now,
		})
	})
}

async function forgetKey(key: string) {
	await db.staff.where('key').equals(key).delete()
}

async function loadGuard(): Promise<PinGuard> {
	return (await getMeta<PinGuard>(GUARD_KEY)) ?? EMPTY_GUARD
}

/**
 * The same wait on a clock that only moves forward. The stored deadline
 * survives a reload but follows the tablet's time, so moving the clock ahead
 * would end it; this one does not, for as long as the page stays open.
 */
let monotonicBlockedUntil: number | null = null

/** Seconds still to wait by either clock. */
function remainingWait(guard: PinGuard, now: number): number {
	const mono =
		monotonicBlockedUntil === null
			? 0
			: Math.max(0, Math.ceil((monotonicBlockedUntil - monotonicNow()) / 1000))
	return Math.max(waitSeconds(guard, now), mono)
}

/** For tests: forget the in-memory wait, as a reload would. */
export function resetMonotonicWait(): void {
	monotonicBlockedUntil = null
}

async function offlineSignIn(pin: string, now: number): Promise<SignInOutcome> {
	const guard = await loadGuard()
	const wait = remainingWait(guard, now)
	if (wait > 0) {
		return {
			ok: false,
			reason: 'wait',
			retryAfterSeconds: wait,
			message: t`Too many wrong PINs. Try again in ${wait} seconds.`,
		}
	}
	if ((await db.staff.count()) === 0) {
		return {
			ok: false,
			reason: 'needs_connection',
			message: t`Connect to the internet to sign in. The first sign-in on this device needs a connection.`,
		}
	}
	const key = await derivePinKey(pin, await deviceSalt())
	const match: CachedStaff | undefined = await db.staff
		.where('key')
		.equals(key)
		.first()
	if (match && now - match.cachedAt <= CACHE_MAX_AGE_MS) {
		await setMeta(GUARD_KEY, afterSuccess(guard, now))
		return {
			ok: true,
			session: {
				staff: { id: match.id, name: match.name },
				role: match.role,
				mode: 'offline',
				at: now,
			},
		}
	}
	if (match) {
		return {
			ok: false,
			reason: 'needs_connection',
			message: t`It has been a while. Connect to the internet to sign in again.`,
		}
	}
	const { guard: next, delaySeconds } = afterFailure(guard, now)
	if (delaySeconds > 0)
		monotonicBlockedUntil = monotonicNow() + delaySeconds * 1000
	await setMeta(GUARD_KEY, next)
	return {
		ok: false,
		reason: 'wrong_pin',
		retryAfterSeconds: delaySeconds || undefined,
		message:
			delaySeconds > 0
				? t`That PIN is not right. Try again in ${delaySeconds} seconds.`
				: t`That PIN is not right.`,
	}
}

export type SignInDeps = {
	tenantApiUrl: string
	deviceToken: string | null
	demo: boolean
	online: boolean
}

/**
 * Signs a person in. The server decides whenever it can be asked (it knows who is
 * still on the roster and whose PIN changed); only when it cannot be reached does
 * the till fall back to the people it remembers.
 */
export async function attemptSignIn(
	pin: string,
	deps: SignInDeps,
	now = Date.now(),
): Promise<SignInOutcome> {
	try {
		return await signIn(pin, deps, now)
	} catch {
		// IndexedDB refused (storage full, private mode, a browser bug). Never
		// leave the lock screen waiting on a promise that will not settle well.
		return {
			ok: false,
			reason: 'unavailable',
			message: t`This device could not check the PIN. Try again, or reload the app.`,
		}
	}
}

/** Who answered a sign-in: the person and their role. Anything else is not trusted. */
const signInResponseSchema = z.object({
	staff: z.object({
		id: z.string().min(1).max(200),
		name: z.string().max(200),
	}),
	role: z.enum(['cashier', 'manager']),
})

async function signIn(
	pin: string,
	deps: SignInDeps,
	now: number,
): Promise<SignInOutcome> {
	if (!PIN_PATTERN.test(pin))
		return {
			ok: false,
			reason: 'bad_pin',
			message: t`Enter your 4 to 6 digit PIN.`,
		}

	if (deps.demo) {
		return pin === DEMO_PIN
			? {
					ok: true,
					session: {
						staff: { id: DEMO_STAFF.id, name: DEMO_STAFF.name },
						role: DEMO_STAFF.role,
						mode: 'offline',
						at: now,
					},
				}
			: {
					ok: false,
					reason: 'wrong_pin',
					message: t`That PIN is not right. In demo mode it is 1234.`,
				}
	}

	if (!deps.online || !deps.deviceToken || !deps.tenantApiUrl)
		return offlineSignIn(pin, now)

	let response: Response
	const sentAt = Date.now()
	try {
		response = await fetch(
			`${deps.tenantApiUrl.replace(/\/+$/, '')}/pos/sign-in`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${deps.deviceToken}`,
				},
				body: JSON.stringify({ pin }),
				signal: AbortSignal.timeout(8_000),
			},
		)
	} catch {
		return offlineSignIn(pin, now)
	}
	noteServerDate(response, sentAt)

	if (response.ok) {
		const parsed = signInResponseSchema.safeParse(
			await response.json().catch(() => null),
		)
		// A 200 that is not the server's answer (a captive portal's page, a proxy)
		// decides nothing: fall back to the people this device remembers.
		if (!parsed.success) return offlineSignIn(pin, now)
		const staff: StaffRef = parsed.data.staff
		const role: StaffRole = parsed.data.role
		// The server said yes. Remembering them for offline use is a bonus: a
		// storage failure here must not turn a good sign-in into a stuck till.
		try {
			await rememberStaff(pin, staff, role, now)
			await setMeta(GUARD_KEY, EMPTY_GUARD)
		} catch {
			/* signed in; not remembered for offline use this time */
		}
		monotonicBlockedUntil = null
		return {
			ok: true,
			session: { staff, role, mode: 'online', at: now },
		}
	}

	const parsed = (await response.json().catch(() => ({}))) as {
		error?: string
		retryAfterSeconds?: number
	}
	if (response.status === 401 && parsed.error === 'device_revoked') {
		return {
			ok: false,
			reason: 'terminal_removed',
			message: t`This terminal was removed. Ask a manager to pair it again.`,
		}
	}
	if (response.status === 409 && parsed.error === 'sign_in_not_required') {
		return {
			ok: false,
			reason: 'sign_in_off',
			message: t`Sign-in has been switched off for this terminal.`,
		}
	}
	if (response.status === 429 && parsed.error === 'backoff') {
		const wait = parsed.retryAfterSeconds ?? 30
		return {
			ok: false,
			reason: 'wait',
			retryAfterSeconds: wait,
			message: t`Too many wrong PINs. Try again in ${wait} seconds.`,
		}
	}
	if (response.status === 401 && parsed.error === 'invalid_pin') {
		// The server is authoritative: if we remembered this PIN, it is out of date.
		await forgetKey(await derivePinKey(pin, await deviceSalt()))
		const wait = parsed.retryAfterSeconds ?? 0
		return {
			ok: false,
			reason: 'wrong_pin',
			retryAfterSeconds: wait || undefined,
			message:
				wait > 0
					? t`That PIN is not right. Try again in ${wait} seconds.`
					: t`That PIN is not right.`,
		}
	}
	// Unrecognised secret, outage, anything unexpected: the server could not decide.
	return offlineSignIn(pin, now)
}

export type ApprovalOutcome =
	| { ok: true; manager: StaffRef }
	| { ok: false; message: string; retryAfterSeconds?: number }

/**
 * Checks a manager's PIN to approve something (an item taken off a tab, a
 * cancellation, a refund) without changing who is signed in. Same rules as
 * signing in: the server decides when it can be asked, the remembered roster
 * otherwise, and the same wrong-PIN slowdown applies.
 */
export async function approveAsManager(
	pin: string,
	deps: SignInDeps,
	now = Date.now(),
): Promise<ApprovalOutcome> {
	const outcome = await attemptSignIn(pin, deps, now)
	if (!outcome.ok)
		return {
			ok: false,
			message: outcome.message,
			retryAfterSeconds: outcome.retryAfterSeconds,
		}
	if (outcome.session.role !== 'manager') {
		return {
			ok: false,
			message: t`${outcome.session.staff.name} is not a manager. Ask a manager to enter their PIN.`,
		}
	}
	return { ok: true, manager: outcome.session.staff }
}
