import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
	ChevronUp,
	Clock,
	CloudOff,
	HardDrive,
	Link2Off,
	MapPinOff,
	UtensilsCrossed,
	Wallet,
	type LucideIcon,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { HostStand } from './apps/reservations/HostStand.tsx'
import { TimeClock } from './apps/timeclock/TimeClock.tsx'
import { applyLocale, effectiveLocale } from './i18n.ts'
import { idleMs, shouldLock, touch } from '~/lib/activity.ts'
import { categoryItems } from '~/lib/catalog.ts'
import { clockIsOff, skewMinutes, useClock } from '~/lib/clock.ts'
import { isConfigured, shownApp } from '~/lib/config.ts'
import { db, type PosOrder } from '~/lib/db.ts'
import {
	buildLine,
	canQuickAdd,
	defaultSelections,
	defaultVariantPicks,
} from '~/lib/item-config.ts'
import { moneyFormatter } from '~/lib/money.ts'
import {
	createOrder,
	DEMO_ORIGIN,
	pruneSettledOrders,
	removedLines,
	updateTab,
	validateOrderDraft,
	type Audit,
	type OrderDraft,
} from '~/lib/orders.ts'
import { computeTotals, type CartLine } from '~/lib/pricing.ts'
import { useStoragePersistence } from '~/lib/storage.ts'
import { usePos } from '~/lib/store.ts'
import { tipsAllowed } from '~/lib/tips.ts'
import { type MenuItem } from '~/lib/types.ts'
import { applyUpdateIfIdle } from '~/lib/update.ts'
import { AuditSheet } from '~/screens/AuditSheet.tsx'
import { Cart } from '~/screens/Cart.tsx'
import { Checkout } from '~/screens/Checkout.tsx'
import { ItemSheet } from '~/screens/ItemSheet.tsx'
import { LockScreen } from '~/screens/LockScreen.tsx'
import { MenuGrid } from '~/screens/MenuGrid.tsx'
import { OrdersSheet } from '~/screens/OrdersSheet.tsx'
import { PairingLinkDialog } from '~/screens/PairingLinkDialog.tsx'
import { SettingsSheet } from '~/screens/SettingsSheet.tsx'
import { ShiftSheet, useOpenShift } from '~/screens/ShiftSheet.tsx'
import { TopBar } from '~/screens/TopBar.tsx'
import { useIsDesktop } from '~/ui/hooks.ts'
import {
	Button,
	Modal,
	NumberPop,
	Reveal,
	cn,
	motionMs,
} from '~/ui/primitives.tsx'

const SYNC_INTERVAL_MS = 30_000
/**
 * A running till picks up sold-out and price changes without anyone tapping
 * refresh: check every minute, download only when the saved menu is older than
 * five. (Checking as rarely as the threshold would skip a whole period whenever a
 * tick landed a moment early.)
 */
const MENU_CHECK_MS = 60_000
const MENU_REFRESH_MS = 5 * 60_000
const MENU_STALE_ON_FOCUS_MS = 2 * 60_000

function resolveAsset(url: string | undefined, appUrl: string): string | null {
	if (!url) return null
	if (/^(https?:|data:|blob:)/.test(url)) return url
	return appUrl
		? `${appUrl.replace(/\/+$/, '')}${url.startsWith('/') ? '' : '/'}${url}`
		: null
}

