import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	type DeliveryBoard,
	type DeliveryBoardOrder,
	type DeliveryProblemKindValue,
	type DeliveryRunView,
	type DeliveryStopView,
} from '@repo/common/delivery-runs'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
	OperatorRequestError,
	useOperatorClient,
} from '#app/hooks/use-operator-client.ts'
import { formatMoney } from '#app/utils/orders/order-model.ts'

export type DeliveryLocationOption = { id: string; name: string }

const REFRESH_MS = 15_000

/** Words for a problem a driver reported (the regional code is a machine value). */
function useProblemLabel() {
	const { _ } = useLingui()
	return (kind: DeliveryProblemKindValue | null) => {
		switch (kind) {
			case 'not_home':
				return _(msg`Nobody home`)
			case 'wrong_address':
				return _(msg`Wrong address`)
			case 'refused':
				return _(msg`Guest refused`)
			case 'cannot_reach':
				return _(msg`Cannot reach the guest`)
			default:
				return _(msg`Other problem`)
		}
	}
}

/**
 * The Deliveries board on the Orders page (#287), shown while the organization's
 * `delivery.in_house` flag is on: ready delivery orders waiting for a driver
 * (unassigned first), the runs out on the road, problems to settle, and the
 * drivers. Everything runs from this browser to the regional tenant-api with
 * the orders token: addresses and first names never transit the App.
 */
