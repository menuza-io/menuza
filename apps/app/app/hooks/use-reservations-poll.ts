import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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
	/** Data for the current `key` only: a key change never shows the previous key's data. */
	data: T | null
	etag: string | null
	loading: boolean
	refreshing: boolean
	/** Raw failure message, for logs only; screens show `errorCode` / `errorStatus` copy. */
	error: string | null
	/** HTTP status of the last failure (`ReservationsApiError.status`), when there was one. */
	errorStatus: number | null
	/** Server error code from the response body, when there was one. */
	errorCode: string | null
	/** 401 or 403: polling has stopped until the host retries. */
	accessDenied: boolean
	lastUpdatedAt: number | null
	notModifiedCount: number
	refresh: (options?: { force?: boolean }) => Promise<void>
	setOptimisticData: (updater: T | ((prev: T | null) => T | null)) => void
}

type FetchFailure = {
	key: string
	message: string
	status: number | null
	code: string | null
}

/** Reads `status` and the body's error code off a `ReservationsApiError`-shaped failure. */
export function describeFetchFailure(err: unknown): {
	message: string
	status: number | null
	code: string | null
} {
	const message =
		err instanceof Error ? err.message : 'Failed to load reservations'
	if (!err || typeof err !== 'object')
		return { message, status: null, code: null }
	const rawStatus = (err as { status?: unknown }).status
	const body = (err as { body?: unknown }).body
	const bodyObject =
		body && typeof body === 'object' ? (body as Record<string, unknown>) : null
	const rawCode = bodyObject?.error ?? bodyObject?.code
	return {
		message,
		status: typeof rawStatus === 'number' ? rawStatus : null,
		code: typeof rawCode === 'string' ? rawCode : null,
	}
}

/**
 * Polls a regional `tenant-api` endpoint with `If-None-Match` ETag support.
 * On `304 Not Modified`, preserves the existing `data` reference so open sheets,
 * scroll positions, and active selections are never reset.
 * Pauses automatically while `paused` is true (e.g. active drag) or the tab is hidden.
 *
 * Data and errors are keyed: after `key` changes (another date, location or
 * filter) the previous key's data is not returned, and a response that
 * resolves for an old key is dropped, so the host never sees or acts on stale
 * rows. A 401 or 403 stops the interval.
 */
export function useReservationsPoll<T>({
	key,
	fetcher,
	intervalMs = 10_000,
	paused = false,
	enabled = true,
	initialData = null,
}: UseReservationsPollOptions<T>): UseReservationsPollReturn<T> {
	const [slot, setSlot] = useState<{ key: string; data: T | null }>(() => ({
		key,
		data: initialData,
	}))
	const [etagSlot, setEtagSlot] = useState<{
		key: string
		etag: string | null
	} | null>(null)
	const [refreshing, setRefreshing] = useState<boolean>(false)
	const [failure, setFailure] = useState<FetchFailure | null>(null)
	const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null)
	const [notModifiedCount, setNotModifiedCount] = useState<number>(0)

	const data = slot.key === key ? slot.data : null
	const etag = etagSlot && etagSlot.key === key ? etagSlot.etag : null
	const currentFailure = failure && failure.key === key ? failure : null
	const accessDenied =
		currentFailure !== null &&
		(currentFailure.status === 401 || currentFailure.status === 403)

	const etagRef = useRef<string | null>(null)
	const keyRef = useRef(key)
	keyRef.current = key
	const hasDataRef = useRef<boolean>(data !== null)
	hasDataRef.current = data !== null
	const fetcherRef = useRef(fetcher)
	fetcherRef.current = fetcher
	const abortRef = useRef<AbortController | null>(null)
	const prevKeyRef = useRef<string>(key)

	const runFetch = useCallback(
		async (opts?: { force?: boolean }) => {
			if (!enabled) return
			abortRef.current?.abort()
			const controller = new AbortController()
			abortRef.current = controller
			const fetchKey = keyRef.current

			const sendEtag = opts?.force ? null : etagRef.current
			if (hasDataRef.current) setRefreshing(true)

			const stale = () =>
				controller.signal.aborted || keyRef.current !== fetchKey

			try {
				const result = await fetcherRef.current(sendEtag, controller.signal)
				if (stale()) return

				if (result.status === 304) {
					if (result.etag) {
						etagRef.current = result.etag
						setEtagSlot({ key: fetchKey, etag: result.etag })
					}
					setNotModifiedCount((c) => c + 1)
					setFailure(null)
				} else {
					etagRef.current = result.etag
					hasDataRef.current = true
					setEtagSlot({ key: fetchKey, etag: result.etag })
					setSlot({ key: fetchKey, data: result.data })
					setLastUpdatedAt(Date.now())
					setFailure(null)
				}
			} catch (err) {
				if (stale()) return
				setFailure({ key: fetchKey, ...describeFetchFailure(err) })
			} finally {
				if (!stale()) setRefreshing(false)
			}
		},
		[enabled],
	)

	// Reset the ETag and fetch immediately when `key` or `enabled` changes
	useEffect(() => {
		if (!enabled) {
			abortRef.current?.abort()
			setRefreshing(false)
			return
		}
		if (prevKeyRef.current !== key) {
			prevKeyRef.current = key
			etagRef.current = null
			setRefreshing(false)
		}
		void runFetch({ force: true })
		return () => {
			abortRef.current?.abort()
		}
	}, [enabled, key, runFetch])

	// Periodic ETag polling when not paused, stopped after a 401 or 403
	useEffect(() => {
		if (!enabled || paused || intervalMs <= 0 || accessDenied) return

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
	}, [enabled, paused, intervalMs, accessDenied, runFetch])

	const refresh = useCallback(
		async (opts?: { force?: boolean }) => {
			await runFetch({ force: opts?.force ?? true })
		},
		[runFetch],
	)

	const setOptimisticData = useCallback(
		(updater: T | ((prev: T | null) => T | null)) => {
			etagRef.current = null
			setEtagSlot({ key: keyRef.current, etag: null })
			setSlot((prev) => {
				const prevData = prev.key === keyRef.current ? prev.data : null
				const next =
					typeof updater === 'function'
						? (updater as (prev: T | null) => T | null)(prevData)
						: updater
				hasDataRef.current = next !== null
				return { key: keyRef.current, data: next }
			})
		},
		[],
	)

	const loading = enabled && data === null && currentFailure === null

	return useMemo(
		() => ({
			data,
			etag,
			loading,
			refreshing,
			error: currentFailure?.message ?? null,
			errorStatus: currentFailure?.status ?? null,
			errorCode: currentFailure?.code ?? null,
			accessDenied,
			lastUpdatedAt,
			notModifiedCount,
			refresh,
			setOptimisticData,
		}),
		[
			data,
			etag,
			loading,
			refreshing,
			currentFailure,
			accessDenied,
			lastUpdatedAt,
			notModifiedCount,
			refresh,
			setOptimisticData,
		],
	)
}
