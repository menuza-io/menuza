import { useCallback, useEffect, useState } from 'react'

/**
 * A per-device yes/no marker for the setup checklist ("opened Booking rules",
 * "dismissed the finished checklist"). Browser storage is only a convenience:
 * every read and write is guarded, and the checklist renders without it.
 */
export function useSetupFlag(
	key: string,
): readonly [boolean, (next: boolean) => void] {
	const [value, setValue] = useState(false)

	useEffect(() => {
		try {
			setValue(window.localStorage.getItem(key) === '1')
		} catch {
			setValue(false)
		}
	}, [key])

	const set = useCallback(
		(next: boolean) => {
			setValue(next)
			try {
				if (next) window.localStorage.setItem(key, '1')
				else window.localStorage.removeItem(key)
			} catch {
				// Storage can be blocked; the flag then lasts for this visit only.
			}
		},
		[key],
	)

	return [value, set] as const
}
