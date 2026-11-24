import { Trans, msg, plural } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
	type StationAnnouncement,
	type StationMyWeek,
	type stationClockApi,
} from './clock.ts'
import { Button } from '~/ui/primitives.tsx'

/** How long the "My week" view stays up. Fixed: a touch does not extend it. */
export const MY_WEEK_SECONDS = 30
/** How long unread announcements wait on screen with nobody touching it. */
export const ANNOUNCEMENT_IDLE_SECONDS = 60

type Api = ReturnType<typeof stationClockApi>

/**
 * What follows a punch that reached the server (#514, #486): announcements the
 * person has not read, each with "Got it", and a "My week" button that shows
 * their hours, their next shift and, only when the organization turned it on,
 * an estimate of pay. The week is shown for 30 seconds and then locks, and the
 * PIN and everything fetched with it are dropped. Pay never appears on the lock
 * screen or the PIN pad: it is only ever here, after the person's own PIN.
 *
 * It tells its parent when it wants the screen to stay (`onHold`) so the
 * finished-punch timeout does not cut it short, and gives the screen back when
 * the week locks or the person is done.
 */
export function AfterPunch({
	api,
	pin,
	timeZone,
	touched,
	onHold,
	onFinish,
}: {
	api: Api
	/** The PIN just used for the punch. Dropped by the parent when the screen goes. */
	pin: string
	timeZone?: string
	/** Bumped by any touch, so a person still reading is not sent away. */
	touched: number
	onHold: (hold: boolean) => void
	onFinish: () => void
}) {
	const { _, i18n } = useLingui()
	const [announcements, setAnnouncements] = useState<
		StationAnnouncement[] | null
	>(null)
	const [week, setWeek] = useState<StationMyWeek | null>(null)
	const [weekFirstName, setWeekFirstName] = useState('')
	const [weekLoading, setWeekLoading] = useState(false)
	const [weekLeft, setWeekLeft] = useState(0)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState<string | null>(null)
	const live = useRef(true)

	useEffect(() => {
		live.current = true
		let cancelled = false
		api.announcements(pin).then(
			(result) => {
				if (!cancelled) setAnnouncements(result.announcements)
			},
			// Nothing to show is better than blocking the punch's confirmation.
			() => {
				if (!cancelled) setAnnouncements([])
			},
		)
		return () => {
			cancelled = true
			live.current = false
		}
	}, [api, pin])

	const unread = (announcements ?? []).filter((item) => item.readAt === null)
	const weekOpen = week !== null || weekLoading

	// Hold the screen while there is something to read; give it back after.
	useEffect(() => {
		onHold(weekOpen || unread.length > 0)
		return () => onHold(false)
	}, [weekOpen, unread.length, onHold])

	// The week locks 30 seconds after it opened, whatever anyone touches.
	useEffect(() => {
		if (week === null) return
		setWeekLeft(MY_WEEK_SECONDS)
		const ticker = window.setInterval(
			() => setWeekLeft((seconds) => Math.max(0, seconds - 1)),
			1000,
		)
		const lock = window.setTimeout(() => {
			setWeek(null)
			onFinish()
		}, MY_WEEK_SECONDS * 1000)
		return () => {
			window.clearInterval(ticker)
			window.clearTimeout(lock)
		}
	}, [week, onFinish])

	// Unread announcements wait a minute with nobody touching, then the screen goes.
	useEffect(() => {
		if (weekOpen || unread.length === 0) return
		const timer = window.setTimeout(onFinish, ANNOUNCEMENT_IDLE_SECONDS * 1000)
		return () => window.clearTimeout(timer)
	}, [weekOpen, unread.length, touched, onFinish])

	const gotIt = useCallback(
		async (id: string) => {
			setBusy(id)
			setError(null)
			try {
				const { readAt } = await api.readAnnouncement(pin, id)
				setAnnouncements((current) =>
					(current ?? []).map((item) =>
						item.id === id ? { ...item, readAt } : item,
					),
				)
			} catch {
				setError(_(msg`That did not save. Try again.`))
			} finally {
				setBusy(null)
			}
		},
		[api, pin, _],
	)

	async function openWeek() {
		setWeekLoading(true)
		setError(null)
		try {
			const result = await api.myWeek(pin)
			if (!live.current) return
			setWeekFirstName(result.firstName)
			setWeek(result.week)
		} catch {
			setError(_(msg`Could not load your week. Try again.`))
		} finally {
			setWeekLoading(false)
		}
	}

	const hours = (minutes: number) => {
		const total = Math.max(0, Math.round(minutes))
		const h = Math.floor(total / 60)
		const m = total % 60
		return m === 0 ? `${h} h` : `${h} h ${m} min`
	}

	if (week) {
		const zone = timeZone ?? week.timeZone
		const range = (a: number, b: number) =>
			new Intl.DateTimeFormat(i18n.locale, {
				weekday: 'short',
				hour: 'numeric',
				minute: '2-digit',
				timeZone: zone,
			}).formatRange(a, b)
		const money =
			week.pay && week.pay.estimateMinor !== null && week.pay.currency
				? new Intl.NumberFormat(i18n.locale, {
						style: 'currency',
						currency: week.pay.currency,
					}).format(week.pay.estimateMinor / 100)
				: null
		return (
			<section
				aria-label={_(msg`My week`)}
				data-testid="station-my-week"
				className="flex w-full flex-col gap-3 text-start"
			>
				<h3 className="text-base font-semibold">
					<Trans>My week, {weekFirstName}</Trans>
				</h3>
				<dl className="flex flex-col gap-2 text-base">
					<div className="flex justify-between gap-3">
						<dt className="text-muted-foreground">
							<Trans>Worked so far</Trans>
						</dt>
						<dd className="tabular-nums">
							<bdi>{hours(week.workedMinutes)}</bdi>
						</dd>
					</div>
					<div className="flex justify-between gap-3">
						<dt className="text-muted-foreground">
							<Trans>Scheduled this week</Trans>
						</dt>
						<dd className="tabular-nums">
							<bdi>{hours(week.scheduledMinutes)}</bdi>
						</dd>
					</div>
					<div className="flex justify-between gap-3">
						<dt className="text-muted-foreground">
							<Trans>Next shift</Trans>
						</dt>
						<dd className="tabular-nums">
							{week.nextShift ? (
								<bdi>
									{range(week.nextShift.startsAt, week.nextShift.endsAt)}
								</bdi>
							) : (
								<Trans>None published</Trans>
							)}
						</dd>
					</div>
					{week.pay ? (
						<div
							className="flex justify-between gap-3"
							data-testid="station-pay"
						>
							<dt className="text-muted-foreground">
								<Trans>Estimate before tax</Trans>
							</dt>
							<dd className="tabular-nums">
								{money ? <bdi dir="ltr">{money}</bdi> : <Trans>Not yet</Trans>}
							</dd>
						</div>
					) : null}
				</dl>
				<p className="text-muted-foreground text-sm" role="timer">
					{plural(weekLeft, {
						one: 'This closes in # second.',
						other: 'This closes in # seconds.',
					})}
				</p>
				<Button
					variant="outline"
					size="lg"
					data-autofocus
					onClick={() => {
						setWeek(null)
						onFinish()
					}}
				>
					<Trans>Close</Trans>
				</Button>
			</section>
		)
	}

	return (
		<div className="flex w-full flex-col gap-3 text-start">
			{unread.map((item) => (
				<section
					key={item.id}
					data-testid="station-announcement"
					className="bg-muted flex flex-col gap-2 rounded-lg p-4"
				>
					<h3 className="text-base font-semibold wrap-anywhere">
						{item.title}
					</h3>
					<p className="text-sm wrap-anywhere whitespace-pre-wrap">
						{item.body}
					</p>
					<Button
						variant="primary"
						size="lg"
						disabled={busy === item.id}
						onClick={() => void gotIt(item.id)}
					>
						<Trans>Got it</Trans>
					</Button>
				</section>
			))}
			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : null}
			<Button
				variant="outline"
				size="lg"
				disabled={weekLoading}
				onClick={() => void openWeek()}
			>
				<Trans>My week</Trans>
			</Button>
		</div>
	)
}
