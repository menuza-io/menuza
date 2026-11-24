/**
 * Idle tracking for the lock. A module variable, not state: touching the screen
 * happens constantly and must not re-render anything.
 */
let lastActivity = Date.now()

export const touch = (now = Date.now()): void => {
	lastActivity = now
}

export const idleMs = (now = Date.now()): number => now - lastActivity

/**
 * Work in progress that a short idle lock would throw away (a booking taken on
 * the phone while the guest talks). While any is held, the lock waits at least
 * `HELD_LOCK_SECONDS`: longer, never forever.
 */
let holds = 0
export const HELD_LOCK_SECONDS = 5 * 60

/** Holds the lock back while work is in progress; call the returned function when done. */
export function holdLock(): () => void {
	holds += 1
	let released = false
	return () => {
		if (released) return
		released = true
		holds -= 1
	}
}

export const lockHeld = (): boolean => holds > 0

/**
 * A payment in progress (the checkout sheet is open, a card reader waits for
 * its approval): the till is never signed out underneath it (#364), however
 * long it takes. Unlike `holdLock` there is no floor to wait out: while
 * anything is blocked nothing locks, and the idle time counts again from the
 * moment the last block is released.
 */
let blocks = 0

/** Blocks locking while a payment is open; call the returned function when it is done. */
export function blockLock(): () => void {
	blocks += 1
	// Opening a payment is a touch: the idle clock restarts when it closes.
	touch()
	let released = false
	return () => {
		if (released) return
		released = true
		blocks -= 1
		touch()
	}
}

export const lockBlocked = (): boolean => blocks > 0

/** The last seconds before a sign-out, during which the person is warned. */
export const SIGN_OUT_WARNING_SECONDS = 10

/**
 * How long a signed-in till waits before it signs the person out: the
 * location's setting while it is on (minutes, #364), else the till's own lock
 * timeout. 0 is never.
 */
export function idleLockSecondsFor(input: {
	terminalSeconds: number
	locationMinutes: number | null | undefined
}): number {
	const minutes = input.locationMinutes
	return minutes && minutes > 0 ? minutes * 60 : input.terminalSeconds
}

type LockInput = {
	signInRequired: boolean
	signedIn: boolean
	idleLockSeconds: number
	idleMs: number
	/** Work in progress on screen: the lock waits longer. */
	held?: boolean
	/** A payment is open: never lock. */
	blocked?: boolean
	/** A screen that stays signed in (a kitchen display): never lock. */
	exempt?: boolean
}

/**
 * Whole seconds until the till signs the person out, or `null` when it will
 * not (nobody signed in, sign-in not required, locking off, a payment open, a
 * kitchen display).
 */
export function secondsUntilLock(input: LockInput): number | null {
	if (
		!input.signInRequired ||
		!input.signedIn ||
		input.idleLockSeconds <= 0 ||
		input.blocked ||
		input.exempt
	) {
		return null
	}
	const seconds = input.held
		? Math.max(input.idleLockSeconds, HELD_LOCK_SECONDS)
		: input.idleLockSeconds
	return Math.max(0, Math.ceil((seconds * 1000 - input.idleMs) / 1000))
}

/** Should the till lock now? Only while someone is signed in at a till that requires it. */
export function shouldLock(input: LockInput): boolean {
	return secondsUntilLock(input) === 0
}

/**
 * The one idle decision (#364): whether the till signs the person out now and
 * whether the sign-out warning shows. The till's own timeout applies unless
 * the location set idle minutes, which then replace it.
 */
export function idleDecision(input: {
	signInRequired: boolean
	signedIn: boolean
	terminalSeconds: number
	locationMinutes: number | null | undefined
	idleMs: number
	held?: boolean
	blocked?: boolean
	exempt?: boolean
}): { lock: boolean; warning: number | null } {
	const lockInput = {
		signInRequired: input.signInRequired,
		signedIn: input.signedIn,
		idleLockSeconds: idleLockSecondsFor({
			terminalSeconds: input.terminalSeconds,
			locationMinutes: input.locationMinutes,
		}),
		idleMs: input.idleMs,
		held: input.held,
		blocked: input.blocked,
		exempt: input.exempt,
	}
	return {
		lock: shouldLock(lockInput),
		warning: signOutWarning(lockInput),
	}
}

/**
 * Seconds left to show in the sign-out warning, or `null` before the last
 * `SIGN_OUT_WARNING_SECONDS` (and whenever the till will not sign out).
 */
export function signOutWarning(input: LockInput): number | null {
	const left = secondsUntilLock(input)
	return left !== null && left > 0 && left <= SIGN_OUT_WARNING_SECONDS
		? left
		: null
}

/** Choices a manager can pick for "lock after". 0 means never. */
export const IDLE_LOCK_CHOICES: Array<{ seconds: number; label: string }> = [
	{ seconds: 30, label: '30 seconds' },
	{ seconds: 60, label: '1 minute' },
	{ seconds: 120, label: '2 minutes' },
	{ seconds: 300, label: '5 minutes' },
	{ seconds: 600, label: '10 minutes' },
	{ seconds: 0, label: 'Never' },
]
