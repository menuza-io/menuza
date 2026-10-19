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

/** True once `active` has stayed true for `afterMs` (a slow load), false again when it ends. */
export function useSlowLoad(active: boolean, afterMs = 10_000): boolean {
	const [slow, setSlow] = useState(false)
	useEffect(() => {
		setSlow(false)
		if (!active) return
		const id = window.setTimeout(() => setSlow(true), afterMs)
		return () => window.clearTimeout(id)
	}, [active, afterMs])
	return slow
}

/** "Updated 12 seconds ago", in the app language; re-renders every 5 seconds. */
export function UpdatedAgo({ at }: { at: number | null }) {
	const { t, i18n } = useLingui()
	const now = useTick(5_000)
	if (at === null) return null
	const seconds = Math.max(0, Math.round((now - at) / 1000))
	let ago: string
	try {
		const rtf = new Intl.RelativeTimeFormat(i18n.locale, { numeric: 'auto' })
		ago =
			seconds < 5
				? rtf.format(0, 'second')
				: seconds < 60
					? rtf.format(-Math.round(seconds / 5) * 5, 'second')
					: rtf.format(-Math.floor(seconds / 60), 'minute')
	} catch {
		ago = `${seconds}s`
	}
	return (
		<span
			className="text-muted-foreground text-xs tabular-nums"
			data-testid="waitlist-updated-ago"
		>
			{t`Updated ${ago}`}
		</span>
	)
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
