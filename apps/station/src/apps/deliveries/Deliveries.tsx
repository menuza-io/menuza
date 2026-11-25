import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	DELIVERY_PROBLEM_KINDS,
	type DeliveryBoardOrder,
	type DeliveryProblemKindValue,
	type DeliveryRunView,
	type DeliveryStopView,
} from '@repo/common/delivery-runs'
import { Icon } from '@repo/ui/icon'
import { useEffect, useRef, useState } from 'react'
import { type DeliveriesApi } from './api.ts'
import { useDeliveries, type DeliveriesState } from './useDeliveries.ts'
import { type PosSettings } from '~/lib/config.ts'
import { formatMoney, parseDecimal, toCents } from '~/lib/money.ts'
import { type Session } from '~/lib/signin.ts'
import { Badge, Button, cn, Input } from '~/ui/primitives.tsx'

/** Words for what the region answers; the codes are machine values. */
function useErrorText() {
	const { _ } = useLingui()
	return (code: string | null): string | null => {
		switch (code) {
			case null:
				return null
			case 'order_already_assigned':
				return _(t`Another driver already has that order.`)
			case 'driver_unavailable':
				return _(t`That driver is unavailable right now.`)
			case 'order_not_ready':
				return _(t`That order is not ready any more.`)
			case 'not_picked_up':
				return _(t`Mark the run picked up first.`)
			case 'stop_not_found':
			case 'run_not_found':
				return _(t`That delivery is no longer on your list.`)
			case 'not_a_driver':
				return _(t`You are not set up as a driver here.`)
			case 'permission_required':
				return _(t`Only a manager can do that.`)
			case 'call_unavailable':
				return _(t`Calling is not available. Ring the restaurant instead.`)
			case 'call_failed':
				return _(t`The call could not be started. Try again.`)
			case 'deliveries_not_enabled':
				return _(t`Deliveries are not switched on for this restaurant.`)
			case 'connection_lost':
				return _(t`Connection lost. Reconnect and try again.`)
			case 'staff_session_invalid':
			case 'staff_session_required':
				return _(t`Sign in again.`)
			default:
				return _(t`That did not work. Try again.`)
		}
	}
}

function useProblemText() {
	const { _ } = useLingui()
	return (kind: DeliveryProblemKindValue | null): string => {
		switch (kind) {
			case 'not_home':
				return _(t`Nobody home`)
			case 'wrong_address':
				return _(t`Wrong address`)
			case 'refused':
				return _(t`Guest refused`)
			case 'cannot_reach':
				return _(t`Cannot reach the guest`)
			default:
				return _(t`Other problem`)
		}
	}
}

/**
 * Station's Deliveries app (#287). One screen, two roles: a signed-in manager
 * sees the board (ready orders, runs, drivers); a signed-in driver sees their
 * own open run only. Addresses come from the region for the open run and are
 * kept in memory, never stored: when a run finishes the next read has none.
 */
export function Deliveries({
	settings,
	session,
	online,
	onSignIn,
	api,
	renderHeader = (controls) => controls,
}: {
	settings: PosSettings
	session: Session | null
	online: boolean
	onSignIn: () => void
	/** Tests and demo mode pass their own. */
	api?: DeliveriesApi | null
	renderHeader?: (controls?: React.ReactNode) => React.ReactNode
}) {
	const { _ } = useLingui()
	const reachable = online || settings.demo
	const state = useDeliveries(settings, session, reachable, api ?? null)
	const errorText = useErrorText()
	const { me, board, error } = state

	return (
		<main className="flex min-h-0 flex-1 flex-col" data-testid="deliveries">
			{renderHeader(
				<div className="ms-auto flex items-center gap-2">
					<Button
						variant="outline"
						onClick={() => void state.refresh()}
						disabled={!reachable || state.busy || !session}
					>
						<Icon name="refresh-cw" className="size-4" />
						<Trans>Refresh</Trans>
					</Button>
				</div>,
			)}
			{!session ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
					<p>
						<Trans>Sign in with your PIN to see your deliveries.</Trans>
					</p>
					<Button variant="primary" onClick={onSignIn}>
						<Trans>Sign in</Trans>
					</Button>
				</div>
			) : (
				<div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
					{error ? (
						<p role="alert" className="notice-warning rounded-lg px-4 py-3 text-sm">
							{errorText(error)}
						</p>
					) : null}
					{state.notices.length > 0 ? (
						<Notices state={state} />
					) : null}
					{!me ? (
						<p className="text-muted-foreground p-6 text-center">
							{error ? null : <Trans>Loading deliveries…</Trans>}
						</p>
					) : me.role === 'none' ? (
						<p className="text-muted-foreground p-6 text-center" role="status">
							<Trans>
								Deliveries are for managers and drivers. Ask a manager if you should
								be set up as a driver.
							</Trans>
						</p>
					) : (
						<>
							{me.role === 'manager' && board ? (
								<ManagerBoard state={state} api={state.api} />
							) : null}
							{me.isDriver ? <DriverView state={state} api={state.api} /> : null}
						</>
					)}
				</div>
			)}
			<span className="sr-only">{_(t`Deliveries`)}</span>
		</main>
	)
}