export function App() {
	const s = usePos()
	const { _ } = useLingui()
	// The till's own language choice, else the restaurant's default when that is Arabic.
	const locale = effectiveLocale(
		s.settings.locale ?? null,
		s.snapshot?.menu.organization.defaultLocale,
	)
	useEffect(() => applyLocale(locale), [locale])
	const [picking, setPicking] = useState<MenuItem | null>(null)
	const [editing, setEditing] = useState<CartLine | null>(null)
	const [checkout, setCheckout] = useState<{
		draft: OrderDraft
		existing: PosOrder | null
		/** `cart`: paying what is on screen. `orders`: settling a tab from the list, leaving the cart alone. */
		source: 'cart' | 'orders'
	} | null>(null)
	const busy = useRef(false)
	/** A pairing link opened on this device: shown with the servers it names, and confirmed before it changes anything. */
	const [pendingLink, setPendingLink] = useState<string | null>(null)
	/** Loading a tab would replace an order being rung up: confirm first. */
	const [confirmReplace, setConfirmReplace] = useState<PosOrder | null>(null)
	const [cartOpen, setCartOpen] = useState(false)
	const [cartError, setCartError] = useState<string | null>(null)
	const desktop = useIsDesktop()
	const [ordersOpen, setOrdersOpen] = useState(false)
	const [settingsOpen, setSettingsOpen] = useState(false)
	/** Settings were asked for by someone who is not a manager. */
	const [managerOnly, setManagerOnly] = useState(false)
	/** Items are coming off a saved tab: ask why (and for a manager) before saving. */
	const [removal, setRemoval] = useState<{
		next: 'save' | 'charge'
		summary: string
	} | null>(null)
	const [shiftOpen, setShiftOpen] = useState(false)
	const currentShift = useOpenShift()
	/** This terminal sells only inside a cash drawer shift, and none is open (null while loading). */
	const needsShift = s.settings.shiftsRequired && currentShift === undefined
	/** Stops a sale that needs a shift and opens the drawer sheet instead. */
	const blockedForShift = () => {
		if (!needsShift) return false
		setCartError(_(t`Open a shift before taking orders.`))
		setShiftOpen(true)
		return true
	}

	useEffect(() => {
		// Any touch, tap or key counts as activity; the till locks when there is none.
		const bump = () => touch()
		const events = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const
		for (const name of events)
			window.addEventListener(name, bump, { capture: true, passive: true })
		const check = () => {
			const st = usePos.getState()
			if (
				shouldLock({
					signInRequired: st.settings.signInRequired,
					signedIn: st.session !== null,
					idleLockSeconds: st.settings.idleLockSeconds,
					idleMs: idleMs(),
				})
			) {
				st.lock()
			}
		}
		const timer = window.setInterval(check, 1000)
		// A tablet that was asleep is checked the moment it wakes, not a second later.
		document.addEventListener('visibilitychange', check)
		return () => {
			for (const name of events)
				window.removeEventListener(name, bump, { capture: true })
			window.clearInterval(timer)
			document.removeEventListener('visibilitychange', check)
		}
	}, [])

	useEffect(() => {
		/** A pairing link opened now, or tapped while the app is already open (the page does not reload). */
		const takePairingLink = () => {
			if (!window.location.hash.includes('c=')) return
			const hash = window.location.hash
			history.replaceState(
				null,
				'',
				window.location.pathname + window.location.search,
			)
			// A link must never silently point a till at a server, paired or not (a
			// sticker with a QR code is enough to try): show where it points, then ask.
			setPendingLink(hash)
		}
		takePairingLink()
		void s.boot()
		const onHash = () => takePairingLink()
		window.addEventListener('hashchange', onHash)
		const on = () => s.setOnline(true)
		const off = () => s.setOnline(false)
		window.addEventListener('online', on)
		window.addEventListener('offline', off)
		const timer = window.setInterval(() => void s.sync(), SYNC_INTERVAL_MS)
		const menuTimer = window.setInterval(
			() => void s.refreshIfStale(MENU_REFRESH_MS),
			MENU_CHECK_MS,
		)
		const onVisible = () => {
			if (document.visibilityState === 'visible')
				void s.refreshIfStale(MENU_STALE_ON_FOCUS_MS)
		}
		document.addEventListener('visibilitychange', onVisible)
		void pruneSettledOrders()
		const updateTimer = window.setInterval(() => {
			applyUpdateIfIdle({
				cartEmpty: usePos.getState().lines.length === 0,
				dialogOpen: document.querySelector('dialog[open]') !== null,
			})
		}, 20_000)
		return () => {
			window.removeEventListener('hashchange', onHash)
			window.clearInterval(menuTimer)
			window.clearInterval(updateTimer)
			document.removeEventListener('visibilitychange', onVisible)
			window.removeEventListener('online', on)
			window.removeEventListener('offline', off)
			window.clearInterval(timer)
		}
		// Boot once; the store actions are stable.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	const currency =
		s.location?.currency ?? s.snapshot?.menu.organization.currency ?? 'USD'
	const money = useMemo(
		() => moneyFormatter(currency, locale),
		[currency, locale],
	)
	const itemsById = useMemo(() => {
		const map = new Map<string, MenuItem>()
		for (const c of s.categories)
			for (const i of categoryItems(c)) map.set(i.id, i)
		return map
	}, [s.categories])
	const counts = useMemo(() => {
		const map = new Map<string, number>()
		for (const l of s.lines)
			map.set(l.itemId, (map.get(l.itemId) ?? 0) + l.quantity)
		return map
	}, [s.lines])

	const skew = useClock((c) => c.skewMs)
	const clockOff = clockIsOff(skew)
	const clockMinutes = skewMinutes(skew)
	const storagePersisted = useStoragePersistence((p) => p.persisted)
	const businessName = s.snapshot?.organization.name ?? _(t`Station`)
	const app = shownApp(s.settings)
	/** The time clock opened from the lock screen, over it. */
	const [clockOverLock, setClockOverLock] = useState(false)
	const locked = s.settings.signInRequired && s.session === null
	// Plain values for the messages below (translations interpolate names, not expressions).
	const catalogError = s.catalogError
	const loadProblem = catalogError ?? _(t`No connection`)
	const deviceLabel = s.settings.deviceLabel
	const removalSummary = removal?.summary ?? ''
	const replaceNumber = confirmReplace?.number ?? ''
	/** Settings hold unpairing, server addresses and demo mode: managers only when staff sign in. */
	const openSettings = () => {
		if (s.settings.signInRequired && s.session?.role !== 'manager')
			setManagerOnly(true)
		else setSettingsOpen(true)
	}
	const needsSetup = !isConfigured(s.settings)
	const menuLoading = s.catalogStatus === 'loading'
	// The skeleton stays for the length of the reveal, then leaves the DOM.
	const [skeleton, setSkeleton] = useState(menuLoading)
	if (menuLoading && !skeleton) setSkeleton(true)
	useLayoutEffect(() => {
		if (menuLoading || !skeleton) return
		const timer = window.setTimeout(
			() => setSkeleton(false),
			motionMs('--reveal-dur', 400),
		)
		return () => window.clearTimeout(timer)
	}, [menuLoading, skeleton])
	// Settings opened by a manager must not outlive their session: whoever signs in next
	// would otherwise find them open underneath the lock.
	const isManagerSession = s.session?.role === 'manager'
	useEffect(() => {
		if (s.settings.signInRequired && !isManagerSession) {
			setSettingsOpen(false)
			setManagerOnly(false)
		}
	}, [s.settings.signInRequired, isManagerSession, s.session])

	const pick = (item: MenuItem) => {
		// One tap adds the item as it comes, default options included.
		if (canQuickAdd(item))
			s.addLine(
				buildLine(
					item,
					defaultVariantPicks(item),
					defaultSelections(item),
					1,
					'',
				),
			)
		else setPicking(item)
	}

	const draftFromCart = (): OrderDraft | null =>
		s.location
			? {
					terminalCode: s.settings.terminalCode,
					locationId: s.location.id,
					currency,
					taxRatePercent: s.location.taxRate,
					taxInclusive: s.location.taxInclusive ?? false,
					catalogFetchedAt: s.snapshot?.fetchedAt ?? null,
					dayStartMinutes: s.settings.dayStartMinutes,
					orderType: s.orderType,
					orderSource: s.orderSource,
					customerPhone: s.customerPhone,
					pickupAt: s.pickupAt,
					pickupTimeZone: s.pickupTimeZone,
					customerName: s.customerName,
					tableLabel: s.tableLabel,
					lines: s.lines,
					adjustments: s.adjustments,
					tipCents: 0,
					origin: s.settings.demo
						? DEMO_ORIGIN
						: s.settings.slug.trim().toLowerCase(),
					timeZone: s.location.timezone,
					staff: s.session?.staff ?? null,
					signIn: s.session?.mode ?? null,
				}
			: null
	const draftFromOrder = (o: PosOrder): OrderDraft => ({
		terminalCode: s.settings.terminalCode,
		locationId: o.locationId,
		currency: o.currency,
		taxRatePercent: o.taxRatePercent,
		taxInclusive: o.taxInclusive,
		orderType: o.orderType,
		orderSource: o.orderSource,
		customerPhone: o.customerPhone,
		pickupAt: o.pickupAt,
		pickupTimeZone: o.pickupTimeZone,
		customerName: o.customerName,
		tableLabel: o.tableLabel,
		lines: o.lines,
		adjustments: o.adjustments,
		tipCents: o.totals.tipCents,
		origin: o.origin,
	})

	/**
	 * Items taken off a tab that was already saved need a reason (and a manager,
	 * when sign-in is on and this person is not one). Returns true when the
	 * question was asked, so the caller stops and resumes after the answer.
	 */
	const askWhyIfRemoving = async (
		draft: OrderDraft,
		next: 'save' | 'charge',
		audit: Audit | null,
	): Promise<boolean> => {
		if (audit || !s.activeOrderId) return false
		const saved = await db.orders.get(s.activeOrderId)
		const removed = saved ? removedLines(saved.lines, draft.lines) : []
		if (removed.length === 0) return false
		setRemoval({
			next,
			summary: removed.map((r) => `${r.quantity} × ${r.line.name}`).join(', '),
		})
		return true
	}

	/** Saves the cart as an open tab (new, or the tab being added to). */
	const saveTab = async (
		audit: Audit | null = null,
	): Promise<PosOrder | null> => {
		const draft = draftFromCart()
		// A second tap while the first is still saving would make a duplicate tab.
		if (!draft || busy.current || blockedForShift()) return null
		if (await askWhyIfRemoving(draft, 'save', audit)) return null
		busy.current = true
		setCartError(null)
		try {
			const order = s.activeOrderId
				? await updateTab(s.activeOrderId, draft, audit)
				: await createOrder(draft)
			s.clearOrder()
			setCartOpen(false)
			void s.sync()
			return order
		} catch (e) {
			setCartError(
				e instanceof Error ? e.message : _(t`Could not save the order`),
			)
			return null
		} finally {
			busy.current = false
		}
	}

	const charge = async (audit: Audit | null = null) => {
		const draft = draftFromCart()
		if (!draft || busy.current || blockedForShift()) return
		if (await askWhyIfRemoving(draft, 'charge', audit)) return
		busy.current = true
		setCartError(null)
		try {
			// Paying a tab: fold in any items added since it was opened first.
			validateOrderDraft(draft)
			const existing = s.activeOrderId
				? await updateTab(s.activeOrderId, draft, audit)
				: null
			setCartOpen(false)
			// A tab keeps the tax rate it was opened with, so the bill the cashier
			// sees is the one that is stored (the location's rate may have changed).
			setCheckout({
				draft: {
					...draft,
					taxRatePercent: existing?.taxRatePercent ?? draft.taxRatePercent,
					taxInclusive: existing?.taxInclusive ?? draft.taxInclusive,
				},
				existing,
				source: 'cart',
			})
		} catch (e) {
			setCartError(
				e instanceof Error ? e.message : _(t`Could not start payment`),
			)
		} finally {
			busy.current = false
		}
	}

	const loadTabIntoCart = (order: PosOrder) => {
		s.loadTab(order)
		setOrdersOpen(false)
		setConfirmReplace(null)
		setCartOpen(!desktop)
	}
	const addItemsToTab = (order: PosOrder) => {
		// Never throw away an order that is being rung up without asking.
		if (s.lines.length > 0 && s.activeOrderId !== order.id)
			setConfirmReplace(order)
		else loadTabIntoCart(order)
	}

	const waiting = useLiveQuery(
		() => db.orders.where('sync').anyOf('pending', 'syncing').count(),
		[],
		0,
	)
	// A loaded tab keeps the tax it was opened with; a new order uses the location's.
	const cartTax = s.activeTax ?? {
		taxRatePercent: s.location?.taxRate ?? 0,
		taxInclusive: s.location?.taxInclusive ?? false,
	}
	const cartTotals = computeTotals({
		lines: s.lines,
		taxRatePercent: cartTax.taxRatePercent,
		taxInclusive: cartTax.taxInclusive,
		adjustments: s.adjustments,
	})
	const itemCount = s.lines.reduce((n, l) => n + l.quantity, 0)
	const activeTabNumber = useLiveQuery(
		async () =>
			s.activeOrderId
				? ((await db.orders.get(s.activeOrderId))?.number ?? null)
				: null,
		[s.activeOrderId],
		null,
	)

	const cart = (
		<Cart
			showHeading={desktop}
			tabNumber={activeTabNumber}
			error={cartError}
			lines={s.lines}
			adjustments={s.adjustments}
			taxRatePercent={cartTax.taxRatePercent}
			taxInclusive={cartTax.taxInclusive}
			orderType={s.orderType}
			customerName={s.customerName}
			orderSource={s.orderSource}
			customerPhone={s.customerPhone}
			pickupAt={s.pickupAt}
			pickupTimeZone={s.pickupTimeZone}
			timeZone={s.location?.timezone}
			onPhoneOrder={s.setPhoneOrder}
			onCounterOrder={s.setCounterOrder}
			tableLabel={s.tableLabel}
			money={money}
			onOrderType={s.setOrderType}
			onCustomer={s.setCustomerName}
			onTable={s.setTableLabel}
			onQuantity={s.setQuantity}
			onEdit={(line) => {
				const item = itemsById.get(line.itemId)
				if (!item) return
				setEditing(line)
				setPicking(item)
			}}
			onRemove={s.removeLine}
			onClear={s.clearOrder}
			onCharge={() => void charge()}
			onSaveTab={() => void saveTab()}
		/>
	)

	const pairingDialog = pendingLink ? (
		<PairingLinkDialog
			link={pendingLink}
			paired={s.settings.deviceToken !== null}
			deviceLabel={deviceLabel}
			currentApi={s.settings.tenantApiUrl}
			currentApp={s.settings.appUrl}
			needsManager={s.needsManager()}
			onSwitchUser={s.lock}
			onPair={s.pair}
			onClose={() => setPendingLink(null)}
		/>
	) : null

	if (needsSetup) {
		return (
			<>
				<SettingsSheet
					open
					required
					onClose={() => undefined}
					settings={s.settings}
					locations={[]}
					lastSyncedAt={null}
					error={null}
					waitingOrders={0}
					onSave={s.updateSettings}
					onPair={s.pair}
					onUnpair={s.unpair}
				/>
				{/* Same position as in the till below, so it survives the switch once paired. */}
				{pairingDialog}
				{null}
			</>
		)
	}

	return (
		<>
			<div className="flex h-full flex-col" inert={locked}>
				<TopBar
					name={businessName}
					logoUrl={resolveAsset(
						s.snapshot?.organization.siteIcon?.appleTouchIcon,
						s.settings.appUrl,
					)}
					locationName={s.location?.name ?? null}
					online={s.online}
					refreshing={s.refreshing}
					onRefresh={() => void s.refresh()}
					onOrders={() => setOrdersOpen(true)}
					onSettings={openSettings}
					staffName={
						s.settings.signInRequired ? (s.session?.staff.name ?? null) : null
					}
					onLock={s.settings.signInRequired ? s.lock : undefined}
					onShift={() => setShiftOpen(true)}
					shiftOpen={Boolean(currentShift)}
					app={app}
					apps={s.settings.apps}
					onApp={(next) => void s.updateSettings({ activeApp: next })}
				/>
				<Reveal open={needsShift && app === 'pos'}>
					<button
						type="button"
						onClick={() => setShiftOpen(true)}
						className="bg-warning/15 text-warning hover:bg-warning/20 flex w-full items-center gap-2 px-4 py-2 text-start text-sm font-semibold transition-colors"
					>
						<Wallet className="size-4 shrink-0" />
						<Trans>
							No shift is open. Tap to count the drawer and open one before
							selling.
						</Trans>
					</button>
				</Reveal>
				<Reveal open={s.pairingLost}>
					<button
						type="button"
						onClick={openSettings}
						className="bg-destructive/12 text-destructive hover:bg-destructive/16 flex w-full items-center gap-2 px-4 py-2 text-start text-sm font-semibold transition-colors"
					>
						<Link2Off className="size-4 shrink-0" />
						{s.settings.deviceToken ? (
							<Trans>
								The server is not recognising this terminal. Orders are safe on
								this device. Tap to check or pair it again.
							</Trans>
						) : (
							<Trans>
								This terminal was removed. Orders are safe on this device. Tap
								to pair it again.
							</Trans>
						)}
					</button>
				</Reveal>
				<Reveal open={clockOff}>
					<div
						role="alert"
						className="bg-destructive/12 text-destructive flex items-center gap-2 px-4 py-2 text-sm font-semibold"
					>
						<Clock className="size-4 shrink-0" />{' '}
						<Trans>
							This tablet’s clock is about {clockMinutes} minutes off. Receipts
							and invoices carry the wrong time until it is set correctly in the
							tablet’s settings.
						</Trans>
					</div>
				</Reveal>
				<Reveal open={storagePersisted === false}>
					<div
						role="status"
						className="bg-warning/15 text-warning flex items-center gap-2 px-4 py-2 text-sm font-medium"
					>
						<HardDrive className="size-4 shrink-0" />{' '}
						<Trans>
							This browser may clear orders saved on this device when it runs
							low on space. Install Station (Add to Home Screen) so they are
							kept.
						</Trans>
					</div>
				</Reveal>
				<Reveal
					open={Boolean(
						s.catalogError && s.snapshot && s.online && app === 'pos',
					)}
				>
					<div
						role="status"
						className="bg-warning/15 text-warning flex items-center gap-2 px-4 py-2 text-sm font-medium"
					>
						<CloudOff className="size-4 shrink-0" />{' '}
						<Trans>
							Couldn’t update the menu ({catalogError}). Selling from the copy
							saved on this device.
						</Trans>
					</div>
				</Reveal>

				{app === 'timeclock' ? (
					<TimeClock
						settings={s.settings}
						online={s.online}
						businessName={businessName}
						locationName={s.location?.name ?? null}
						currency={s.location?.currency ?? 'USD'}
					/>
				) : app === 'reservations' ? (
					<HostStand
						settings={s.settings}
						session={s.session}
						online={s.online}
						onSignIn={s.lock}
					/>
				) : null}
				{app === 'pos' ? (
					<div className="flex min-h-0 flex-1">
						<main className="flex min-w-0 flex-1 flex-col">
							{/* First load: a skeleton of the menu pulses, then cross-fades to it. */}
							<div
								className={cn(
									't-skel flex min-h-0 flex-1 flex-col',
									!menuLoading && 'is-revealed',
								)}
							>
								{skeleton ? (
									<div className="t-skel-skeleton is-pulsing" aria-hidden>
										<MenuSkeleton />
									</div>
								) : null}
								<div className="t-skel-content flex flex-col">
									{menuLoading ? (
										<p role="status" className="sr-only">
											{_(t`Loading menu…`)}
										</p>
									) : s.catalogStatus === 'error' ? (
										<Message
											icon={CloudOff}
											title={_(t`Can’t load the menu yet`)}
											body={_(
												t`${loadProblem}. The first load needs internet; after that the till works offline.`,
											)}
											action={
												<Button
													variant="primary"
													size="lg"
													onClick={() => void s.refresh()}
												>
													<Trans>Try again</Trans>
												</Button>
											}
										/>
									) : s.locationMissing ? (
										<Message
											icon={MapPinOff}
											title={_(t`This terminal’s location isn’t on the menu`)}
											body={_(
												t`It is set up for a location that is not on the published menu, so it will not sell from another one. Ask a manager to check the location is published, then refresh.`,
											)}
											action={
												<Button
													variant="primary"
													size="lg"
													onClick={() => void s.refresh()}
												>
													<Trans>Refresh</Trans>
												</Button>
											}
										/>
									) : s.catalogStatus === 'empty' ? (
										<Message
											icon={UtensilsCrossed}
											title={_(t`No menu items`)}
											body={_(
												t`Publish a menu with items for this location, then refresh.`,
											)}
											action={
												<Button
													variant="primary"
													size="lg"
													onClick={() => void s.refresh()}
												>
													<Trans>Refresh</Trans>
												</Button>
											}
										/>
									) : (
										<MenuGrid
											categories={s.categories}
											money={money}
											counts={counts}
											onPick={pick}
										/>
									)}
								</div>
							</div>
						</main>
						{desktop ? (
							<aside className="border-border flex min-h-0 w-[26rem] shrink-0 flex-col border-s">
								{cart}
							</aside>
						) : null}
					</div>
				) : null}

				{!desktop && app === 'pos' ? (
					<>
						<button
							type="button"
							onClick={() => setCartOpen(true)}
							className="mb-safe bg-primary text-primary-foreground elevated-card mx-3 mt-1 flex h-16 shrink-0 items-center justify-between gap-3 rounded-2xl px-5 transition active:scale-[0.98]"
						>
							<span className="flex items-center gap-3 font-semibold">
								<span className="tnum mono bg-primary-foreground/20 flex h-8 min-w-8 items-center justify-center rounded-full px-1.5 text-sm font-bold">
									<NumberPop value={String(itemCount)} />
								</span>
								{itemCount === 0 ? (
									<Trans>Order is empty</Trans>
								) : activeTabNumber ? (
									<Trans>Tab #{activeTabNumber}</Trans>
								) : (
									<Trans>View order</Trans>
								)}
							</span>
							<span className="tnum mono flex items-center gap-2 text-lg font-bold">
								<NumberPop value={money(cartTotals.totalCents)} />
								<ChevronUp className="size-5" />
							</span>
						</button>
						<Modal
							open={cartOpen}
							onClose={() => setCartOpen(false)}
							title={_(t`Current order`)}
							size="lg"
							scrollable={false}
						>
							{cart}
						</Modal>
					</>
				) : null}

				<ItemSheet
					item={picking}
					editing={editing}
					money={money}
					onClose={() => {
						setPicking(null)
						setEditing(null)
					}}
					onSubmit={(line) => {
						if (editing) s.replaceLine(editing.id, line)
						else s.addLine(line)
						setPicking(null)
						setEditing(null)
					}}
				/>

				{checkout ? (
					<Checkout
						draft={checkout.draft}
						existing={checkout.existing}
						businessName={businessName}
						money={money}
						tipsEnabled={tipsAllowed(s.location, checkout.draft.orderType)}
						staff={s.session?.staff ?? null}
						vatNumber={s.location?.vatNumber ?? null}
						onSaved={() => void s.sync()}
						onClose={({ order, finished }) => {
							setCheckout(null)
							// Done, or part-paid and left as a tab: the cart is spent, but only when
							// it was the cart being paid. Settling a tab from the Orders list must
							// not wipe a different order the cashier is in the middle of.
							if (checkout.source === 'cart' && (finished || order))
								s.clearOrder()
							void s.sync()
						}}
					/>
				) : null}

				{ordersOpen ? (
					<OrdersSheet
						timeZone={s.location?.timezone}
						dayStartMinutes={s.settings.dayStartMinutes}
						vatNumber={s.location?.vatNumber ?? null}
						onClose={() => setOrdersOpen(false)}
						businessName={businessName}
						onRetry={() => void s.sync(true)}
						onAddItems={addItemsToTab}
						onPay={(order) => {
							if (blockedForShift()) {
								setOrdersOpen(false)
								return
							}
							setOrdersOpen(false)
							setCheckout({
								draft: draftFromOrder(order),
								existing: order,
								source: 'orders',
							})
						}}
					/>
				) : null}
				{settingsOpen ? (
					<SettingsSheet
						open
						onClose={() => setSettingsOpen(false)}
						settings={s.settings}
						locations={s.snapshot?.menu.locations ?? []}
						lastSyncedAt={s.snapshot?.fetchedAt ?? null}
						error={s.catalogError}
						waitingOrders={waiting}
						onSave={s.updateSettings}
						onPair={s.pair}
						onUnpair={s.unpair}
					/>
				) : null}

				{shiftOpen ? (
					<ShiftSheet
						onClose={() => setShiftOpen(false)}
						money={money}
						me={s.session?.staff ?? null}
						needsManager={s.needsManager()}
						onApprove={s.approve}
						businessName={businessName}
						origin={
							s.settings.demo
								? DEMO_ORIGIN
								: s.settings.slug.trim().toLowerCase()
						}
						timeZone={s.location?.timezone}
						dayStartMinutes={s.settings.dayStartMinutes}
						onChanged={() => void s.sync()}
					/>
				) : null}

				{removal ? (
					<AuditSheet
						title={_(t`Take items off this tab?`)}
						description={_(
							t`This tab was already saved (and may have gone to the kitchen). Taking off ${removalSummary} is recorded with who did it and why.`,
						)}
						confirmLabel={_(t`Take them off`)}
						reasons={[
							'mistake',
							'guest_request',
							'out_of_stock',
							'quality',
							'other',
						]}
						me={s.session?.staff ?? null}
						needsManager={s.needsManager()}
						onApprove={s.approve}
						onClose={() => setRemoval(null)}
						onConfirm={async (audit) => {
							const next = removal.next
							setRemoval(null)
							if (next === 'save') await saveTab(audit)
							else await charge(audit)
							return null
						}}
					/>
				) : null}

				{confirmReplace ? (
					<Modal
						open
						onClose={() => setConfirmReplace(null)}
						title={_(t`Replace the order on screen?`)}
						footer={
							<div className="grid grid-cols-2 gap-3">
								<Button
									variant="outline"
									size="lg"
									onClick={() => setConfirmReplace(null)}
								>
									<Trans>Keep working</Trans>
								</Button>
								<Button
									variant="danger"
									size="lg"
									onClick={() => loadTabIntoCart(confirmReplace)}
								>
									<Trans>Replace it</Trans>
								</Button>
							</div>
						}
					>
						<p className="text-muted-foreground p-5">
							<Trans>
								The order you are ringing up has not been saved. Opening tab #
								{replaceNumber} here will discard it. Save it with “Pay later”
								first if you want to keep it.
							</Trans>
						</p>
					</Modal>
				) : null}

				{managerOnly ? (
					<Modal
						open
						onClose={() => setManagerOnly(false)}
						title={_(t`Settings are for managers`)}
						footer={
							<div className="grid grid-cols-2 gap-3">
								<Button
									variant="outline"
									size="lg"
									onClick={() => setManagerOnly(false)}
								>
									<Trans>Close</Trans>
								</Button>
								<Button
									variant="primary"
									size="lg"
									onClick={() => {
										setManagerOnly(false)
										s.lock()
									}}
								>
									<Trans>Switch user</Trans>
								</Button>
							</div>
						}
					>
						<p className="text-muted-foreground p-5">
							<Trans>
								Unpairing, server addresses and demo mode can only be changed by
								a manager. Ask a manager to sign in, or switch user.
							</Trans>
						</p>
					</Modal>
				) : null}
			</div>
			{/* Waits behind the lock: a manager confirms it once signed in. */}
			{locked ? null : pairingDialog}
			{locked ? (
				<LockScreen
					businessName={businessName}
					logoUrl={resolveAsset(
						s.snapshot?.organization.siteIcon?.appleTouchIcon,
						s.settings.appUrl,
					)}
					online={s.online}
					demo={s.settings.demo}
					onSignIn={s.signIn}
					onClockIn={
						s.settings.apps.timeclock ? () => setClockOverLock(true) : undefined
					}
				/>
			) : null}
			{locked && clockOverLock ? (
				<ClockOverLock onClose={() => setClockOverLock(false)}>
					<TimeClock
						settings={s.settings}
						online={s.online}
						businessName={businessName}
						locationName={s.location?.name ?? null}
						currency={s.location?.currency ?? 'USD'}
						onClose={() => setClockOverLock(false)}
					/>
				</ClockOverLock>
			) : null}
		</>
	)
}

/**
 * The time clock over the lock: a full-screen dialog opened after the lock's
 * own, so it sits above it in the top layer. Closing it is back to signing in.
 */
function ClockOverLock({
	onClose,
	children,
}: {
	onClose: () => void
	children: React.ReactNode
}) {
	const ref = useRef<HTMLDialogElement>(null)
	const { _ } = useLingui()
	useEffect(() => {
		const dialog = ref.current
		if (dialog && !dialog.open) dialog.showModal()
	}, [])
	return (
		<dialog
			ref={ref}
			aria-label={_(t`Time clock`)}
			onCancel={(event) => {
				event.preventDefault()
				onClose()
			}}
			className="t-rise bg-background text-foreground backdrop:bg-background m-0 flex h-dvh max-h-none w-screen max-w-none flex-col overflow-hidden p-0"
		>
			{children}
		</dialog>
	)
}

function Message({
	icon: Icon,
	title,
	body,
	action,
}: {
	icon: LucideIcon
	title: string
	body: string
	action?: React.ReactNode
}) {
	return (
		<div className="t-rise flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
			<div className="bg-muted text-muted-foreground mb-1 flex size-16 items-center justify-center rounded-full">
				<Icon className="size-8" />
			</div>
			<h2 className="text-2xl font-bold text-balance">{title}</h2>
			<p className="text-muted-foreground max-w-md text-pretty">{body}</p>
			{action ? <div className="mt-2">{action}</div> : null}
		</div>
	)
}

/** The shape of the menu while the first copy downloads: search, categories, dishes. */
function MenuSkeleton() {
	const { _ } = useLingui()
	const label = _(t`Loading menu…`)
	return (
		<div className="flex h-full flex-col gap-4 overflow-hidden px-3 pt-3 sm:px-4">
			<div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:gap-3">
				<div data-bone className="bg-muted h-12 rounded-xl xl:w-64" />
				<div className="flex gap-2 overflow-hidden py-1">
					{['w-28', 'w-36', 'w-24', 'w-32', 'w-28'].map((width, i) => (
						<div
							key={i}
							data-bone
							className={cn('bg-muted h-12 shrink-0 rounded-xl', width)}
						/>
					))}
				</div>
			</div>
			<span className="t-shimmer text-lg font-semibold" data-text={label}>
				{label}
			</span>
			<div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,9rem),1fr))] gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(11.5rem,1fr))] sm:gap-3">
				{Array.from({ length: 12 }, (_unused, i) => (
					<div
						key={i}
						data-bone
						className="border-border bg-card flex min-h-36 flex-col justify-end gap-2 rounded-2xl border-2 p-3"
					>
						<div className="bg-muted h-4 w-3/4 rounded-md" />
						<div className="bg-muted h-3.5 w-1/3 rounded-md" />
					</div>
				))}
			</div>
		</div>
	)
}
