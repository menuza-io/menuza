import { useCallback, useEffect, useRef, useState } from 'react'

export type PollResult<T> =
	| {
			status: 200
			data: T
			etag: string | null
	  }
	| {
			status: 304
			etag?: string | null
	  }

export type UseReservationsPollOptions<T> = {
	/** Dependency key (e.g. `${locationId}:${date}`) that resets ETag and triggers an immediate fetch when changed. */
	key: string
	/** Function that fetches data with an optional `If-None-Match` ETag. */
	fetcher: (etag: string | null, signal: AbortSignal) => Promise<PollResult<T>>
	/** Polling interval in milliseconds (default 10_000ms for Book/Timeline, 5_000ms for Floor Plan). */
	intervalMs?: number
	/** Pause polling (e.g. during active drag-and-drop or modal mutation). */
	paused?: boolean
	/** Disable automatic polling entirely. */
	enabled?: boolean
	/** Optional initial data before the first poll completes. */
	initialData?: T | null
}

export type UseReservationsPollReturn<T> = {
	data: T | null
	etag: string | null
	loading: boolean
	refreshing: boolean
	error: string | null
	lastUpdatedAt: number | null
	notModifiedCount: number
	refresh: (options?: { force?: boolean }) => Promise<void>
	setOptimisticData: (updater: T | ((prev: T | null) => T | null)) => void
}

/**
 * Polls a regional `tenant-api` endpoint with `If-None-Match` ETag support.
 * On `304 Not Modified`, preserves the existing `data` reference so open sheets,
 * scroll positions, and active selections are never reset.
 * Pauses automatically while `paused` is true (e.g. active drag) or the tab is hidden.
 */
export function useReservationsPoll<T>({
	key,
	fetcher,
	intervalMs = 10_000,
	paused = false,
	enabled = true,
	initialData = null,
}: UseReservationsPollOptions<T>): UseReservationsPollReturn<T> {
	const [data, setData] = useState<T | null>(initialData)
	const [etag, setEtag] = useState<string | null>(null)
	const [loading, setLoading] = useState<boolean>(
		initialData === null && enabled,
	)
	const [refreshing, setRefreshing] = useState<boolean>(false)
	const [error, setError] = useState<string | null>(null)
	const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null)
	const [notModifiedCount, setNotModifiedCount] = useState<number>(0)

	const etagRef = useRef<string | null>(null)
	const hasDataRef = useRef<boolean>(initialData !== null)
	const fetcherRef = useRef(fetcher)
	fetcherRef.current = fetcher
	const abortRef = useRef<AbortController | null>(null)
	const prevKeyRef = useRef<string>(key)

	const runFetch = useCallback(
		async (opts?: { force?: boolean; isInitial?: boolean }) => {
			if (!enabled) return
			abortRef.current?.abort()
			const controller = new AbortController()
			abortRef.current = controller

			const sendEtag = opts?.force ? null : etagRef.current
			if (opts?.isInitial || !hasDataRef.current) {
				setLoading(true)
			} else {
				setRefreshing(true)
			}

			try {
				const result = await fetcherRef.current(sendEtag, controller.signal)
				if (controller.signal.aborted) return

				if (result.status === 304) {
					if (result.etag) {
						etagRef.current = result.etag
						setEtag(result.etag)
					}
					setNotModifiedCount((c) => c + 1)
					setError(null)
				} else {
					etagRef.current = result.etag
					hasDataRef.current = true
					setEtag(result.etag)
					setData(result.data)
					setLastUpdatedAt(Date.now())
					setError(null)
				}
			} catch (err) {
				if (controller.signal.aborted) return
				setError(
					err instanceof Error ? err.message : 'Failed to load reservations',
				)
			} finally {
				if (!controller.signal.aborted) {
					setLoading(false)
					setRefreshing(false)
				}
			}
		},
		[enabled],
	)

	// Reset ETag and fetch immediately when `key` or `enabled` changes
	useEffect(() => {
		if (!enabled) {
			abortRef.current?.abort()
			setLoading(false)
			setRefreshing(false)
			return
		}
		if (prevKeyRef.current !== key) {
			prevKeyRef.current = key
			etagRef.current = null
			setEtag(null)
		}
		void runFetch({ force: true, isInitial: !hasDataRef.current })
		return () => {
			abortRef.current?.abort()
		}
	}, [enabled, key, runFetch])

	// Periodic ETag polling when not paused
	useEffect(() => {
		if (!enabled || paused || intervalMs <= 0) return

		const tick = () => {
			if (
				typeof document !== 'undefined' &&
				document.visibilityState === 'hidden'
			) {
				return
			}
			void runFetch({ force: false })
		}

		const id = window.setInterval(tick, intervalMs)
		const handleVisibility = () => {
			if (document.visibilityState === 'visible' && !paused) {
				void runFetch({ force: false })
			}
		}
		document.addEventListener('visibilitychange', handleVisibility)

		return () => {
			window.clearInterval(id)
			document.removeEventListener('visibilitychange', handleVisibility)
		}
	}, [enabled, intervalMs, paused, runFetch])

	const refresh = useCallback(
		async (opts?: { force?: boolean }) => {
			await runFetch({ force: opts?.force ?? true })
		},
		[runFetch],
	)

	const setOptimisticData = useCallback(
		(updater: T | ((prev: T | null) => T | null)) => {
			etagRef.current = null
			setEtag(null)
			setData((prev) => {
				const next =
					typeof updater === 'function'
						? (updater as (prev: T | null) => T | null)(prev)
						: updater
				hasDataRef.current = next !== null
				return next
			})
		},
		[],
	)

	return {
		data,
		etag,
		loading,
		refreshing,
		error,
		lastUpdatedAt,
		notModifiedCount,
		refresh,
		setOptimisticData,
	}
}
