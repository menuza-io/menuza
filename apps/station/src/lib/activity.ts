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

/** Should the till lock now? Only while someone is signed in at a till that requires it. */
export function shouldLock(input: {
	signInRequired: boolean
	signedIn: boolean
	idleLockSeconds: number
	idleMs: number
	/** Work in progress on screen: the lock waits longer. */
	held?: boolean
}): boolean {
	const seconds = input.held
		? Math.max(input.idleLockSeconds, HELD_LOCK_SECONDS)
		: input.idleLockSeconds
	return (
		input.signInRequired &&
		input.signedIn &&
		input.idleLockSeconds > 0 &&
		input.idleMs >= seconds * 1000
	)
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