function Notices({ state }: { state: DeliveriesState }) {
	const { _ } = useLingui()
	return (
		<section
			aria-label={_(t`Changes to your deliveries`)}
			className="notice-warning space-y-1 rounded-lg px-4 py-3 text-sm"
			data-testid="delivery-notices"
		>
			{state.notices.map((notice) => {
				const numbers = notice.orderNumbers.join(', ')
				return (
					<p key={notice.id}>
						{notice.kind === 'assigned' ? (
							<Trans>You were given deliveries: {numbers}</Trans>
						) : notice.kind === 'taken_away' ? (
							<Trans>A manager gave your run to someone else: {numbers}</Trans>
						) : (
							<Trans>A manager took a delivery back: {numbers}</Trans>
						)}
					</p>
				)
			})}
			<Button variant="outline" onClick={state.dismissNotices}>
				<Trans>Got it</Trans>
			</Button>
		</section>
	)
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

function ManagerBoard({
	state,
	api,
}: {
	state: DeliveriesState
	api: DeliveriesApi
}) {
	const { _ } = useLingui()
	const problemText = useProblemText()
	const board = state.board!
	const [picked, setPicked] = useState<Set<string>>(new Set())
	const [driverId, setDriverId] = useState('')
	const available = board.drivers.filter((driver) => !driver.unavailable)
	const toggle = (id: string) =>
		setPicked((current) => {
			const next = new Set(current)
			if (next.has(id)) next.delete(id)
			else next.add(id)
			return next
		})
	return (
		<section className="space-y-5" aria-label={_(t`Deliveries board`)}>
			<div className="space-y-2">
				<h2 className="text-lg font-semibold">
					<Trans>Ready for a driver</Trans>
				</h2>
				{board.unassigned.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>No delivery orders are waiting for a driver.</Trans>
					</p>
				) : (
					<ul className="space-y-2">
						{board.unassigned.map((order) => (
							<li key={order.id} className="flex items-start gap-3">
								<input
									type="checkbox"
									className="mt-2 size-5"
									checked={picked.has(order.id)}
									onChange={() => toggle(order.id)}
									aria-label={_(t`Select order ${order.number}`)}
								/>
								<OrderLine order={order} />
							</li>
						))}
					</ul>
				)}
				{board.unassigned.length > 0 ? (
					<div className="flex flex-wrap items-end gap-3">
						<label className="space-y-1 text-sm">
							<span className="block">
								<Trans>Driver</Trans>
							</span>
							<select
								className="border-input bg-card h-12 rounded-lg border px-3"
								value={driverId}
								onChange={(event) => setDriverId(event.target.value)}
							>
								<option value="">{_(t`Choose a driver`)}</option>
								{available.map((driver) => (
									<option key={driver.staffId} value={driver.staffId}>
										{driver.name}
									</option>
								))}
							</select>
						</label>
						<Button
							variant="primary"
							disabled={state.busy || picked.size === 0 || !driverId}
							onClick={() =>
								void state
									.act(() => api.assign(driverId, [...picked]))
									.then((ok) => ok && setPicked(new Set()))
							}
						>
							<Trans>Assign as one run</Trans>
						</Button>
					</div>
				) : null}
			</div>

			<div className="space-y-3">
				<h2 className="text-lg font-semibold">
					<Trans>Runs</Trans>
				</h2>
				{board.runs.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>No driver is out right now.</Trans>
					</p>
				) : null}
				{board.runs.map((run) => (
					<div key={run.id} className="border-border space-y-2 rounded-lg border p-3">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<p className="font-medium">{run.driver.name}</p>
							{run.status !== 'completed' ? (
								<select
									className="border-input bg-card h-11 rounded-lg border px-3 text-sm"
									value=""
									aria-label={_(t`Give this run to another driver`)}
									onChange={(event) =>
										event.target.value &&
										void state.act(() => api.reassign(run.id, event.target.value))
									}
								>
									<option value="">{_(t`Reassign`)}</option>
									{available
										.filter((driver) => driver.staffId !== run.driver.staffId)
										.map((driver) => (
											<option key={driver.staffId} value={driver.staffId}>
												{driver.name}
											</option>
										))}
								</select>
							) : null}
						</div>
						<ul className="space-y-1 text-sm">
							{run.stops.map((stop) => (
								<li
									key={stop.id}
									className="flex flex-wrap items-center justify-between gap-2"
								>
									<span className="min-w-0 wrap-anywhere">
										{stop.number} · {stop.firstName}
										{stop.problemKind ? ` · ${problemText(stop.problemKind)}` : ''}
									</span>
									<span className="flex items-center gap-2">
										<StopBadge status={stop.status} />
										{stop.status === 'pending' ||
										stop.status === 'picked_up' ||
										stop.status === 'problem' ? (
											<>
												<Button
													variant="outline"
													disabled={state.busy}
													onClick={() =>
														void state.act(() => api.delivered(stop.id))
													}
												>
													<Trans>Mark delivered</Trans>
												</Button>
												<Button
													variant="ghost"
													disabled={state.busy}
													onClick={() => void state.act(() => api.release(stop.id))}
												>
													<Trans>Take back</Trans>
												</Button>
											</>
										) : null}
									</span>
								</li>
							))}
						</ul>
					</div>
				))}
			</div>

			<div className="space-y-2">
				<h2 className="text-lg font-semibold">
					<Trans>Drivers</Trans>
				</h2>
				{board.drivers.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>
							No one has a job marked “Delivers orders” at this location yet.
						</Trans>
					</p>
				) : null}
				<ul className="space-y-1">
					{board.drivers.map((driver) => (
						<li key={driver.staffId} className="flex items-center justify-between gap-2">
							<span>
								{driver.name}
								{driver.openRuns > 0 ? ` · ${driver.openRuns}` : ''}
							</span>
							<Button
								variant={driver.unavailable ? 'secondary' : 'outline'}
								disabled={state.busy}
								onClick={() =>
									void state.act(() =>
										api.driverAvailability(driver.staffId, !driver.unavailable),
									)
								}
							>
								{driver.unavailable ? (
									<Trans>Unavailable · set available</Trans>
								) : (
									<Trans>Set unavailable</Trans>
								)}
							</Button>
						</li>
					))}
				</ul>
			</div>
		</section>
	)
}

