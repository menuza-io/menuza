import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
	createKioskApi,
	KioskApiError,
	KioskNetworkError,
	type KioskApi,
} from '#app/utils/kiosk/kiosk-api.ts'
import {
	clearKioskDevice,
	loadKioskDevice,
	saveKioskDevice,
	type StoredKioskDevice,
} from '#app/utils/kiosk/kiosk-device.ts'
import {
	pairKiosk,
	type TenantApiUrls,
} from '#app/utils/kiosk/kiosk-pair-client.ts'
import {
	createKioskQueue,
	type EnqueueInput,
	type KioskQueue,
} from '#app/utils/kiosk/kiosk-queue.ts'
import { syncBackoffMs, syncQueue } from '#app/utils/kiosk/kiosk-sync.ts'

export type { TenantApiUrls }

const HEARTBEAT_MS = 60_000
const SYNC_RETRY_FLOOR_MS = 15_000
const SYNCED_FLASH_MS = 4_000
/**
 * `invalid_device` also answers when the regional node briefly cannot open the
 * organization's database, so a tablet only forgets its pairing after hearing
 * it this many times in a row (a manager's removal, `device_revoked`, is
 * believed at once).
 */
const GONE_CONFIRMATIONS = 3
/** Strikes closer together than this are one outage, not separate confirmations. */
const GONE_STRIKE_SPACING_MS = 20_000

export type SyncIndicator = 'idle' | 'syncing' | 'synced'

export type PairOutcome =
	{ ok: true } | { ok: false; code: string; retryAfterSeconds?: number }

/**
 * Everything the tablet does that is not a screen: it remembers the pairing,
 * checks in with the server every minute (so a manager sees "last seen" and a
 * removed tablet finds out), keeps the offline queue, and sends queued punches
 * as soon as the server can be reached, backing off when it cannot.
 */
