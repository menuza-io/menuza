import { alertCopy, alertLocale } from '@repo/common/operator-alert-copy'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
	activeItems,
	dismissOrder,
	EMPTY_TRACKER,
	NEW_ORDER_REPEAT_MS,
	stepTracker,
	titleWithCount,
	type AlertTracker,
	type OrderAlertItem,
} from '#app/utils/orders/new-order-alerts.ts'
import {
	type Order,
	WAITING_ORDER_STATUS,
} from '#app/utils/orders/order-model.ts'
import {
	chimePlayer,
	playChime,
	playSample,
	readSoundPrefs,
	unlockChime,
	writeSoundPrefs,
	type OrderSoundPrefs,
} from '#app/utils/orders/waiting-chime.ts'

/** The alert text of an item: a number, a type, a time and a total; no guest. */
export function alertText(
	item: OrderAlertItem,
	locale: string,
	timeZone: string | null,
) {
	const copy = alertCopy(item.subject, {
		locale: alertLocale(locale),
		timeZone,
	})
	return { title: copy.title, body: copy.body }
}

type NotificationApi = {
	permission: NotificationPermission
	requestPermission: () => Promise<NotificationPermission>
}

function notificationApi(): NotificationApi | null {
	return typeof Notification === 'undefined'
		? null
		: (Notification as unknown as NotificationApi)
}

/**
 * The Orders page's new-order alert (#265): when a new online order shows up in
 * the 15-second refresh it chimes (and repeats every 30 seconds until the order
 * is opened or accepted), shows a banner, puts the count in the tab title and,
 * with permission and the tab in the background, shows a desktop notification.
 * A scheduled order is told once, softly, when placed, and again loudly at its
 * time. Nothing here reads a guest: only the order number, type, time, total and
 * dish count. No new connection: it works off the list the page already loads.
 */
export function useNewOrderAlerts(input: {
	orders: readonly Order[]
	loading: boolean
	locale: string
	/** Called with each new alert's order id when a page wants to react. */
	onCreated?: (item: OrderAlertItem) => void
}) {
	const { orders, loading, locale } = input
	const tracker = useRef<AlertTracker>(EMPTY_TRACKER)
	const [items, setItems] = useState<OrderAlertItem[]>([])
	const [prefs, setPrefsState] = useState<OrderSoundPrefs>(() =>
		typeof window === 'undefined'
			? { enabled: false, volume: 0.8, sound: 'chime', promptAnswered: true }
			: readSoundPrefs(),
	)
	const [soundState, setSoundState] = useState<
		'running' | 'blocked' | 'unsupported'
	>('blocked')
	const [permission, setPermission] = useState<
		NotificationPermission | 'unsupported'
	>(() => notificationApi()?.permission ?? 'unsupported')
	const ordersRef = useRef(orders)
	ordersRef.current = orders
	const onCreated = useRef(input.onCreated)
	onCreated.current = input.onCreated

	useEffect(() => {
		setPrefsState(readSoundPrefs())
	}, [])

	const announce = useCallback(
		(created: OrderAlertItem[]) => {
			for (const item of created) {
				onCreated.current?.(item)
				// Orders waiting for acceptance are chimed by the "Waiting for you"
				// lane; this keeps one sound for them, and a softer one for a later order.
				if (readSoundPrefs().enabled) {
					if (item.kind === 'scheduled') playChime({ soft: true })
					else if (item.startedStatus !== WAITING_ORDER_STATUS) playChime()
				}
				const api = notificationApi()
				if (
					api?.permission === 'granted' &&
					typeof document !== 'undefined' &&
					document.visibilityState === 'hidden'
				) {
					const text = alertText(
						item,
						locale,
						ordersRef.current.find((o) => o.id === item.orderId)?.timeZone ??
							null,
					)
					try {
						new Notification(text.title, { body: text.body, tag: item.orderId })
					} catch {
						// A browser that refuses (iOS Safari): the banner and sound remain.
					}
				}
			}
		},
		[locale],
	)

	const run = useCallback(() => {
		const { next, created } = stepTracker(
			tracker.current,
			ordersRef.current,
			Date.now(),
		)
		tracker.current = next
		setItems([...next.items.values()])
		if (created.length > 0) announce(created)
	}, [announce])

	// New orders arrive with the page's own refresh. The first list only primes.
	useEffect(() => {
		if (loading) return
		run()
	}, [orders, loading, run])

	// A scheduled order's time comes between refreshes.
	useEffect(() => {
		const timer = window.setInterval(() => {
			if (!loading) run()
			setSoundState(chimePlayer.state())
		}, 5_000)
		return () => window.clearInterval(timer)
	}, [loading, run])

	const repeating = useMemo(
		() =>
			activeItems({
				...tracker.current,
				items: new Map(items.map((i) => [i.orderId, i])),
			}).filter((item) => item.startedStatus !== WAITING_ORDER_STATUS),
		[items],
	)
	const hasRepeating = repeating.length > 0

	// The sound repeats every 30 seconds until every such order is opened or accepted.
	useEffect(() => {
		if (!hasRepeating || !prefs.enabled) return
		const timer = window.setInterval(() => playChime(), NEW_ORDER_REPEAT_MS)
		return () => window.clearInterval(timer)
	}, [hasRepeating, prefs.enabled])

	// "(2) Orders": the count of orders that need someone now.
	const activeCount = useMemo(
		() => items.filter((item) => item.kind !== 'scheduled').length,
		[items],
	)
	useEffect(() => {
		const base = document.title
		document.title = titleWithCount(base, activeCount)
		return () => {
			document.title = titleWithCount(document.title, 0)
		}
	}, [activeCount])

	// A tap anywhere lets the browser play sound once the member turned it on.
	useEffect(() => {
		if (!prefs.enabled) return
		const unlock = () => {
			unlockChime()
			setSoundState(chimePlayer.state())
		}
		unlock()
		document.addEventListener('pointerdown', unlock)
		document.addEventListener('keydown', unlock)
		return () => {
			document.removeEventListener('pointerdown', unlock)
			document.removeEventListener('keydown', unlock)
		}
	}, [prefs.enabled])

	const dismiss = useCallback((orderId: string) => {
		tracker.current = dismissOrder(tracker.current, orderId)
		setItems([...tracker.current.items.values()])
	}, [])

	const setPrefs = useCallback((patch: Partial<OrderSoundPrefs>) => {
		setPrefsState(writeSoundPrefs(patch))
		if (patch.enabled) {
			unlockChime()
			setSoundState(chimePlayer.state())
		}
	}, [])

	const test = useCallback(() => {
		// The tap that primes the audio, then the sound as chosen.
		unlockChime()
		const current = readSoundPrefs()
		const played = playSample(current.sound, current.volume)
		setSoundState(chimePlayer.state())
		return played
	}, [])

	const requestPermission = useCallback(async () => {
		const api = notificationApi()
		if (!api) return 'unsupported' as const
		const result = await api.requestPermission()
		setPermission(result)
		return result
	}, [])

	return {
		items,
		activeCount,
		dismiss,
		prefs,
		setPrefs,
		test,
		permission,
		requestPermission,
		/** The member turned sound on but the browser has not allowed it yet. */
		soundBlocked: prefs.enabled && soundState !== 'running',
		soundUnsupported: soundState === 'unsupported',
	}
}
