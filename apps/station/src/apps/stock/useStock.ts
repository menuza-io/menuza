import {
	STATION_CATALOG_REFRESH_MS,
	type StationCatalog,
} from '@repo/inventory'
import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type StockApi } from './api.ts'
import { isStale, refreshCatalog } from './catalog.ts'
import { loadCachedCatalog, stockOrigin, type CachedCatalog } from './local.ts'
import { stockStats, type StockContext, type StockQueueStats } from './queue.ts'
import { useStockSync, type StockSyncState } from './runner.ts'
import { stockApiFor, syncStock } from './sync.ts'
import { type PosSettings } from '~/lib/config.ts'
import { type Session } from '~/lib/signin.ts'

/** How often the outbox tries again while a Stock screen is open (the till's own sync runs too). */
const SYNC_EVERY_MS = 15_000

export type StockState = {
	api: StockApi
	origin: string
	/** Null when the terminal has no location (Stock needs one). */
	ctx: StockContext | null
	role: Session['role'] | null
	staffName: string | null
	catalog: StationCatalog | null
	/** The catalogue is still being read from this tablet. */
	loading: boolean
	/** When the server last said the copy is current, or null with no copy. */
	checkedAt: number | null
	/** The copy was last confirmed current more than 24 hours ago. */
	stale: boolean
	/** Why the last refresh failed (a code), while the copy on the tablet is what is shown. */
	refreshError: string | null
	refresh: () => Promise<void>
	stats: StockQueueStats
	syncState: StockSyncState
	/** Sends what is waiting now (`force`: ignore the backoff). */
	sync: (force?: boolean) => Promise<void>
	/** Online, or in demo mode (which needs no connection). */
	reachable: boolean
	/** Signed in with a connection once, so the server can vouch for what this tablet sends. */
	hasSession: boolean
}

/**
 * Everything a Stock screen needs: the catalogue (from the tablet at once,
 * refreshed every five minutes and on focus), the outbox's size and state,
 * and the person acting. Used by the Stock app and by Kitchen's waste sheet.
 */
export function useStock(
	settings: PosSettings,
	session: Session | null,
	online: boolean,
): StockState {
	const origin = stockOrigin(settings)
	const locationId = settings.locationId
	const demo = settings.demo
	const token = session?.serverSession?.token ?? null
	// `session` objects change identity; what matters is who and which token.
	const sessionRef = useRef(session)
	sessionRef.current = session
	const api = useMemo(
		() => stockApiFor(settings, sessionRef.current),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[settings.demo, settings.tenantApiUrl, settings.deviceToken, token],
	)
	const [cached, setCached] = useState<CachedCatalog | null>(null)
	const [loading, setLoading] = useState(true)
	const [refreshError, setRefreshError] = useState<string | null>(null)
	const hasSession = demo || token !== null
	const reachable = online || demo

	useEffect(() => {
		let alive = true
		setLoading(true)
		setCached(null)
		if (!locationId) {
			setLoading(false)
			return
		}
		void loadCachedCatalog(origin, locationId)
			.then((found) => {
				if (alive && found) setCached(found)
			})
			.catch(() => {})
			.finally(() => {
				if (alive) setLoading(false)
			})
		return () => {
			alive = false
		}
	}, [origin, locationId])

	const refreshing = useRef(false)
	const refresh = useCallback(async () => {
		if (!locationId || !reachable || !hasSession || refreshing.current) return
		refreshing.current = true
		try {
			const result = await refreshCatalog(api, origin, locationId)
			if (result.kind === 'failed') setRefreshError(result.code)
			else {
				setRefreshError(null)
				setCached(result.cached)
			}
		} finally {
			refreshing.current = false
		}
	}, [api, origin, locationId, reachable, hasSession])

	useEffect(() => {
		void refresh()
		const timer = window.setInterval(() => {
			if (document.visibilityState === 'visible') void refresh()
		}, STATION_CATALOG_REFRESH_MS)
		const wake = () => {
			if (document.visibilityState === 'visible') void refresh()
		}
		document.addEventListener('visibilitychange', wake)
		window.addEventListener('focus', wake)
		return () => {
			window.clearInterval(timer)
			document.removeEventListener('visibilitychange', wake)
			window.removeEventListener('focus', wake)
		}
	}, [refresh])

	const stats = useLiveQuery(() => stockStats(origin), [origin], {
		waiting: 0,
		failed: 0,
	})
	const syncState = useStockSync()

	const sync = useCallback(
		async (force = false) => {
			await syncStock(settings, sessionRef.current, online, { force }).catch(
				() => null,
			)
		},
		[settings, online],
	)
	useEffect(() => {
		void sync()
		const timer = window.setInterval(() => void sync(), SYNC_EVERY_MS)
		return () => window.clearInterval(timer)
	}, [sync, token])

	const ctx = useMemo<StockContext | null>(
		() =>
			locationId
				? { origin, locationId, madeBy: session?.staff.id ?? null }
				: null,
		[origin, locationId, session?.staff.id],
	)

	return {
		api,
		origin,
		ctx,
		role: session?.role ?? null,
		staffName: session?.staff.name ?? null,
		catalog: cached?.catalog ?? null,
		loading,
		checkedAt: cached?.checkedAt ?? null,
		stale: cached ? isStale(cached.checkedAt) : false,
		refreshError,
		refresh,
		stats,
		syncState,
		sync,
		reachable,
		hasSession,
	}
}
