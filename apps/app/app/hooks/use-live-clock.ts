import { useEffect, useState } from 'react'

/**
 * Wall-clock time that re-renders every `intervalMs` while the tab is visible.
 * Used for "since 9:03 · 3h 12m" labels that must keep counting without a
 * request. `offsetMs` is the server's lead over this device (server minus
 * device at the time of the last response) so a wrong tablet clock does not
 * show negative durations.
 */
export function useLiveNow(intervalMs = 30_000, offsetMs = 0): number {
	const [tick, setTick] = useState(() => Date.now())
	useEffect(() => {
		let timer: ReturnType<typeof setInterval> | null = null
		function start() {
			if (timer !== null) return
			setTick(Date.now())
			timer = setInterval(() => setTick(Date.now()), intervalMs)
		}
		function stop() {
			if (timer !== null) clearInterval(timer)
			timer = null
		}
		function onVisibility() {
			if (document.visibilityState === 'visible') start()
			else stop()
		}
		if (document.visibilityState === 'visible') start()
		document.addEventListener('visibilitychange', onVisibility)
		return () => {
			stop()
			document.removeEventListener('visibilitychange', onVisibility)
		}
	}, [intervalMs])
	return tick + offsetMs
}

/**
 * Calls `reload` every `intervalMs` while the tab is visible and once more when
 * it becomes visible again after being hidden, so a manager who comes back to
 * the tab sees current data without pressing anything.
 */
export function useVisiblePolling(reload: () => void, intervalMs = 30_000) {
	useEffect(() => {
		let timer: ReturnType<typeof setInterval> | null = null
		let hiddenAt: number | null = null
		function start() {
			if (timer === null) timer = setInterval(reload, intervalMs)
		}
		function stop() {
			if (timer !== null) clearInterval(timer)
			timer = null
		}
		function onVisibility() {
			if (document.visibilityState === 'visible') {
				if (hiddenAt !== null && Date.now() - hiddenAt > 5_000) reload()
				hiddenAt = null
				start()
			} else {
				hiddenAt = Date.now()
				stop()
			}
		}
		if (document.visibilityState === 'visible') start()
		document.addEventListener('visibilitychange', onVisibility)
		return () => {
			stop()
			document.removeEventListener('visibilitychange', onVisibility)
		}
	}, [reload, intervalMs])
}
