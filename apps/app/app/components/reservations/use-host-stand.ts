import { useCallback, useEffect, useMemo, useState } from 'react'
import { useOutletContext, useSearchParams } from 'react-router'
import { useLiveNow } from '#app/hooks/use-live-now.ts'
import { useReservationsScopeClient } from '#app/hooks/use-reservations-client.ts'
import { useReservationsPoll } from '#app/hooks/use-reservations-poll.ts'
import {
	type DayFeedResponse,
	type DayMoveNotice,
	type DayReservationView,
	fetchBookDayConditional,
} from '#app/utils/reservations/book-api.ts'

type ServiceClockOutletContext = {
	reportServiceClock?: (clock: {
		locationId: string
		dayStartMin: number
	}) => void
}

export function useHostStand({
	orgSlug,
	locationId,
	defaultTimeZone = 'UTC',
	pollIntervalMs = 10_000,
	paused = false,
	pausePolling = false,
}: {
	orgSlug: string
	locationId: string
	defaultTimeZone?: string
	pollIntervalMs?: number
	paused?: boolean
	pausePolling?: boolean
}) {
	const [searchParams, setSearchParams] = useSearchParams()
	const dateParam = searchParams.get('date') ?? undefined
	const serviceParam = searchParams.get('service') ?? null
	const areaParam = searchParams.get('area') ?? null
	const sourceParam = searchParams.get('source') ?? null
	const tagParam = searchParams.get('tag') ?? null
	const detailReservationId = searchParams.get('r') ?? null

	const [bookingSheetOpen, setBookingSheetOpen] = useState(false)
	const [bookingDefaults, setBookingDefaults] = useState<{
		localStartMin?: number
		partySize?: number
		tableId?: string | null
		areaId?: string | null
		serviceId?: string | null
	}>({})
	const [walkInOpen, setWalkInOpen] = useState(false)
	const [walkInDefaults, setWalkInDefaults] = useState<{
		tableId?: string | null
		partySize?: number
	}>({})
	const [conflictPanelOpen, setConflictPanelOpen] = useState(false)
	const [recentMoveNotices, setRecentMoveNotices] = useState<DayMoveNotice[]>(
		[],
	)

	const client = useReservationsScopeClient(
		orgSlug,
		'book',
		locationId ? [locationId] : undefined,
	)

	const pollKey = `${locationId}:${dateParam ?? 'today'}:${serviceParam ?? 'all'}:${areaParam ?? 'all'}:${sourceParam ?? 'all'}:${tagParam ?? 'all'}`

	// Move notices belong to the day, location and filters they came from.
	useEffect(() => {
		setRecentMoveNotices([])
	}, [pollKey])

	const fetcher = useCallback(
		(etag: string | null, signal: AbortSignal) =>
			fetchBookDayConditional(
				client,
				{
					locationId,
					date: dateParam,
					serviceId: serviceParam,
					areaId: areaParam,
					source: sourceParam,
					tag: tagParam,
				},
				etag,
				signal,
			),
		[
			areaParam,
			client,
			dateParam,
			locationId,
			serviceParam,
			sourceParam,
			tagParam,
		],
	)

	const poll = useReservationsPoll<DayFeedResponse>({
		key: pollKey,
		fetcher,
		intervalMs: pollIntervalMs,
		paused:
			paused ||
			pausePolling ||
			bookingSheetOpen ||
			walkInOpen ||
			Boolean(detailReservationId),
		enabled: Boolean(locationId),
	})

	const dayFeed = poll.data
	const layout = useOutletContext<ServiceClockOutletContext | null>()
	const reportServiceClock = layout?.reportServiceClock
	const feedLocationId = dayFeed?.locationId
	const feedDayStartMin = dayFeed?.dayStartMin
	useEffect(() => {
		if (reportServiceClock && feedLocationId && feedDayStartMin !== undefined) {
			reportServiceClock({
				locationId: feedLocationId,
				dayStartMin: feedDayStartMin,
			})
		}
	}, [reportServiceClock, feedLocationId, feedDayStartMin])
	const timeZone = dayFeed?.timezone ?? defaultTimeZone
	const liveNow = useLiveNow({
		timeZone,
		dayStartMin: dayFeed?.dayStartMin ?? 240,
		intervalMs: 15_000,
	})

	// The URL date wins: the feed is keyed to it, so the header never shows the
	// previous day's date while the new day loads.
	const businessDate =
		dateParam ?? dayFeed?.businessDate ?? liveNow.businessDate

	const updateSearchParam = useCallback(
		(updates: Record<string, string | null | undefined>) => {
			setSearchParams(
				(prev) => {
					const next = new URLSearchParams(prev)
					for (const [k, v] of Object.entries(updates)) {
						if (v === null || v === undefined || v === '') {
							next.delete(k)
						} else {
							next.set(k, v)
						}
					}
					return next
				},
				{ replace: true },
			)
		},
		[setSearchParams],
	)

	const setDate = useCallback(
		(nextDate: string) => {
			updateSearchParam({ date: nextDate })
		},
		[updateSearchParam],
	)

	const setServiceId = useCallback(
		(nextServiceId: string | null) => {
			updateSearchParam({ service: nextServiceId })
		},
		[updateSearchParam],
	)

	const setAreaId = useCallback(
		(nextAreaId: string | null) => {
			updateSearchParam({ area: nextAreaId })
		},
		[updateSearchParam],
	)

	const setSource = useCallback(
		(nextSource: string | null) => {
			updateSearchParam({ source: nextSource })
		},
		[updateSearchParam],
	)

	const setTag = useCallback(
		(nextTag: string | null) => {
			updateSearchParam({ tag: nextTag })
		},
		[updateSearchParam],
	)

	const openDetail = useCallback(
		(reservationId: string) => {
			updateSearchParam({ r: reservationId })
		},
		[updateSearchParam],
	)

	const closeDetail = useCallback(() => {
		updateSearchParam({ r: null })
	}, [updateSearchParam])

	const openBookingSheet = useCallback(
		(defaults?: {
			localStartMin?: number
			partySize?: number
			tableId?: string | null
			areaId?: string | null
			serviceId?: string | null
		}) => {
			setBookingDefaults(defaults ?? {})
			setBookingSheetOpen(true)
		},
		[],
	)

	const openWalkIn = useCallback(
		(defaults?: { tableId?: string | null; partySize?: number }) => {
			setWalkInDefaults(defaults ?? {})
			setWalkInOpen(true)
		},
		[],
	)

	const { refresh: pollRefresh, setOptimisticData } = poll
	const handleReservationMutated = useCallback(
		(
			updatedReservation?: DayReservationView,
			newMoveNotices?: DayMoveNotice[],
		) => {
			if (newMoveNotices && newMoveNotices.length > 0) {
				setRecentMoveNotices((prev) =>
					[...newMoveNotices, ...prev].slice(0, 20),
				)
			}
			if (updatedReservation) {
				setOptimisticData((prev) => {
					if (!prev) return prev
					const exists = prev.reservations.some(
						(r) => r.id === updatedReservation.id,
					)
					const nextReservations = exists
						? prev.reservations.map((r) =>
								r.id === updatedReservation.id ? updatedReservation : r,
							)
						: [...prev.reservations, updatedReservation].sort(
								(a, b) => a.localStartMin - b.localStartMin,
							)
					return {
						...prev,
						reservations: nextReservations,
					}
				})
			}
			void pollRefresh({ force: true })
		},
		[pollRefresh, setOptimisticData],
	)

	const allMoveNotices = useMemo(() => {
		const feedNotices = dayFeed?.moveNotices ?? []
		const seen = new Set<string>()
		const merged: DayMoveNotice[] = []
		for (const item of [...recentMoveNotices, ...feedNotices]) {
			const k = `${item.reservationId}:${item.toTableIds.join(',')}:${item.reason}`
			if (!seen.has(k)) {
				seen.add(k)
				merged.push(item)
			}
		}
		return merged
	}, [dayFeed?.moveNotices, recentMoveNotices])

	const selectedReservation = useMemo(
		() =>
			detailReservationId
				? (dayFeed?.reservations.find((r) => r.id === detailReservationId) ??
					null)
				: null,
		[dayFeed?.reservations, detailReservationId],
	)

	const openReservationDetail = useCallback(
		(reservationId: string | null) => {
			if (reservationId) {
				openDetail(reservationId)
			} else {
				closeDetail()
			}
		},
		[closeDetail, openDetail],
	)

	const appendMoveNotices = useCallback((notices: DayMoveNotice[]) => {
		if (notices.length > 0) {
			setRecentMoveNotices((prev) => [...notices, ...prev].slice(0, 20))
		}
	}, [])

	const refresh = useCallback(() => pollRefresh({ force: true }), [pollRefresh])
	const clearMoveNotices = useCallback(() => setRecentMoveNotices([]), [])

	return {
		client,
		poll,
		dayFeed,
		feed: dayFeed,
		liveNow,
		businessDate,
		timeZone,
		selectedDate: businessDate,
		todayDate: liveNow.businessDate,
		/** The viewed day is the location's current business day, so live clocks apply. */
		isToday: businessDate === liveNow.businessDate,
		selectedServiceId: serviceParam,
		selectedAreaId: areaParam,
		selectedSource: sourceParam,
		selectedTag: tagParam,
		areaFilter: areaParam,
		detailReservationId,
		selectedReservation,
		setDate,
		setServiceId,
		setAreaId,
		setAreaFilter: setAreaId,
		setSource,
		setTag,
		openDetail,
		closeDetail,
		openReservationDetail,
		bookingSheetOpen,
		setBookingSheetOpen,
		bookingDefaults,
		openBookingSheet,
		walkInOpen,
		setWalkInOpen,
		walkInDefaults,
		openWalkIn,
		conflictPanelOpen,
		setConflictPanelOpen,
		allMoveNotices,
		moveNotices: allMoveNotices,
		appendMoveNotices,
		clearMoveNotices,
		handleReservationMutated,
		refresh,
	}
}
