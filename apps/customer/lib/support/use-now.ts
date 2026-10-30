import { useEffect, useState } from 'react'

/**
 * The current time, ticking every `intervalMs` while `enabled` (a
 * countdown on screen). Stopped, it keeps the last value.
 */
export function useNow(enabled: boolean, intervalMs = 1000): number {
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		if (!enabled) return
		setNow(Date.now())
		const timer = setInterval(() => setNow(Date.now()), intervalMs)
		return () => clearInterval(timer)
	}, [enabled, intervalMs])
	return now
}