export function DeliveriesPanel({
	orgSlug,
	locations,
	canWrite,
}: {
	orgSlug: string
	locations: DeliveryLocationOption[]
	canWrite: boolean
}) {
	const { _, i18n } = useLingui()
	const problemLabel = useProblemLabel()
	const { request } = useOperatorClient(orgSlug, '/operator/deliveries')
	const [locationId, setLocationId] = useState(locations[0]?.id ?? '')
	const [board, setBoard] = useState<DeliveryBoard | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [picked, setPicked] = useState<Set<string>>(new Set())
	const [driverId, setDriverId] = useState('')

	const refresh = useCallback(async () => {
		if (!locationId) return
		try {
			setBoard(
				(await request(
					`/board?locationId=${encodeURIComponent(locationId)}`,
				)) as DeliveryBoard,
			)
			setError(null)
		} catch {
			setError(_(msg`Unable to load deliveries. Try again.`))
		}
	}, [request, locationId, _])

	useEffect(() => {
		setBoard(null)
		setPicked(new Set())
		void refresh()
		const timer = window.setInterval(() => void refresh(), REFRESH_MS)
		return () => window.clearInterval(timer)
	}, [refresh])

	const money = (cents: number, currency: string) =>
		formatMoney(cents, currency, i18n.locale)
	const selectLabel = (number: string) => _(msg`Select order ${number}`)

	const errorText = (code: string) => {
		switch (code) {
			case 'order_already_assigned':
				return _(msg`Another driver already has one of these orders.`)
			case 'driver_unavailable':
				return _(msg`That driver is unavailable right now.`)
			case 'order_not_ready':
				return _(msg`One of these orders is no longer ready.`)
			case 'driver_not_found':
				return _(msg`That person is not on the driver list.`)
			default:
				return _(msg`That did not work. Try again.`)
		}
	}

	async function act(path: string, body?: unknown) {
		setBusy(true)
		setError(null)
		try {
			await request(path, {
				method: 'POST',
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			})
			setPicked(new Set())
			await refresh()
		} catch (cause) {
			setError(
				errorText(cause instanceof OperatorRequestError ? cause.code : ''),
			)
			await refresh()
		} finally {
			setBusy(false)
		}
	}

	const availableDrivers = useMemo(
		() => (board?.drivers ?? []).filter((driver) => !driver.unavailable),
		[board],
	)

	if (locations.length === 0) return null
	const togglePicked = (id: string) =>
		setPicked((current) => {
			const next = new Set(current)
			if (next.has(id)) next.delete(id)
			else next.add(id)
			return next
		})

	const orderLine = (order: DeliveryBoardOrder) => {
		const cash = money(order.cashDueCents, order.currency)
		return (
			<div className="min-w-0 flex-1">
				<p className="text-sm font-medium wrap-anywhere">
					{order.number} · {order.firstName}
				</p>
				<p className="text-muted-foreground text-xs wrap-anywhere">
					{[order.address, order.unit].filter(Boolean).join(' · ')}
				</p>
				{order.cashDueCents > 0 ? (
					<p className="text-xs">
						<Trans>Cash to collect: {cash}</Trans>
					</p>
				) : null}
			</div>
		)
	}

	const stopRow = (run: DeliveryRunView, stop: DeliveryStopView) => (
		<li
			key={stop.id}
			className="flex flex-wrap items-center justify-between gap-2 text-sm"
		>
			<span className="min-w-0 wrap-anywhere">
				{stop.number} · {stop.firstName}
				{stop.problemKind ? ` · ${problemLabel(stop.problemKind)}` : ''}
			</span>
			<span className="flex items-center gap-2">
				<Badge variant={stop.status === 'problem' ? 'destructive' : 'outline'}>
					{stop.status === 'pending' ? (
						<Trans>Waiting</Trans>
					) : stop.status === 'picked_up' ? (
						<Trans>On the road</Trans>
					) : stop.status === 'delivered' ? (
						<Trans>Delivered</Trans>
					) : stop.status === 'problem' ? (
						<Trans>Problem</Trans>
					) : (
						<Trans>Taken back</Trans>
					)}
				</Badge>
				{canWrite &&
				(stop.status === 'pending' ||
					stop.status === 'picked_up' ||
					stop.status === 'problem') ? (
					<>
						<Button
							size="sm"
							variant="outline"
							disabled={busy}
							onClick={() => void act(`/stops/${stop.id}/delivered`, {})}
						>
							<Trans>Mark delivered</Trans>
						</Button>
						<Button
							size="sm"
							variant="ghost"
							disabled={busy}
							onClick={() => void act(`/stops/${stop.id}/release`)}
						>
							<Trans>Take back</Trans>
						</Button>
					</>
				) : null}
			</span>
		</li>
	)

	return (
		<section
			className="border-border space-y-4 rounded-lg border p-4"
			aria-label={_(msg`Deliveries`)}
			data-testid="deliveries-panel"
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h2 className="text-base font-semibold">
					<Trans>Deliveries</Trans>
				</h2>
				{locations.length > 1 ? (
					<Select
						value={locationId}
						items={Object.fromEntries(locations.map((l) => [l.id, l.name]))}
						onValueChange={(value) => value && setLocationId(value)}
					>
						<SelectTrigger className="w-56" aria-label={_(msg`Location`)}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{locations.map((location) => (
								<SelectItem key={location.id} value={location.id}>
									{location.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				) : null}
			</div>
			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : null}

			<div className="space-y-2">
				<h3 className="text-sm font-medium">
					<Trans>Ready for a driver</Trans>
				</h3>
				{board && board.unassigned.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>No delivery orders are waiting for a driver.</Trans>
					</p>
				) : null}
				<ul className="space-y-2">
					{(board?.unassigned ?? []).map((order) => (
						<li key={order.id} className="flex items-start gap-3">
							{canWrite ? (
								<Checkbox
									checked={picked.has(order.id)}
									onCheckedChange={() => togglePicked(order.id)}
									aria-label={selectLabel(order.number)}
								/>
							) : null}
							{orderLine(order)}
						</li>
					))}
				</ul>
				{canWrite && (board?.unassigned.length ?? 0) > 0 ? (
					<div className="flex flex-wrap items-end gap-2">
						<div className="space-y-1">
							<Label htmlFor="delivery-driver" className="text-xs">
								<Trans>Driver</Trans>
							</Label>
							<Select
								value={driverId}
								items={Object.fromEntries(
									availableDrivers.map((d) => [d.staffId, d.name]),
								)}
								onValueChange={(value) => setDriverId(value ?? '')}
							>
								<SelectTrigger id="delivery-driver" className="w-48">
									<SelectValue placeholder={_(msg`Choose a driver`)} />
								</SelectTrigger>
								<SelectContent>
									{availableDrivers.map((driver) => (
										<SelectItem key={driver.staffId} value={driver.staffId}>
											{driver.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<Button
							disabled={busy || picked.size === 0 || !driverId}
							onClick={() =>
								void act('/runs', {
									locationId,
									driverStaffId: driverId,
									orderIds: [...picked],
								})
							}
						>
							<Trans>Assign as one run</Trans>
						</Button>
					</div>
				) : null}
			</div>

			<div className="space-y-3">
				<h3 className="text-sm font-medium">
					<Trans>Runs</Trans>
				</h3>
				{board && board.runs.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>No driver is out right now.</Trans>
					</p>
				) : null}
				{(board?.runs ?? []).map((run) => (
					<div
						key={run.id}
						className="border-border space-y-2 rounded-md border p-3"
						data-testid="delivery-run"
					>
						<div className="flex flex-wrap items-center justify-between gap-2">
							<p className="text-sm font-medium">{run.driver.name}</p>
							{run.position ? (
								<a
									className="text-xs underline"
									target="_blank"
									rel="noreferrer"
									href={`https://www.google.com/maps/search/?api=1&query=${run.position.lat},${run.position.lng}`}
								>
									<Trans>Where they are</Trans>
								</a>
							) : null}
							{canWrite && run.status !== 'completed' ? (
								<Select
									value=""
									items={Object.fromEntries(
										availableDrivers
											.filter((d) => d.staffId !== run.driver.staffId)
											.map((d) => [d.staffId, d.name]),
									)}
									onValueChange={(value) =>
										value &&
										void act(`/runs/${run.id}/reassign`, {
											driverStaffId: value,
										})
									}
								>
									<SelectTrigger
										className="w-44"
										aria-label={_(msg`Give this run to another driver`)}
									>
										<SelectValue placeholder={_(msg`Reassign`)} />
									</SelectTrigger>
									<SelectContent>
										{availableDrivers
											.filter((d) => d.staffId !== run.driver.staffId)
											.map((driver) => (
												<SelectItem key={driver.staffId} value={driver.staffId}>
													{driver.name}
												</SelectItem>
											))}
									</SelectContent>
								</Select>
							) : null}
						</div>
						<ul className="space-y-1">
							{run.stops.map((stop) => stopRow(run, stop))}
						</ul>
					</div>
				))}
			</div>

			<div className="space-y-2">
				<h3 className="text-sm font-medium">
					<Trans>Drivers</Trans>
				</h3>
				{board && board.drivers.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>
							No one has a job marked “Delivers orders” at this location yet.
						</Trans>
					</p>
				) : null}
				<ul className="space-y-1">
					{(board?.drivers ?? []).map((driver) => (
						<li
							key={driver.staffId}
							className="flex items-center justify-between gap-2 text-sm"
						>
							<span>
								{driver.name}
								{driver.openRuns > 0 ? ` · ${driver.openRuns}` : ''}
							</span>
							{canWrite ? (
								<Button
									size="sm"
									variant={driver.unavailable ? 'secondary' : 'outline'}
									disabled={busy}
									onClick={() =>
										void act(`/drivers/${driver.staffId}/availability`, {
											locationId,
											unavailable: !driver.unavailable,
										})
									}
								>
									{driver.unavailable ? (
										<Trans>Unavailable · set available</Trans>
									) : (
										<Trans>Set unavailable</Trans>
									)}
								</Button>
							) : driver.unavailable ? (
								<Badge variant="secondary">
									<Trans>Unavailable</Trans>
								</Badge>
							) : null}
						</li>
					))}
				</ul>
			</div>
		</section>
	)
}
