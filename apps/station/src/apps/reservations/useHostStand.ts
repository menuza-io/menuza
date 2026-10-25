import { type PosReservationsTokenResponse } from '@repo/common/pos-orders'
import { type WaitlistEntry } from '@repo/reservations'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createHostApi, HostApiError, type HostApi } from './api.ts'
import { demoClock, demoHostApi } from './demo.ts'
import { type DayFeed } from './feed.ts'
import { serverNow } from '~/lib/clock.ts'
import { type PosSettings } from '~/lib/config.ts'
import { type Session } from '~/lib/signin.ts'

/** The host stand redraws from the server (the day and the waitlist) this often while it is on screen. */
export const DAY_POLL_MS = 10_000

const ACTIVE_WAITLIST = new Set(['waiting', 'notified', 'on_the_way'])

/** Refusals that are about this person or this till, not about the moment: the stand closes. */
const BLOCKING_CODES = new Set([
	'not_a_host',
	'reservations_not_enabled',
	'reservations_disabled',
	'reservations_needs_location',
	'reservations_needs_sign_in',
	'invalid_device',
	'device_revoked',
])

export const blocksStand = (failure: HostApiError) =>
	failure.needsSignIn || BLOCKING_CODES.has(failure.code)

/**
 * What a failed refresh does to the stand. A floor already on screen stays
 * (marked not up to date) through anything passing: an outage, a rate limit, a
 * flag the server could not read. Only a refusal about the person or the till
 * closes it.
 */
export function afterFailedRefresh(
	previous: HostStandState,
	failure: HostApiError,
): HostStandState {
	if (previous.status === 'ready' && !blocksStand(failure))
		return { ...previous, stale: true }
	return { status: 'blocked', error: failure }
}

/**
 * The day on screen: today is `null` (it follows the server's date, so the stand
 * left open past midnight is on the new today), any other day is its business
 * date. A date that turns out to be today is today.
 */
export const viewDate = (date: string | null, today: string | null) =>
	date !== null && date === today ? null : date

/** Where a day is held while the stand is open: one entry per day, with its ETag. */
export const TODAY_KEY = 'today'
export const dayKey = (date: string | null) => date ?? TODAY_KEY

/**
 * Whether an answer may be drawn: it is for the person still signed in, and for
 * the day still on screen (a slow answer for the day before never paints over
 * the day the host just moved to).
 */
export const mayPaint = (
	answer: { generation: number; date: string | null },
	now: { generation: number; date: string | null },
) => answer.generation === now.generation && answer.date === now.date

export type HostStandState =
	| { status: 'loading' }
	| { status: 'blocked'; error: HostApiError }
	| {
			status: 'ready'
			feed: DayFeed
			/** The day `feed` is for: null is today. It lags `date` while another day loads. */
			feedDate: string | null
			/** Today's business date at the location (known once today has loaded). */
			today: string
			waitlist: WaitlistEntry[]
			grant: PosReservationsTokenResponse
			/** The last refresh failed (offline, an outage); what is shown may be stale. */
			stale: boolean
	  }

/**
 * Loads and keeps the day of service fresh: the day feed (with its ETag, so an
 * unchanged day costs a 304), the waitlist when it is on, and a clock for the
 * timers on the floor. The host may look at another day: that day is read and
 * polled the same way (its own ETag), and everything about seating stays on
 * today. It stops while the page is hidden and when the session ends, and
 * starts again on the next sign-in, always on today.
 *
 * In demo mode the day comes from an in-memory sample (`demo.ts`), with no
 * sign-in or network.
 */
