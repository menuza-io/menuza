import { type KdsCommand, type KdsConfig, type KdsFeed } from '@repo/common/kds'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createKitchenApi, KitchenError } from './api.ts'
import { demoKitchen } from './demo.ts'
import { type PosSettings } from '~/lib/config.ts'
import { type Session } from '~/lib/signin.ts'

export function useKitchen(
	settings: PosSettings,
	session: Session | null,
	online: boolean,
) {
	// Demo mode's kitchen answers on this tablet, so it needs no pairing or network.
	const api = useMemo(
		() => (settings.demo ? demoKitchen : createKitchenApi(settings, session)),
		[settings, session],
	)
	const [feed, setFeed] = useState<KdsFeed | null>(null)
	// Reading the board failed (stale) versus a tap that was refused: a conflict
	// says so, but the board it just reloaded stays live.
	const [error, setError] = useState<KitchenError | null>(null)
	const [actionError, setActionError] = useState<KitchenError | null>(null)
	const [busy, setBusy] = useState(false)
	const [receivedAt, setReceivedAt] = useState(0)
	const [now, setNow] = useState(Date.now)
	const writing = useRef(false)
	const generation = useRef(0)
	const sequence = useRef(0)
	const reading = useRef<number | null>(null)
	const offset = useRef(0)

	const accept = useCallback((data: KdsFeed) => {
		offset.current = data.serverNow - Date.now()
		setFeed(data)
		setReceivedAt(Date.now())
		setNow(data.serverNow)
		setError(null)
	}, [])
	const refuse = useCallback((value: unknown) => {
		const failure =
			value instanceof KitchenError
				? value
				: new KitchenError('kitchen_unavailable')
		setError(failure)
		if (failure.status === 401 || failure.status === 403) setFeed(null)
	}, [])
	const refresh = useCallback(async () => {
		if (!online || writing.current || reading.current !== null) return
		const gen = generation.current
		const seq = ++sequence.current
		reading.current = seq
		try {
			const data = await api.feed()
			if (gen === generation.current && seq === sequence.current) accept(data)
		} catch (failure) {
			if (gen === generation.current && seq === sequence.current)
				refuse(failure)
		} finally {
			if (reading.current === seq) reading.current = null
		}
	}, [online, api, accept, refuse])

	useEffect(() => {
		const gen = ++generation.current
		setFeed(null)
		setError(null)
		setReceivedAt(0)
		reading.current = null
		return () => {
			generation.current = gen + 1
		}
	}, [api])
	useEffect(() => {
		void refresh()
		const poll = window.setInterval(() => {
			if (document.visibilityState === 'visible') void refresh()
		}, 5_000)
		const visible = () => {
			if (document.visibilityState === 'visible') void refresh()
		}
		document.addEventListener('visibilitychange', visible)
		return () => {
			window.clearInterval(poll)
			document.removeEventListener('visibilitychange', visible)
		}
	}, [refresh])
	useEffect(() => {
		const timer = window.setInterval(
			() => setNow(Date.now() + offset.current),
			1_000,
		)
		return () => window.clearInterval(timer)
	}, [])

	// A refused tap's message stays a moment, then goes; the next tap clears it.
	useEffect(() => {
		if (!actionError) return
		const timer = window.setTimeout(() => setActionError(null), 8_000)
		return () => window.clearTimeout(timer)
	}, [actionError])

	const write = useCallback(
		async (send: () => Promise<KdsFeed>) => {
			if (writing.current || !online) return false
			writing.current = true
			setActionError(null)
			setBusy(true)
			++sequence.current // An earlier poll must never overwrite the write's answer.
			const gen = generation.current
			try {
				const data = await send()
				if (gen === generation.current) accept(data)
				return true
			} catch (failure) {
				if (gen === generation.current) {
					// A timed-out write may have landed. Read back; never blindly replay it.
					let reread = false
					try {
						const data = await api.feed()
						if (gen === generation.current) accept(data)
						reread = true
					} catch {
						/* retain the last answer */
					}
					// The board read back is live: the refusal was this tap's (a conflict, a
					// manager's setting), said without locking the board. Unread, it is stale.
					if (reread && failure instanceof KitchenError) setActionError(failure)
					else refuse(failure)
				}
				return false
			} finally {
				writing.current = false
				setBusy(false)
			}
		},
		[online, api, accept, refuse],
	)

	const stale =
		!online || !receivedAt || Date.now() - receivedAt > 15_000 || error !== null
	return {
		feed,
		error: actionError ?? error,
		busy,
		now,
		stale,
		refresh,
		command: (command: KdsCommand) => write(() => api.command(command)),
		configure: (version: number, config: KdsConfig) =>
			write(() => api.configure(version, config)),
	}
}
