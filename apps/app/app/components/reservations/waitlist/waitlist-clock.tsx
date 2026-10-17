import { Trans, useLingui } from '@lingui/react/macro'
import { Badge } from '@repo/ui/badge'
import { useEffect, useState } from 'react'
import { type WaitlistEntry } from '#app/utils/reservations/waitlist-api.ts'
import {
	deadlineCountdown,
	formatCountdown,
	splitMinutes,
} from '#app/utils/reservations/waitlist-view.ts'

/** A wall clock that re-renders only the component that calls it. */
export function useTick(intervalMs: number, offsetMs = 0): number {
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		setNow(Date.now())
		const id = window.setInterval(() => setNow(Date.now()), intervalMs)
		return () => window.clearInterval(id)
	}, [intervalMs])
	return now + offsetMs
}

/** "25 min" or "1 h 5 min". */
export function useFormatMinutes() {
	const { t } = useLingui()
	return (totalMin: number) => {
		const { hours, minutes } = splitMinutes(totalMin)
		return hours > 0 ? t`${hours} h ${minutes} min` : t`${minutes} min`
	}
}

/** Time left to answer the table-ready message; ticks every second. */
export function WaitlistCountdown({
	entry,
	offsetMs,
}: {
	entry: Pick<WaitlistEntry, 'id' | 'status' | 'responseDeadlineAt'>
	offsetMs: number
}) {
	const now = useTick(1_000, offsetMs)
	const countdown = deadlineCountdown(entry, now)
	if (!countdown) return null
	const remaining = formatCountdown(countdown)
	return (
		<Badge
			variant={countdown.expired ? 'destructive' : 'warning'}
			data-testid={`waitlist-countdown-${entry.id}`}
		>
			{countdown.expired ? (
				<Trans>Offer expired</Trans>
			) : (
				<Trans>Answer within {remaining}</Trans>
			)}
		</Badge>
	)
}
