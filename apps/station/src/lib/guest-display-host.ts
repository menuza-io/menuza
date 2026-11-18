import { create } from 'zustand'
import {
	buildGuestState,
	guestChannelName,
	readGuestMessage,
	type GuestLoyalty,
	type GuestMessage,
	type GuestState,
	type GuestTip,
} from './guest-display.ts'
import {
	liveEnv,
	sendJoinCode,
	useLoyalty,
	verifyJoinCode,
} from './loyalty-store.ts'
import {
	foldCodeInput,
	foldPhoneInput,
	plausiblePhone,
	type LoyaltyMember,
} from './loyalty.ts'
import { computeTotals, type CartLine, type Totals } from './pricing.ts'
import { usePos } from './store.ts'
import { isTrainingMode } from './training-flag.ts'

/**
 * The till's side of the guest screen (#367). While a payment sheet is open it
 * tells the screen what is being paid (`useGuestCheckout`) and hears the tip
 * the guest taps; the rest of the time it mirrors the cart.
 */

type GuestCheckout = {
	open: boolean
	lines: CartLine[]
	totals: Totals | null
	taxInclusive: boolean
	tip: GuestTip | null
	/** A tip the guest tapped. `n` changes on every tap so the same choice twice still lands. */
	requested: { percent: number; n: number } | null
}

const closedCheckout: GuestCheckout = {
	open: false,
	lines: [],
	totals: null,
	taxInclusive: false,
	tip: null,
	requested: null,
}

export const useGuestCheckout = create<GuestCheckout>(() => closedCheckout)

/** The payment sheet shows (or stops showing) its bill on the guest screen. */
export const setGuestCheckout = (
	patch: Partial<Omit<GuestCheckout, 'open' | 'requested'>>,
) => useGuestCheckout.setState({ ...patch, open: true })
export const clearGuestCheckout = () =>
	useGuestCheckout.setState(closedCheckout)

/** The guest tapped a tip: the payment sheet applies it to the order. */
export const requestGuestTip = (percent: number) =>
	useGuestCheckout.setState((s) => ({
		requested: { percent, n: (s.requested?.n ?? 0) + 1 },
	}))

export type ChannelLike = {
	postMessage: (message: unknown) => void
	onmessage: ((event: { data: unknown }) => void) | null
	close: () => void
}

export type HostLoyalty = {
	sendCode: (phone: string) => Promise<unknown>
	verify: (phone: string, code: string) => Promise<LoyaltyMember>
}

export type HostSnapshot = {
	businessName: string
	currency: string
	locale: string
	rtl: boolean
	idleImageUrl: string | null
	/** The cart on the till. */
	lines: CartLine[]
	taxRatePercent: number
	taxInclusive: boolean
	adjustments: Parameters<typeof computeTotals>[0]['adjustments']
	/** Loyalty can be offered: a paired till whose region has it on. */
	loyaltyOffered: boolean
	member:
		| (Pick<LoyaltyMember, 'firstName' | 'unitLabel'> & {
				available: number
		  })
		| null
	checkout: GuestCheckout
}

