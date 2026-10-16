import {
	currentBusinessDate,
	formatHhmm,
	instantToLocal,
} from '@repo/reservations'
import { useCallback, useEffect, useMemo, useState } from 'react'

export type UseLiveNowOptions = {
	timeZone?: string
	dayStartMin?: number
	intervalMs?: number
	initialNowMs?: number
}

export type LiveNowState = {
	nowMs: number
	nowEpochSec: number
	businessDate: string
	localStartMin: number
	clockMin: number
	hhmm: string
	elapsedMinutesSince: (epochMsOrSec: number | null | undefined) => number
}

function normalizeEpochMs(value: number): number {
	// Values < 1e11 are Unix epoch seconds; values >= 1e11 are epoch milliseconds.
	return value < 1e11 ? value * 1000 : value
}

/**
 * Maintains a 30-second client-side timer for live elapsed seated timers
 * (`elapsedMin = floor((nowEpoch - seatedAtEpoch) / 60)`), remaining turn-time
 * progress bars, and the Timeline "Now" cursor without triggering extra network fetches.
 */
export function useLiveNow(options?: UseLiveNowOptions): LiveNowState {
	const timeZone = options?.timeZone || 'UTC'
	const dayStartMin = options?.dayStartMin ?? 240
	const intervalMs = options?.intervalMs ?? 30_000
	const [nowMs, setNowMs] = useState<number>(
		() => options?.initialNowMs ?? Date.now(),
	)

	useEffect(() => {
		if (intervalMs <= 0) return
		const id = window.setInterval(() => {
			setNowMs(Date.now())
		}, intervalMs)
		return () => {
			window.clearInterval(id)
		}
	}, [intervalMs])

	const elapsedMinutesSince = useCallback(
		(epochMsOrSec: number | null | undefined): number => {
			if (epochMsOrSec == null || !Number.isFinite(epochMsOrSec)) return 0
			const startMs = normalizeEpochMs(epochMsOrSec)
			return Math.max(0, Math.floor((nowMs - startMs) / 60_000))
		},
		[nowMs],
	)

	return useMemo(() => {
		let businessDate = '1970-01-01'
		let localStartMin = 0
		let clockMin = 0
		try {
			const local = instantToLocal(nowMs, timeZone, dayStartMin)
			businessDate = local.businessDate
			localStartMin = local.localStartMin
			clockMin = local.clockMin
		} catch {
			businessDate = currentBusinessDate(nowMs, 'UTC', dayStartMin)
		}
		return {
			nowMs,
			nowEpochSec: Math.floor(nowMs / 1000),
			businessDate,
			localStartMin,
			clockMin,
			hhmm: formatHhmm(clockMin),
			elapsedMinutesSince,
		}
	}, [dayStartMin, elapsedMinutesSince, nowMs, timeZone])
}
