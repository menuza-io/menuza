/**
 * Idle tracking for the lock. A module variable, not state: touching the screen
 * happens constantly and must not re-render anything.
 */
let lastActivity = Date.now()

export const touch = (now = Date.now()): void => {
	lastActivity = now
}

export const idleMs = (now = Date.now()): number => now - lastActivity

/** Should the till lock now? Only while someone is signed in at a till that requires it. */
export function shouldLock(input: {
	signInRequired: boolean
	signedIn: boolean
	idleLockSeconds: number
	idleMs: number
}): boolean {
	return (
		input.signInRequired &&
		input.signedIn &&
		input.idleLockSeconds > 0 &&
		input.idleMs >= input.idleLockSeconds * 1000
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