function StopBadge({ status }: { status: DeliveryStopView['status'] }) {
	return (
		<Badge
			tone={
				status === 'delivered'
					? 'success'
					: status === 'problem'
						? 'danger'
						: status === 'picked_up'
							? 'primary'
							: 'muted'
			}
		>
			{status === 'pending' ? (
				<Trans>Waiting</Trans>
			) : status === 'picked_up' ? (
				<Trans>On the road</Trans>
			) : status === 'delivered' ? (
				<Trans>Delivered</Trans>
			) : status === 'problem' ? (
				<Trans>Problem</Trans>
			) : (
				<Trans>Taken back</Trans>
			)}
		</Badge>
	)
}

function OrderLine({ order }: { order: DeliveryBoardOrder }) {
	const cash = formatMoney(order.cashDueCents, order.currency)
	return (
		<div className="min-w-0 flex-1">
			<p className="font-medium wrap-anywhere">
				{order.number} · {order.firstName}
			</p>
			<p className="text-muted-foreground text-sm wrap-anywhere">
				{[order.address, order.unit].filter(Boolean).join(' · ')}
			</p>
			{order.cashDueCents > 0 ? (
				<p className="text-sm">
					<Trans>Cash to collect: {cash}</Trans>
				</p>
			) : null}
		</div>
	)
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function DriverView({
	state,
	api,
}: {
	state: DeliveriesState
	api: DeliveriesApi
}) {
	const { _ } = useLingui()
	const me = state.me!
	const run = me.run
	const [picked, setPicked] = useState<Set<string>>(new Set())
	return (
		<section className="space-y-4" aria-label={_(t`My deliveries`)} data-testid="driver-view">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h2 className="text-lg font-semibold">
					<Trans>My deliveries</Trans>
				</h2>
				<Button
					variant={me.unavailable ? 'secondary' : 'outline'}
					disabled={state.busy}
					onClick={() => void state.act(() => api.myAvailability(!me.unavailable))}
				>
					{me.unavailable ? (
						<Trans>I am unavailable · set available</Trans>
					) : (
						<Trans>Set myself unavailable</Trans>
					)}
				</Button>
			</div>
			{run ? (
				<RunCard state={state} api={api} run={run} />
			) : (
				<div className="space-y-2">
					<p className="text-muted-foreground text-sm">
						<Trans>You have no run right now.</Trans>
					</p>
					{me.claimable.length > 0 ? (
						<>
							<h3 className="font-medium">
								<Trans>Ready to take</Trans>
							</h3>
							<ul className="space-y-2">
								{me.claimable.map((order) => (
									<li key={order.id} className="flex items-start gap-3">
										<input
											type="checkbox"
											className="mt-2 size-5"
											checked={picked.has(order.id)}
											onChange={() =>
												setPicked((current) => {
													const next = new Set(current)
													if (next.has(order.id)) next.delete(order.id)
													else next.add(order.id)
													return next
												})
											}
											aria-label={_(t`Select order ${order.number}`)}
										/>
										<OrderLine order={order} />
									</li>
								))}
							</ul>
							<Button
								variant="primary"
								disabled={state.busy || picked.size === 0}
								onClick={() =>
									void state
										.act(() => api.claim([...picked]))
										.then((ok) => ok && setPicked(new Set()))
								}
							>
								<Trans>Take these deliveries</Trans>
							</Button>
						</>
					) : null}
				</div>
			)}
		</section>
	)
}

function RunCard({
	state,
	api,
	run,
}: {
	state: DeliveriesState
	api: DeliveriesApi
	run: DeliveryRunView
}) {
	const { _ } = useLingui()
	const waiting = run.stops.filter((stop) => stop.status === 'pending')
	const [sharing, setSharing] = useState(false)
	const [locationError, setLocationError] = useState(false)
	const watch = useRef<number | null>(null)

	// Share where the driver is only while they chose to, and stop with the run.
	useEffect(() => {
		if (!sharing) return
		if (!('geolocation' in navigator)) {
			setLocationError(true)
			setSharing(false)
			return
		}
		watch.current = navigator.geolocation.watchPosition(
			(position) =>
				void api
					.sharePosition(position.coords.latitude, position.coords.longitude)
					.catch(() => undefined),
			() => {
				setLocationError(true)
				setSharing(false)
			},
			{ maximumAge: 15_000, timeout: 20_000 },
		)
		return () => {
			if (watch.current !== null) navigator.geolocation.clearWatch(watch.current)
			watch.current = null
			void api.stopSharing().catch(() => undefined)
		}
	}, [sharing, api])

	return (
		<div className="space-y-3" data-testid="driver-run">
			{waiting.length > 0 ? (
				<Button
					variant="primary"
					size="lg"
					disabled={state.busy}
					onClick={() => void state.act(() => api.pickUp(run.id))}
				>
					<Trans>Picked up</Trans>
				</Button>
			) : null}
			<ul className="space-y-3">
				{run.stops.map((stop) => (
					<StopCard key={stop.id} state={state} api={api} stop={stop} />
				))}
			</ul>
			<div className="space-y-1">
				<Button variant="outline" onClick={() => setSharing((value) => !value)} aria-pressed={sharing}>
					<Icon name="route" className="size-4" />
					{sharing ? (
						<Trans>Stop sharing my location</Trans>
					) : (
						<Trans>Share my location with the manager</Trans>
					)}
				</Button>
				{locationError ? (
					<p role="alert" className="text-muted-foreground text-xs">
						<Trans>We could not read your location.</Trans>
					</p>
				) : null}
			</div>
			<span className="sr-only">{_(t`Run`)}</span>
		</div>
	)
}

function StopCard({
	state,
	api,
	stop,
}: {
	state: DeliveriesState
	api: DeliveriesApi
	stop: DeliveryStopView
}) {
	const { _ } = useLingui()
	const problemText = useProblemText()
	const [cash, setCash] = useState('')
	const [asking, setAsking] = useState<null | 'cash' | 'problem'>(null)
	const due = formatMoney(stop.cashDueCents, stop.currency)
	const tip = formatMoney(stop.tipCents, stop.currency)
	const closed = stop.status === 'delivered' || stop.status === 'problem' || stop.status === 'released'
	return (
		<li
			className={cn('border-border space-y-2 rounded-lg border p-3', closed && 'opacity-60')}
			data-testid="driver-stop"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="font-medium wrap-anywhere">
					{stop.stopNo}. {stop.number} · {stop.firstName}
				</p>
				<StopBadge status={stop.status} />
			</div>
			<p className="wrap-anywhere" dir="auto">
				{[stop.address, stop.unit].filter(Boolean).join(' · ')}
			</p>
			{stop.notes ? (
				<p className="text-muted-foreground text-sm wrap-anywhere" dir="auto">
					{stop.notes}
				</p>
			) : null}
			{stop.cashDueCents > 0 ? (
				<p className="font-medium">
					<Trans>Collect cash: {due}</Trans>
				</p>
			) : null}
			{stop.tipCents > 0 ? (
				<p className="text-muted-foreground text-sm">
					<Trans>Tip: {tip}</Trans>
				</p>
			) : null}
			{stop.problemKind ? (
				<p className="text-sm">{problemText(stop.problemKind)}</p>
			) : null}
			<div className="flex flex-wrap gap-2">
				<a
					className="border-input inline-flex h-11 items-center gap-2 rounded-lg border px-4 text-sm"
					href={stop.mapUrl}
					target="_blank"
					rel="noreferrer"
				>
					<Icon name="route" className="size-4" />
					<Trans>Map</Trans>
				</a>
				{stop.canCall && !closed ? (
					<Button variant="outline" disabled={state.busy} onClick={() => void state.act(() => api.callGuest(stop.id))}>
						<Icon name="phone" className="size-4" />
						<Trans>Call guest</Trans>
					</Button>
				) : null}
				{stop.status === 'picked_up' ? (
					<>
						<Button
							variant="primary"
							disabled={state.busy}
							onClick={() =>
								stop.cashDueCents > 0
									? setAsking('cash')
									: void state.act(() => api.delivered(stop.id))
							}
						>
							<Trans>Delivered</Trans>
						</Button>
						<Button variant="outline" disabled={state.busy} onClick={() => setAsking('problem')}>
							<Trans>Problem</Trans>
						</Button>
					</>
				) : null}
			</div>
			{asking === 'cash' ? (
				<div className="flex flex-wrap items-end gap-2">
					<label className="space-y-1 text-sm">
						<span className="block">
							<Trans>Cash collected</Trans>
						</span>
						<Input
							inputMode="decimal"
							value={cash}
							placeholder={(stop.cashDueCents / 100).toFixed(2)}
							onChange={(event) => setCash(event.target.value)}
						/>
					</label>
					<Button
						variant="primary"
						disabled={state.busy}
						onClick={() => {
							const parsed = cash.trim() === '' ? stop.cashDueCents / 100 : parseDecimal(cash)
							if (parsed === null) return
							void state
								.act(() => api.delivered(stop.id, toCents(parsed)))
								.then((ok) => ok && setAsking(null))
						}}
					>
						<Trans>Confirm delivered</Trans>
					</Button>
				</div>
			) : null}
			{asking === 'problem' ? (
				<div className="flex flex-wrap gap-2" role="group" aria-label={_(t`What went wrong?`)}>
					{DELIVERY_PROBLEM_KINDS.map((kind) => (
						<Button
							key={kind}
							variant="outline"
							disabled={state.busy}
							onClick={() =>
								void state.act(() => api.problem(stop.id, kind)).then((ok) => ok && setAsking(null))
							}
						>
							{problemText(kind)}
						</Button>
					))}
				</div>
			) : null}
		</li>
	)
}