export function useKioskRuntime(urls: TenantApiUrls) {
	const [hydrated, setHydrated] = useState(false)
	const [device, setDevice] = useState<StoredKioskDevice | null>(null)
	const [online, setOnline] = useState(true)
	const [counts, setCounts] = useState({ queued: 0, failed: 0 })
	const [indicator, setIndicator] = useState<SyncIndicator>('idle')
	const [serverOffset, setServerOffset] = useState(0)
	const [removed, setRemoved] = useState(false)

	const queue: KioskQueue = useMemo(() => createKioskQueue(), [])
	// Keyed on the credentials, not the whole device record: a config refresh
	// must not rebuild the client and restart the heartbeat.
	const deviceSecret = device?.deviceSecret ?? null
	const tenantApiUrl = device?.tenantApiUrl ?? null
	const api: KioskApi | null = useMemo(
		() =>
			deviceSecret && tenantApiUrl
				? createKioskApi({ tenantApiUrl, deviceSecret })
				: null,
		[deviceSecret, tenantApiUrl],
	)

	const syncing = useRef(false)
	const failures = useRef(0)
	const goneStrikes = useRef(0)
	const lastStrikeAt = useRef(0)
	const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

	const refreshCounts = useCallback(async () => {
		try {
			setCounts(await queue.counts())
		} catch {
			// a broken IndexedDB must never take the clock down
		}
	}, [queue])

	const handleRemoved = useCallback(async () => {
		clearKioskDevice()
		try {
			await queue.wipe()
		} catch {
			// nothing more to do
		}
		setDevice(null)
		setRemoved(true)
		await refreshCounts()
	}, [queue, refreshCounts])

	/** Whether a "device gone" answer is believed yet; counts strikes. */
	const confirmGone = useCallback((code: string | undefined) => {
		if (code === 'device_revoked') return true
		const at = Date.now()
		if (at - lastStrikeAt.current >= GONE_STRIKE_SPACING_MS) {
			goneStrikes.current += 1
			lastStrikeAt.current = at
		}
		return goneStrikes.current >= GONE_CONFIRMATIONS
	}, [])

	const sync = useCallback(async () => {
		if (!api || syncing.current) return
		syncing.current = true
		try {
			const pending = await queue
				.counts()
				.catch(() => ({ queued: 0, failed: 0 }))
			if (pending.queued === 0) return
			setIndicator('syncing')
			const outcome = await syncQueue({ queue, api })
			await refreshCounts()
			if (outcome.deviceGone && confirmGone(outcome.deviceGoneCode)) {
				await handleRemoved()
				return
			}
			if (!outcome.deviceGone) goneStrikes.current = 0
			if (outcome.synced > 0) {
				failures.current = 0
				setOnline(true)
				setIndicator('synced')
				if (flashTimer.current) clearTimeout(flashTimer.current)
				flashTimer.current = setTimeout(
					() => setIndicator('idle'),
					SYNCED_FLASH_MS,
				)
			} else {
				setIndicator('idle')
			}
			if (outcome.remaining > 0) {
				// Something is still waiting: try again, later and later.
				failures.current += 1
				const wait = Math.max(
					SYNC_RETRY_FLOOR_MS,
					(outcome.retryAfterSeconds ?? 0) * 1000,
					syncBackoffMs(failures.current),
				)
				if (retryTimer.current) clearTimeout(retryTimer.current)
				retryTimer.current = setTimeout(() => void sync(), wait)
			}
		} finally {
			syncing.current = false
		}
	}, [api, queue, refreshCounts, handleRemoved, confirmGone])

	// Mount: read the saved pairing, then the queue.
	useEffect(() => {
		setDevice(loadKioskDevice())
		setOnline(typeof navigator === 'undefined' ? true : navigator.onLine)
		setHydrated(true)
		void refreshCounts()
	}, [refreshCounts])

	// Browser connectivity hints. They are hints: a request failing is the truth.
	useEffect(() => {
		function goOnline() {
			setOnline(true)
			void sync()
		}
		function goOffline() {
			setOnline(false)
		}
		window.addEventListener('online', goOnline)
		window.addEventListener('offline', goOffline)
		return () => {
			window.removeEventListener('online', goOnline)
			window.removeEventListener('offline', goOffline)
		}
	}, [sync])

	// Check in every minute: refreshes "last seen" for managers, picks up a
	// renamed tablet, learns that this one was removed, and drains the queue.
	useEffect(() => {
		if (!api) return
		let live = true
		async function beat() {
			try {
				const config = await api!.config()
				if (!live) return
				setOnline(true)
				goneStrikes.current = 0
				setServerOffset(config.serverNow - Date.now())
				setDevice((current) => {
					if (!current) return current
					const fresh = { device: config.device, scope: config.scope }
					if (JSON.stringify(fresh) === JSON.stringify(current.config)) {
						return current
					}
					const next = { ...current, config: fresh }
					saveKioskDevice(next)
					return next
				})
				void sync()
			} catch (error) {
				if (!live) return
				if (error instanceof KioskNetworkError) setOnline(false)
				else if (
					error instanceof KioskApiError &&
					error.deviceGone &&
					confirmGone(error.code)
				) {
					await handleRemoved()
				}
			}
		}
		void beat()
		const timer = setInterval(() => void beat(), HEARTBEAT_MS)
		return () => {
			live = false
			clearInterval(timer)
		}
	}, [api, sync, handleRemoved, confirmGone])

	useEffect(
		() => () => {
			if (retryTimer.current) clearTimeout(retryTimer.current)
			if (flashTimer.current) clearTimeout(flashTimer.current)
		},
		[],
	)

	// Keep the screen awake while the clock is the point of the tablet.
	useEffect(() => {
		if (!device || !('wakeLock' in navigator)) return
		let lock: WakeLockSentinel | null = null
		let live = true
		async function request() {
			try {
				lock = await navigator.wakeLock.request('screen')
			} catch {
				// not allowed right now (battery saver, hidden tab)
			}
		}
		function onVisibility() {
			if (document.visibilityState === 'visible' && live) void request()
		}
		void request()
		document.addEventListener('visibilitychange', onVisibility)
		return () => {
			live = false
			document.removeEventListener('visibilitychange', onVisibility)
			void lock?.release().catch(() => undefined)
		}
	}, [device])

	/** Saves a punch on the tablet and starts sending it. */
	const enqueue = useCallback(
		async (input: EnqueueInput) => {
			await queue.enqueue(input)
			await refreshCounts()
			void sync()
		},
		[queue, refreshCounts, sync],
	)

	/** Pairs with a one-time code (see `pairKiosk`) and starts using the result. */
	const pair = useCallback(
		async (code: string, region?: 'us' | 'ksa'): Promise<PairOutcome> => {
			const result = await pairKiosk(urls, code, region)
			if (!result.ok) return result
			setServerOffset(result.serverNow - Date.now())
			setRemoved(false)
			setDevice(result.device)
			return { ok: true }
		},
		[urls],
	)

	return {
		hydrated,
		device,
		api,
		online,
		counts,
		indicator,
		serverOffset,
		removed,
		queueSupported: queue.supported,
		queue,
		enqueue,
		pair,
		sync,
		refreshCounts,
		markOffline: () => setOnline(false),
		markOnline: () => setOnline(true),
		noteServerTime: (serverNow: number) =>
			setServerOffset(serverNow - Date.now()),
	}
}

export type KioskRuntime = ReturnType<typeof useKioskRuntime>
