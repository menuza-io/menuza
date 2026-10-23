import { type PosReservationsTokenResponse } from '@repo/common/pos-orders'
import { type WaitlistEntry } from '@repo/reservations'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createHostApi, HostApiError, type HostApi } from './api.ts'
import { type DayFeed } from './feed.ts'
import { type PosSettings } from '~/lib/config.ts'
import { type Session } from '~/lib/signin.ts'

/** The host stand redraws from the server (the day and the waitlist) this often while it is on screen. */
export const DAY_POLL_MS = 10_000

const ACTIVE_WAITLIST = new Set(['waiting', 'notified', 'on_the_way'])

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
	const [now, setNow] = useState(() => Date.now())

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
				const day = await api.day(
					options.full ? undefined : (etag.current ?? undefined),
				)
				const waitlist = await loadWaitlist(grant).catch(() => null)
				if (!current()) return latest.current
				shown.current = ticket
				if (!('unchanged' in day)) latest.current = day.feed
				setState((previous) => {
					if ('unchanged' in day) {
						if (previous.status !== 'ready') return previous
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
				setState((previous) =>
					previous.status === 'ready' &&
					(failure.offline || failure.status >= 500)
						? { ...previous, stale: true }
						: { status: 'blocked', error: failure },
				)
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

	// Coming back online, look again at once.
	useEffect(() => {
		if (online && sessionToken) void refresh()
	}, [online, sessionToken, refresh])

	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 30_000)
		return () => window.clearInterval(timer)
	}, [])

	return { state, api, refresh, now }
}