/** The messages the screen shows for the loyalty box, kept here so they survive a second window. */
export function createGuestHost(deps: {
	channel: ChannelLike
	snapshot: () => HostSnapshot
	loyalty: HostLoyalty
	/** Starts again from "invite" when the order is cleared. */
	now?: () => number
}) {
	let seq = 0
	let stage: 'invite' | 'phone' | 'code' | 'busy' = 'invite'
	let phone = ''
	let error: string | null = null
	let disposed = false

	const loyalty = (snap: HostSnapshot): GuestLoyalty | null => {
		if (snap.member)
			return {
				stage: 'member',
				firstName: snap.member.firstName,
				points: snap.member.available,
				unitLabel: snap.member.unitLabel,
			}
		if (!snap.loyaltyOffered) return null
		if (stage === 'busy') return { stage: 'busy' }
		if (stage === 'phone') return { stage: 'phone', error }
		if (stage === 'code')
			return {
				stage: 'code',
				maskedPhone: phone.length > 4 ? `••••${phone.slice(-4)}` : '',
				error,
			}
		return { stage: 'invite' }
	}

	const state = (): GuestState => {
		const snap = deps.snapshot()
		const checkout = snap.checkout.open && snap.checkout.totals !== null
		const lines = checkout ? snap.checkout.lines : snap.lines
		const totals =
			checkout && snap.checkout.totals
				? snap.checkout.totals
				: computeTotals({
						lines: snap.lines,
						taxRatePercent: snap.taxRatePercent,
						taxInclusive: snap.taxInclusive,
						adjustments: snap.adjustments,
					})
		return buildGuestState({
			seq: ++seq,
			checkout,
			businessName: snap.businessName,
			currency: snap.currency,
			locale: snap.locale,
			rtl: snap.rtl,
			lines,
			totals,
			taxInclusive: checkout ? snap.checkout.taxInclusive : snap.taxInclusive,
			tip: checkout ? snap.checkout.tip : null,
			loyalty: loyalty(snap),
			idleImageUrl: snap.idleImageUrl,
		})
	}

	const publish = () => {
		if (disposed) return
		const next = state()
		// A cleared order starts the next guest at the invitation again.
		if (next.view === 'idle') {
			stage = 'invite'
			phone = ''
			error = null
		}
		deps.channel.postMessage(next)
	}

	const handle = async (message: GuestMessage) => {
		switch (message.type) {
			case 'hello':
				break
			case 'tip':
				// Only while the bill is being paid: the tip is part of the order then.
				if (deps.snapshot().checkout.tip) requestGuestTip(message.percent)
				break
			case 'loyalty-start':
				stage = 'phone'
				phone = ''
				error = null
				break
			case 'loyalty-reset':
				stage = 'invite'
				phone = ''
				error = null
				break
			case 'loyalty-phone': {
				const typed = foldPhoneInput(message.phone)
				if (!plausiblePhone(typed)) {
					stage = 'phone'
					error = 'invalid_phone'
					break
				}
				stage = 'busy'
				error = null
				publish()
				try {
					await deps.loyalty.sendCode(typed)
					phone = typed
					stage = 'code'
				} catch {
					stage = 'phone'
					error = 'failed'
				}
				break
			}
			case 'loyalty-code': {
				if (!phone) break
				stage = 'busy'
				error = null
				publish()
				try {
					await deps.loyalty.verify(phone, foldCodeInput(message.code))
					stage = 'invite'
					phone = ''
				} catch {
					stage = 'code'
					error = 'bad_code'
				}
				break
			}
		}
		publish()
	}

	deps.channel.onmessage = (event) => {
		const message = readGuestMessage(event.data)
		if (message) void handle(message)
	}
	return {
		publish,
		dispose() {
			disposed = true
			deps.channel.onmessage = null
			deps.channel.close()
		},
	}
}

function liveSnapshot(): HostSnapshot {
	const s = usePos.getState()
	const loy = useLoyalty.getState()
	const location = s.location
	return {
		businessName: s.snapshot?.organization.name ?? '',
		currency:
			location?.currency ?? s.snapshot?.menu.organization.currency ?? 'USD',
		locale: document.documentElement.lang || 'en',
		rtl: document.documentElement.dir === 'rtl',
		idleImageUrl: s.settings.managed?.guestDisplayImageUrl ?? null,
		lines: s.lines,
		taxRatePercent: location?.taxRate ?? 0,
		taxInclusive: location?.taxInclusive ?? false,
		adjustments: s.adjustments,
		loyaltyOffered:
			!isTrainingMode() &&
			!s.settings.demo &&
			Boolean(s.settings.deviceToken && s.settings.tenantApiUrl) &&
			!loy.unavailable,
		member: loy.member
			? {
					firstName: loy.member.firstName,
					unitLabel: loy.member.unitLabel,
					available: loy.member.balance.available,
				}
			: null,
		checkout: useGuestCheckout.getState(),
	}
}

/**
 * Starts mirroring the till to its guest screen. Returns the function that
 * stops it. Does nothing where `BroadcastChannel` does not exist.
 */
export function startGuestDisplayHost(options: {
	slug: string
	terminalCode: string
	createChannel?: (name: string) => ChannelLike
}): () => void {
	const create =
		options.createChannel ??
		(typeof BroadcastChannel === 'undefined'
			? null
			: (name: string) => new BroadcastChannel(name) as unknown as ChannelLike)
	if (!create) return () => undefined
	const host = createGuestHost({
		channel: create(guestChannelName(options.slug, options.terminalCode)),
		snapshot: liveSnapshot,
		loyalty: {
			sendCode: (phone) => sendJoinCode(liveEnv(), phone),
			verify: (phone, code) => verifyJoinCode(liveEnv(), phone, code),
		},
	})
	let queued = false
	const schedule = () => {
		if (queued) return
		queued = true
		queueMicrotask(() => {
			queued = false
			host.publish()
		})
	}
	const unsubscribe = [
		usePos.subscribe(schedule),
		useLoyalty.subscribe(schedule),
		useGuestCheckout.subscribe(schedule),
	]
	host.publish()
	return () => {
		for (const stop of unsubscribe) stop()
		host.dispose()
	}
}