export function useHostStand({
	settings,
	session,
	online,
}: {
	settings: PosSettings
	session: Session | null
	online: boolean
}) {
	const settingsRef = useRef(settings)
	settingsRef.current = settings
	const sessionRef = useRef(session)
	sessionRef.current = session
	const demo = settings.demo
	const api: HostApi = useMemo(
		() =>
			demo
				? demoHostApi()
				: createHostApi({
						settings: () => settingsRef.current,
						session: () => sessionRef.current,
					}),
		[demo],
	)
	const sessionToken = demo ? 'demo' : (session?.serverSession?.token ?? null)
	const [state, setState] = useState<HostStandState>({ status: 'loading' })
	/** The day on screen (null is today) and whether it is today's business date. */
	const [date, setDateState] = useState<string | null>(null)
	const dateRef = useRef<string | null>(null)
	/** Each day the stand has loaded, with its ETag, so a poll can ask "unchanged?". */
	const held = useRef(new Map<string, { feed: DayFeed; etag: string | null }>())
	const todayRef = useRef<string | null>(null)
	/**
	 * Every refresh takes a number; an answer older than one already shown is
	 * dropped, so a slow poll never paints over a change the host just made.
	 */
	const issued = useRef(0)
	const shown = useRef(0)
	/** Bumped when the person changes: answers for the one before are dropped. */
	const generation = useRef(0)
	const polling = useRef(false)
	/**
	 * Bumped when a change starts. A refresh sent before it may answer after
	 * it with the day as it was, so such an answer is dropped.
	 */
	const writes = useRef(0)
	const noteWrite = useCallback(() => {
		writes.current += 1
	}, [])
	/** The server's time (the demo keeps its own). */
	const clock = useCallback(() => (demo ? demoClock() : serverNow()), [demo])
	const [now, setNow] = useState(clock)

	// A new person, a lock: their own token, a clean screen, and today.
	useEffect(() => {
		generation.current += 1
		api.forget()
		held.current.clear()
		todayRef.current = null
		dateRef.current = null
		setDateState(null)
		setState({ status: 'loading' })
	}, [api, sessionToken])

	const loadWaitlist = useCallback(
		async (grant: PosReservationsTokenResponse) => {
			if (!grant.features.waitlist) return []
			const listing = await api.waitlist()
			return listing.entries.filter((e) => ACTIVE_WAITLIST.has(e.status))
		},
		[api],
	)

	const refresh = useCallback(
		async (options: { full?: boolean } = {}): Promise<DayFeed | null> => {
			const ticket = ++issued.current
			const asked = { generation: generation.current, date: dateRef.current }
			const key = dayKey(asked.date)
			const sentAfterWrites = writes.current
			const current = () =>
				mayPaint(asked, {
					generation: generation.current,
					date: dateRef.current,
				}) &&
				ticket > shown.current &&
				sentAfterWrites === writes.current
			const heldNow = () => held.current.get(key)?.feed ?? null
			try {
				const grant = await api.grant()
				// "Unchanged" only means something against a day the stand still holds.
				const have = held.current.get(key)
				const day = await api.day(
					options.full || !have ? undefined : (have.etag ?? undefined),
					asked.date ?? undefined,
				)
				// The waitlist is today's: another day leaves it as it was.
				const waitlist =
					asked.date === null
						? await loadWaitlist(grant).catch(() => null)
						: null
				// A waitlist that did not load is shown as it was, marked not up to date.
				const waitlistStale =
					asked.date === null && grant.features.waitlist && waitlist === null
				// Whatever the answer, the day stays held for the next look.
				if (asked.generation === generation.current && !('unchanged' in day)) {
					held.current.set(key, { feed: day.feed, etag: day.etag })
					if (asked.date === null) todayRef.current = day.feed.businessDate
				}
				if (!current()) return heldNow() ?? null
				shown.current = ticket
				const feed = heldNow()
				if (!feed) return null
				setState((previous) => ({
					status: 'ready',
					feed,
					feedDate: asked.date,
					today:
						asked.date === null
							? feed.businessDate
							: (todayRef.current ??
								(previous.status === 'ready'
									? previous.today
									: feed.businessDate)),
					grant,
					waitlist:
						waitlist ?? (previous.status === 'ready' ? previous.waitlist : []),
					stale: waitlistStale,
				}))
				return feed
			} catch (error) {
				if (!current()) return heldNow()
				const failure =
					error instanceof HostApiError
						? error
						: new HostApiError(0, 'network_unavailable')
				// A closed stand asks for the whole day when it opens again.
				if (blocksStand(failure)) held.current.clear()
				setState((previous) => afterFailedRefresh(previous, failure))
				return heldNow()
			}
		},
		[api, loadWaitlist],
	)

	/** Looks at another day (null is today); the day on screen follows at once if it is held. */
	const setDate = useCallback(
		(next: string | null) => {
			const target = viewDate(next, todayRef.current)
			if (target === dateRef.current) return
			dateRef.current = target
			setDateState(target)
			const cached = held.current.get(dayKey(target))
			if (cached)
				setState((previous) =>
					previous.status === 'ready'
						? { ...previous, feed: cached.feed, feedDate: target }
						: previous,
				)
			void refresh({ full: !cached })
		},
		[refresh],
	)

	/** A timed look: skipped while the previous one is still out. */
	const poll = useCallback(async () => {
		if (polling.current || document.visibilityState !== 'visible') return
		polling.current = true
		try {
			await refresh()
		} finally {
			polling.current = false
		}
	}, [refresh])

	useEffect(() => {
		if (!sessionToken) {
			setState({
				status: 'blocked',
				error: new HostApiError(401, 'staff_session_required'),
			})
			return
		}
		void refresh()
		const dayTimer = window.setInterval(() => void poll(), DAY_POLL_MS)
		const onVisible = () => void poll()
		document.addEventListener('visibilitychange', onVisible)
		return () => {
			window.clearInterval(dayTimer)
			document.removeEventListener('visibilitychange', onVisible)
		}
	}, [sessionToken, refresh, poll])

	// Coming back online, look again at once (the first load is the effect above's).
	const wasOnline = useRef(online)
	useEffect(() => {
		const cameBack = online && !wasOnline.current
		wasOnline.current = online
		if (cameBack && sessionToken) void refresh()
	}, [online, sessionToken, refresh])

	// Lateness and waits count in the server's time, like the clock does.
	useEffect(() => {
		const timer = window.setInterval(() => setNow(clock()), 30_000)
		return () => window.clearInterval(timer)
	}, [clock])

	return { state, api, refresh, now, clock, noteWrite, date, setDate }
}
