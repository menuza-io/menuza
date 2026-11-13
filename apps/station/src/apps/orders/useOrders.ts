import {
	type PosOnlineOrderCommand,
	type PosOnlineOrderContact,
	type PosOnlineOrderDetail,
	type PosOnlineOrderRefund,
	type PosOnlineOrdersFeed,
	type PosOnlineOrdersGrants,
} from '@repo/common/pos-online-orders'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createOrdersApi, OrdersError } from './api.ts'
import { demoOrders } from './demo.ts'
import { type PosSettings } from '~/lib/config.ts'
import { type Session } from '~/lib/signin.ts'

/** A feed older than this is not live: actions pause until it is read again. */
export const ORDERS_STALE_MS = 15_000
export const ORDERS_POLL_MS = 5_000

/**
 * The Orders screen's state, all in memory: the inbox (polled every five
 * seconds while visible), the open order, and the guest's contact once a
 * person allowed to see it asks (dropped when the order closes). Writes are
 * never queued or replayed; after one fails the order is read back.
 */
export function useOrders(
	settings: PosSettings,
	session: Session | null,
	online: boolean,
) {
	const api = useMemo(
		() => (settings.demo ? demoOrders() : createOrdersApi(settings, session)),
		[settings, session],
	)
	const [feed, setFeed] = useState<PosOnlineOrdersFeed | null>(null)
	const [error, setError] = useState<OrdersError | null>(null)
	const [actionError, setActionError] = useState<OrdersError | null>(null)
	const [busy, setBusy] = useState(false)
	const [receivedAt, setReceivedAt] = useState(0)
	const [now, setNow] = useState(Date.now)
	const [selected, setSelected] = useState<string | null>(null)
	const [detail, setDetail] = useState<PosOnlineOrderDetail | null>(null)
	const [grants, setGrants] = useState<PosOnlineOrdersGrants | null>(null)
	const [contact, setContact] = useState<PosOnlineOrderContact | null>(null)
	const [openedHere, setOpenedHere] = useState<ReadonlySet<string>>(
		() => new Set(),
	)
	const writing = useRef(false)
	const generation = useRef(0)
	const sequence = useRef(0)
	const reading = useRef<number | null>(null)
	const offset = useRef(0)
	const selectedRef = useRef<string | null>(null)
	selectedRef.current = selected
	/** Bumped on every open and close: an answer for an earlier opening is dropped. */
	const opening = useRef(0)
	const [revealing, setRevealing] = useState(false)
	const revealingRef = useRef(false)

	const accept = useCallback((data: PosOnlineOrdersFeed) => {
		offset.current = data.serverNow - Date.now()
		setFeed(data)
		setGrants(data.grants)
		setReceivedAt(Date.now())
		setNow(data.serverNow)
		setError(null)
		// Once the server knows an order was opened, this tablet need not remember it.
		setOpenedHere((previous) => {
			if (previous.size === 0) return previous
			const recorded = new Set(
				data.orders
					.filter((order) => order.openedAt !== null)
					.map((order) => order.id),
			)
			const next = new Set([...previous].filter((id) => !recorded.has(id)))
			return next.size === previous.size ? previous : next
		})
	}, [])
	const refuse = useCallback((value: unknown) => {
		const failure =
			value instanceof OrdersError
				? value
				: new OrdersError('orders_unavailable')
		setError(failure)
		if (failure.status === 401 || failure.status === 403) {
			// Close the sheet too: its modal would hide the "Sign in again" banner.
			opening.current += 1
			setSelected(null)
			setFeed(null)
			setDetail(null)
			setContact(null)
		}
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
		setSelected(null)
		setDetail(null)
		setContact(null)
		reading.current = null
		return () => {
			generation.current = gen + 1
		}
	}, [api])
	useEffect(() => {
		void refresh()
		const poll = window.setInterval(() => {
			if (document.visibilityState === 'visible') void refresh()
		}, ORDERS_POLL_MS)
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
	useEffect(() => {
		if (!actionError) return
		const timer = window.setTimeout(() => setActionError(null), 8_000)
		return () => window.clearTimeout(timer)
	}, [actionError])

	const readBack = useCallback(
		async (id: string, gen: number) => {
			try {
				const data = await api.detail(id)
				if (gen === generation.current && selectedRef.current === id) {
					setDetail(data.order)
					setGrants(data.grants)
				}
				return true
			} catch (failure) {
				if (
					failure instanceof OrdersError &&
					failure.status === 404 &&
					gen === generation.current
				)
					setDetail(null)
				return false
			}
		},
		[api],
	)

	// The open order follows the inbox: when another screen changed it, read it
	// again; when it left the inbox, its guest's contact goes too.
	const detailVersion = detail?.version ?? null
	useEffect(() => {
		const id = selectedRef.current
		if (!feed || !id || writing.current) return
		const listed = feed.orders.find((order) => order.id === id)
		if (!listed) {
			setContact(null)
			return
		}
		if (detailVersion !== null && listed.version !== detailVersion)
			void readBack(id, generation.current)
	}, [feed, detailVersion, readBack])

	/** One write at a time; the open order and the inbox are read back after it, whatever happened. */
	const write = useCallback(
		async (
			id: string,
			send: () => Promise<{
				order: PosOnlineOrderDetail
				grants: PosOnlineOrdersGrants
			}>,
		) => {
			if (writing.current || !online) return false
			writing.current = true
			setActionError(null)
			setBusy(true)
			++sequence.current
			const gen = generation.current
			try {
				const data = await send()
				if (gen === generation.current && selectedRef.current === id) {
					setDetail(data.order)
					setGrants(data.grants)
				}
				return true
			} catch (failure) {
				if (gen === generation.current) {
					// A timed-out write may have landed: read back, never replay it blindly.
					await readBack(id, gen)
					setActionError(
						failure instanceof OrdersError
							? failure
							: new OrdersError('orders_unavailable'),
					)
					if (
						failure instanceof OrdersError &&
						(failure.code === 'staff_session_required' ||
							failure.code === 'staff_session_invalid')
					)
						refuse(failure)
				}
				return false
			} finally {
				writing.current = false
				setBusy(false)
				void refresh()
			}
		},
		[online, readBack, refresh, refuse],
	)

	const open = useCallback(
		async (id: string) => {
			opening.current += 1
			setSelected(id)
			setDetail(null)
			setContact(null)
			setActionError(null)
			const gen = generation.current
			if (!online) {
				// Not recorded on the server: the alert keeps ringing here.
				if (!(await readBack(id, gen)))
					setActionError(new OrdersError('connection_lost'))
				return
			}
			// Silences the alert here at once; the server silences every other tablet.
			setOpenedHere((previous) => new Set(previous).add(id))
			try {
				const data = await api.command(id, { action: 'open' })
				if (gen === generation.current && selectedRef.current === id) {
					setDetail(data.order)
					setGrants(data.grants)
				}
			} catch (failure) {
				if (gen !== generation.current) return
				// The opening was not recorded: keep alerting until it is.
				setOpenedHere((previous) => {
					const next = new Set(previous)
					next.delete(id)
					return next
				})
				// Reading it is still useful when recording the opening failed.
				if (!(await readBack(id, gen)))
					setActionError(
						failure instanceof OrdersError
							? failure
							: new OrdersError('orders_unavailable'),
					)
			}
			void refresh()
		},
		[api, online, readBack, refresh],
	)
	const close = useCallback(() => {
		opening.current += 1
		setSelected(null)
		setDetail(null)
		setContact(null)
		setActionError(null)
	}, [])

	const stale =
		!online ||
		!receivedAt ||
		Date.now() - receivedAt > ORDERS_STALE_MS ||
		error !== null
	return {
		feed,
		grants,
		error,
		actionError,
		busy,
		now,
		stale,
		refresh,
		openedHere,
		selected,
		detail,
		contact,
		open,
		close,
		command: (command: Exclude<PosOnlineOrderCommand, { action: 'open' }>) =>
			selected
				? write(selected, () => api.command(selected, command))
				: Promise.resolve(false),
		refund: (refund: PosOnlineOrderRefund, idempotencyKey: string) =>
			selected
				? write(selected, () => api.refund(selected, refund, idempotencyKey))
				: Promise.resolve(false),
		revealing,
		/** The guest's full phone and email, held only while this order is open. */
		revealContact: async () => {
			const id = selected
			if (!id || !online || revealingRef.current) return
			revealingRef.current = true
			setRevealing(true)
			const gen = generation.current
			const opened = opening.current
			const current = () =>
				gen === generation.current &&
				opened === opening.current &&
				selectedRef.current === id
			try {
				const data = await api.contact(id)
				if (current()) setContact(data)
			} catch (failure) {
				if (current())
					setActionError(
						failure instanceof OrdersError
							? failure
							: new OrdersError('orders_unavailable'),
					)
			} finally {
				revealingRef.current = false
				setRevealing(false)
			}
		},
		/** Records a reprint after the tablet printed the ticket. */
		recordReprint: (ticket: 'guest' | 'kitchen') => {
			const id = selected
			if (!id || !online) return
			void api.command(id, { action: 'reprint', ticket }).catch(() => {})
		},
	}
}

export type OrdersState = ReturnType<typeof useOrders>
