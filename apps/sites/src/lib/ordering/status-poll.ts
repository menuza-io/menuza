/**
 * Live status for the order page: re-reads the order every 15 seconds, stops
 * when it is settled, pauses while the tab is hidden and reads again the
 * moment it is visible. One request at a time, the next one scheduled only
 * after the last one finished, so a slow or failing network never makes a
 * tight loop. Timers and visibility come in through `deps`, so this is
 * testable without a browser.
 */

export const STATUS_POLL_INTERVAL_MS = 15_000

/** Orders that will not change again. */
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'expired'])

export function isTerminalStatus(status: string | null | undefined): boolean {
	return status ? TERMINAL_STATUSES.has(status) : false
}

export type StatusFetchResult<T> =
	| { kind: 'order'; order: T & { status: string } }
	/** The order cannot be read (expired or invalid link): stop for good. */
	| { kind: 'gone' }

export type StatusPollerDeps<T> = {
	fetchOnce: () => Promise<StatusFetchResult<T>>
	onOrder: (order: T & { status: string }) => void
	onGone?: () => void
	intervalMs?: number
	isHidden: () => boolean
	/** Subscribes to visibility changes; returns an unsubscribe function. */
	onVisibilityChange: (listener: () => void) => () => void
	setTimer?: (callback: () => void, ms: number) => unknown
	clearTimer?: (handle: unknown) => void
}

export type StatusPoller = {
	/** Reads now (or after one interval with `immediate: false`), then keeps polling. */
	start: (options?: { immediate?: boolean }) => void
	stop: () => void
	/** Reads now unless a read is already running. */
	refresh: () => void
}

export function createStatusPoller<T>(deps: StatusPollerDeps<T>): StatusPoller {
	const interval = deps.intervalMs ?? STATUS_POLL_INTERVAL_MS
	const setTimer =
		deps.setTimer ?? ((callback, ms) => globalThis.setTimeout(callback, ms))
	const clearTimer =
		deps.clearTimer ??
		((handle) => globalThis.clearTimeout(handle as number | undefined))
	let timer: unknown = null
	let inFlight = false
	let stopped = true
	let unsubscribe: (() => void) | null = null

	function clearScheduled() {
		if (timer !== null) clearTimer(timer)
		timer = null
	}

	function schedule() {
		clearScheduled()
		if (stopped || deps.isHidden()) return
		timer = setTimer(() => {
			timer = null
			void read()
		}, interval)
	}

	function finish() {
		stopped = true
		clearScheduled()
		unsubscribe?.()
		unsubscribe = null
	}

	async function read() {
		if (stopped || inFlight) return
		inFlight = true
		try {
			const result = await deps.fetchOnce()
			if (stopped) return
			if (result.kind === 'gone') {
				finish()
				deps.onGone?.()
				return
			}
			deps.onOrder(result.order)
			if (isTerminalStatus(result.order.status)) {
				finish()
				return
			}
		} catch {
			// Keep the last state and try again on the normal interval.
		} finally {
			inFlight = false
		}
		schedule()
	}

	return {
		start(options) {
			if (!stopped) return
			stopped = false
			unsubscribe = deps.onVisibilityChange(() => {
				if (stopped) return
				if (deps.isHidden()) {
					clearScheduled()
				} else if (!inFlight) {
					clearScheduled()
					void read()
				}
			})
			if (deps.isHidden()) return
			if (options?.immediate === false) schedule()
			else void read()
		},
		stop: finish,
		refresh() {
			if (stopped || inFlight) return
			clearScheduled()
			void read()
		},
	}
}
