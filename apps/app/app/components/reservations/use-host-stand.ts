import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useLiveNow } from '#app/hooks/use-live-now.ts'
import { useReservationsScopeClient } from '#app/hooks/use-reservations-client.ts'
import { useReservationsPoll } from '#app/hooks/use-reservations-poll.ts'
import {
	type DayFeedResponse,
	type DayMoveNotice,
	type DayReservationView,
	fetchBookDayConditional,
} from '#app/utils/reservations/book-api.ts'

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

	const pollKey = `${locationId}:${dateParam ?? 'today'}:${serviceParam ?? 'all'}:${areaParam ?? 'all'}`

	const fetcher = useCallback(
		(etag: string | null, signal: AbortSignal) =>
			fetchBookDayConditional(
				client,
				{
					locationId,
					date: dateParam,
					serviceId: serviceParam,
					areaId: areaParam,
				},
				etag,
				signal,
			),
		[areaParam, client, dateParam, locationId, serviceParam],
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
	const timeZone = dayFeed?.timezone ?? defaultTimeZone
	const liveNow = useLiveNow({
		timeZone,
		dayStartMin: dayFeed?.dayStartMin ?? 240,
		intervalMs: 15_000,
	})

	const businessDate =
		dayFeed?.businessDate ?? dateParam ?? liveNow.businessDate

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
			if (updatedReservation && dayFeed) {
				poll.setOptimisticData((prev) => {
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
			void poll.refresh({ force: true })
		},
		[dayFeed, poll],
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

	const refresh = useCallback(() => poll.refresh({ force: true }), [poll])

	return {
		client,
		poll,
		dayFeed,
		feed: dayFeed,
		liveNow,
		businessDate,
		selectedDate: businessDate,
		todayDate: liveNow.businessDate,
		selectedServiceId: serviceParam,
		selectedAreaId: areaParam,
		areaFilter: areaParam,
		detailReservationId,
		selectedReservation,
		setDate,
		setServiceId,
		setAreaId,
		setAreaFilter: setAreaId,
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
		clearMoveNotices: () => setRecentMoveNotices([]),
		handleReservationMutated,
		refresh,
	}
}
