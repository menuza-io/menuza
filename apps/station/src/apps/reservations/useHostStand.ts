import { type PosReservationsTokenResponse } from '@repo/common/pos-orders'
import { type WaitlistEntry } from '@repo/reservations'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createHostApi, HostApiError, type HostApi } from './api.ts'
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

export type HostStandState =
	| { status: 'loading' }
	| { status: 'blocked'; error: HostApiError }
	| {
			status: 'ready'
			feed: DayFeed
			waitlist: WaitlistEntry[]
			grant: PosReservationsTokenResponse
			/** The last refresh failed (offline, an outage); what is shown may be stale. */
			stale: boolean
	  }

/**
 * Loads and keeps the day of service fresh: the day feed (with its ETag, so an
 * unchanged day costs a 304), the waitlist when it is on, and a clock for the
 * timers on the floor. It stops while the page is hidden and when the session
 * ends, and starts again on the next sign-in.
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
	const api: HostApi = useMemo(
		() =>
			createHostApi({
				settings: () => settingsRef.current,
				session: () => sessionRef.current,
			}),
		[],
	)
	const sessionToken = session?.serverSession?.token ?? null
	const [state, setState] = useState<HostStandState>({ status: 'loading' })
	const etag = useRef<string | null>(null)
	/** The newest day the stand holds, so a caller can look again right after a refresh. */
	const latest = useRef<DayFeed | null>(null)
	/**
	 * Every refresh takes a number; an answer older than one already shown is
	 * dropped, so a slow poll never paints over a change the host just made.
	 */
	const issued = useRef(0)
	const shown = useRef(0)
	/** Bumped when the person changes: answers for the one before are dropped. */
	const generation = useRef(0)
	const polling = useRef(false)
	const [now, setNow] = useState(() => serverNow())

	// A new person, a lock: their own token and a clean screen.
	useEffect(() => {
		generation.current += 1
		api.forget()
		etag.current = null
		latest.current = null
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
			const forGeneration = generation.current
			const current = () =>
				forGeneration === generation.current && ticket > shown.current
			try {
				const grant = await api.grant()
				// "Unchanged" only means something against a day the stand still holds.
				const day = await api.day(
					options.full || !latest.current
						? undefined
						: (etag.current ?? undefined),
				)
				const waitlist = await loadWaitlist(grant).catch(() => null)
				if (!current()) return latest.current
				shown.current = ticket
				if (!('unchanged' in day)) latest.current = day.feed
				const held = latest.current
				setState((previous) => {
					if ('unchanged' in day) {
						if (previous.status !== 'ready')
							return held
								? {
										status: 'ready',
										feed: held,
										grant,
										waitlist: waitlist ?? [],
										stale: false,
									}
								: previous
						return {
							...previous,
							grant,
							waitlist: waitlist ?? previous.waitlist,
							stale: false,
						}
					}
					etag.current = day.etag
					return {
						status: 'ready',
						feed: day.feed,
						grant,
						waitlist:
							waitlist ??
							(previous.status === 'ready' ? previous.waitlist : []),
						stale: false,
					}
				})
				return latest.current
			} catch (error) {
				if (!current()) return latest.current
				const failure =
					error instanceof HostApiError
						? error
						: new HostApiError(0, 'network_unavailable')
				// A closed stand asks for the whole day when it opens again.
				if (blocksStand(failure)) {
					etag.current = null
					latest.current = null
				}
				setState((previous) => afterFailedRefresh(previous, failure))
				return latest.current
			}
		},
		[api, loadWaitlist],
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
		const timer = window.setInterval(() => setNow(serverNow()), 30_000)
		return () => window.clearInterval(timer)
	}, [])

	return { state, api, refresh, now }
}
