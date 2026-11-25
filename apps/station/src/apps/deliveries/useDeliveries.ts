import { type DeliveryBoard } from '@repo/common/delivery-runs'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DeliveriesError, createDeliveriesApi, type DeliveriesApi, type DeliveriesMe } from './api.ts'
import { type PosSettings } from '~/lib/config.ts'
import { type Session } from '~/lib/signin.ts'

export const DELIVERIES_REFRESH_MS = 15_000

export type DeliveriesState = {
	api: DeliveriesApi
	me: DeliveriesMe | null
	/** The manager's board; null for a driver who is not a manager. */
	board: DeliveryBoard | null
	error: string | null
	busy: boolean
	/** Notices the region told this device once; kept on screen until dismissed. */
	notices: DeliveriesMe['notices']
	dismissNotices: () => void
	refresh: () => Promise<void>
	/** Runs one action, then reads the run back (also after a failure). */
	act: (action: () => Promise<void>) => Promise<boolean>
}

/**
 * The Deliveries screen's data: who the signed-in person is (`/me`) and, for a
 * manager, the board. Polls while the tab is visible; a hidden tab reads again
 * when it returns.
 */
export function useDeliveries(
	settings: PosSettings,
	session: Session | null,
	reachable: boolean,
	api: DeliveriesApi | null = null,
): DeliveriesState {
	const real = useMemo(
		() => api ?? createDeliveriesApi(settings, session),
		[api, settings, session],
	)
	const [me, setMe] = useState<DeliveriesMe | null>(null)
	const [board, setBoard] = useState<DeliveryBoard | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [notices, setNotices] = useState<DeliveriesMe['notices']>([])
	const alive = useRef(true)

	const refresh = useCallback(async () => {
		if (!session) return
		try {
			const next = await real.me()
			if (!alive.current) return
			setMe(next)
			// Notices are read once by the region: keep them until the person closes them.
			if (next.notices.length > 0) {
				setNotices((current) => [...current, ...next.notices])
			}
			setBoard(next.role === 'manager' ? await real.board() : null)
			setError(null)
		} catch (failure) {
			if (!alive.current) return
			setError(failure instanceof DeliveriesError ? failure.code : 'connection_lost')
		}
	}, [real, session])

	useEffect(() => {
		alive.current = true
		if (!reachable) return
		void refresh()
		const timer = window.setInterval(() => {
			if (document.visibilityState === 'visible') void refresh()
		}, DELIVERIES_REFRESH_MS)
		const onVisible = () => {
			if (document.visibilityState === 'visible') void refresh()
		}
		document.addEventListener('visibilitychange', onVisible)
		return () => {
			alive.current = false
			window.clearInterval(timer)
			document.removeEventListener('visibilitychange', onVisible)
		}
	}, [refresh, reachable])

	const act = useCallback(
		async (action: () => Promise<void>) => {
			setBusy(true)
			let failedWith: string | null = null
			try {
				await action()
				setError(null)
			} catch (failure) {
				failedWith =
					failure instanceof DeliveriesError ? failure.code : 'connection_lost'
			} finally {
				// Read the run back whether it worked or not: the region has the truth.
				await refresh().catch(() => undefined)
				// The read must not hide why the action failed.
				if (alive.current) {
					if (failedWith) setError(failedWith)
					setBusy(false)
				}
			}
			return failedWith === null
		},
		[refresh],
	)

	return {
		api: real,
		me,
		board,
		error,
		busy,
		notices,
		dismissNotices: () => setNotices([]),
		refresh,
		act,
	}
}
