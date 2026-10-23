import { type PosReservationsTokenResponse } from '@repo/common/pos-orders'
import { type WaitlistEntry } from '@repo/reservations'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createHostApi, HostApiError, type HostApi } from './api.ts'
import { type DayFeed } from './feed.ts'
import { type PosSettings } from '~/lib/config.ts'
import { type Session } from '~/lib/signin.ts'

/** The host stand redraws from the server this often while it is on screen. */
export const DAY_POLL_MS = 10_000
const WAITLIST_POLL_MS = 15_000

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
	const [now, setNow] = useState(() => Date.now())

	// A new person, a lock: their own token and a clean screen.
	useEffect(() => {
		api.forget()
		etag.current = null
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
		async (options: { full?: boolean } = {}) => {
			try {
				const grant = await api.grant()
				const day = await api.day(
					options.full ? undefined : (etag.current ?? undefined),
				)
				const waitlist = await loadWaitlist(grant).catch(() => null)
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
			} catch (error) {
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
			}
		},
		[api, loadWaitlist],
	)

	useEffect(() => {
		if (!sessionToken) {
			setState({
				status: 'blocked',
				error: new HostApiError(401, 'staff_session_required'),
			})
			return
		}
		void refresh()
		let dayTimer = 0
		const tick = () => {
			if (document.visibilityState === 'visible') void refresh()
		}
		dayTimer = window.setInterval(tick, DAY_POLL_MS)
		const onVisible = () => {
			if (document.visibilityState === 'visible') void refresh()
		}
		document.addEventListener('visibilitychange', onVisible)
		return () => {
			window.clearInterval(dayTimer)
			document.removeEventListener('visibilitychange', onVisible)
		}
	}, [sessionToken, refresh])

	// The waitlist's quoted waits move even when the day does not.
	const liveGrant = state.status === 'ready' ? state.grant : null
	useEffect(() => {
		if (!liveGrant?.features.waitlist) return
		const timer = window.setInterval(() => {
			if (document.visibilityState !== 'visible') return
			void loadWaitlist(liveGrant).then(
				(waitlist) =>
					setState((previous) =>
						previous.status === 'ready' ? { ...previous, waitlist } : previous,
					),
				() => {},
			)
		}, WAITLIST_POLL_MS)
		return () => window.clearInterval(timer)
	}, [liveGrant, loadWaitlist])

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
