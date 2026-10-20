import { useCallback, useEffect, useRef, useState } from 'react'

export type Remote<T> = {
	data: T | null
	error: unknown
	/** True until the first answer; stays false while refreshing. */
	loading: boolean
	refreshing: boolean
	reload: () => void
}

/**
 * Loads one thing for the "my schedule" page. Previous data stays on screen while
 * it refreshes (switching weeks never flashes an empty list), and a failed
 * refresh keeps what was there and reports the error. Pass `null` to wait.
 * `key` says when the request is a different one (a different week, say).
 */
export function useMyScheduleData<T>(
	load: (() => Promise<T>) | null,
	key: string,
): Remote<T> {
	const loadRef = useRef(load)
	loadRef.current = load
	const enabled = load !== null
	const [state, setState] = useState<{
		data: T | null
		error: unknown
		loading: boolean
		refreshing: boolean
	}>({ data: null, error: null, loading: enabled, refreshing: false })
	const [tick, setTick] = useState(0)

	useEffect(() => {
		const run = loadRef.current
		if (!run) return
		let live = true
		setState((previous) => ({
			...previous,
			loading: previous.data === null,
			refreshing: previous.data !== null,
			error: null,
		}))
		run().then(
			(data) => {
				if (live) {
					setState({ data, error: null, loading: false, refreshing: false })
				}
			},
			(error: unknown) => {
				if (live) {
					setState((previous) => ({
						...previous,
						error,
						loading: false,
						refreshing: false,
					}))
				}
			},
		)
		return () => {
			live = false
		}
	}, [key, tick, enabled])

	const reload = useCallback(() => setTick((value) => value + 1), [])
	return { ...state, reload }
}
