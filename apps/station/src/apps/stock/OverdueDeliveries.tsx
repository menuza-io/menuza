import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import { useRef, useState } from 'react'
import { StockApiError } from './api.ts'
import { immediateErrorText } from './messages.ts'
import {
	isIsoDate,
	localIsoDate,
	mayReceive,
	overdueDeliveries,
	tomorrowIsoDate,
	type OverdueDelivery,
} from './model.ts'
import { newClientId } from './queue.ts'
import { type StockState } from './useStock.ts'
import { serverNow } from '~/lib/clock.ts'
import { Button, Input } from '~/ui/primitives.tsx'

/**
 * Overdue expected deliveries (#501): asks the team whether each overdue order
 * arrived ("Yes, as ordered", "Yes, with changes", or "Not yet"), gated by the
 * same till-manager rule as receiving.
 */
export function OverdueDeliveries({
	stock,
	onOpenWithChanges,
	onToast,
}: {
	stock: StockState
	onOpenWithChanges: (orderId: string) => void
	onToast: (text: string) => void
}) {
	const { _, i18n } = useLingui()
	const { catalog, ctx, role } = stock
	const [answered, setAnswered] = useState<Record<string, true>>({})
	const [busyOrderId, setBusyOrderId] = useState<string | null>(null)
	const [errorByOrderId, setErrorByOrderId] = useState<
		Record<string, string | null>
	>({})
	const [notYetOrderId, setNotYetOrderId] = useState<string | null>(null)
	const [notYetDate, setNotYetDate] = useState(() => tomorrowIsoDate())
	const tapIds = useRef<Record<string, string>>({})

	if (!catalog) return null
	const list = overdueDeliveries(catalog).filter(
		(delivery) => !answered[`${delivery.orderId}:${delivery.version}`],
	)
	if (list.length === 0) return null

	const allowed = mayReceive(catalog, role)
	const todayIso = localIsoDate()

	const answerAsOrdered = async (delivery: OverdueDelivery) => {
		if (!allowed || !ctx || busyOrderId) return
		const key = `${delivery.orderId}:${delivery.version}`
		const clientId = (tapIds.current[key] ??= newClientId())
		setBusyOrderId(delivery.orderId)
		setErrorByOrderId((prev) => ({ ...prev, [delivery.orderId]: null }))
		try {
			await stock.api.receiveAsOrdered(delivery.orderId, {
				clientId,
				locationId: ctx.locationId,
				expectedVersion: delivery.version,
				madeBy: ctx.madeBy ?? undefined,
				madeAt: serverNow(),
			})
			setAnswered((prev) => ({ ...prev, [key]: true }))
			if (notYetOrderId === delivery.orderId) setNotYetOrderId(null)
			onToast(_(t`Delivery from ${delivery.supplierName} recorded as ordered.`))
			await stock.refresh()
		} catch (failure) {
			const code =
				failure instanceof StockApiError ? failure.code : 'connection_lost'
			setErrorByOrderId((prev) => ({
				...prev,
				[delivery.orderId]: immediateErrorText(code, i18n),
			}))
			if (code === 'stale_version') void stock.refresh()
		} finally {
			setBusyOrderId(null)
		}
	}

	const openNotYet = (orderId: string) => {
		if (!allowed || busyOrderId) return
		setNotYetOrderId(orderId)
		setNotYetDate(tomorrowIsoDate())
		setErrorByOrderId((prev) => ({ ...prev, [orderId]: null }))
	}

	const submitNotYet = async (delivery: OverdueDelivery) => {
		if (!allowed || !ctx || busyOrderId || !isIsoDate(notYetDate)) return
		const key = `${delivery.orderId}:${delivery.version}`
		setBusyOrderId(delivery.orderId)
		setErrorByOrderId((prev) => ({ ...prev, [delivery.orderId]: null }))
		try {
			await stock.api.orderNotYet(delivery.orderId, {
				locationId: ctx.locationId,
				expectedVersion: delivery.version,
				expectedDate: notYetDate,
				madeBy: ctx.madeBy ?? undefined,
				madeAt: serverNow(),
			})
			setAnswered((prev) => ({ ...prev, [key]: true }))
			setNotYetOrderId(null)
			onToast(
				_(
					t`Expected date for ${delivery.supplierName} updated to ${notYetDate}.`,
				),
			)
			await stock.refresh()
		} catch (failure) {
			const code =
				failure instanceof StockApiError ? failure.code : 'connection_lost'
			setErrorByOrderId((prev) => ({
				...prev,
				[delivery.orderId]: immediateErrorText(code, i18n),
			}))
			if (code === 'stale_version') void stock.refresh()
		} finally {
			setBusyOrderId(null)
		}
	}

	return (
		<section
			aria-label={_(t`Overdue deliveries`)}
			className="flex flex-col gap-3"
		>
			{list.map((delivery) => {
				const busy = busyOrderId === delivery.orderId
				const error = errorByOrderId[delivery.orderId]
				const pickingDate = notYetOrderId === delivery.orderId
				const supplierName = delivery.supplierName
				const orderNumber = delivery.number
				const expectedDate = delivery.expectedDate
				return (
					<div
						key={delivery.orderId}
						className="border-border bg-card flex flex-col gap-3 rounded-(--station-panel-radius) border p-4"
					>
						<div className="flex items-start gap-3">
							<Icon
								name="clock"
								className="text-warning mt-0.5 size-5 shrink-0"
								aria-hidden
							/>
							<div className="min-w-0 flex-1">
								<p className="text-base font-semibold break-words">
									<Trans>Did the delivery from {supplierName} arrive?</Trans>
								</p>
								<p className="text-muted-foreground text-sm">
									{_(t`Order ${orderNumber}`)}
									{expectedDate ? ` · ${expectedDate}` : ''}
								</p>
							</div>
						</div>
						{!allowed ? (
							<p className="text-muted-foreground text-sm font-medium">
								<Trans>A manager must sign in to receive a delivery.</Trans>
							</p>
						) : null}
						<div className="flex flex-wrap gap-2">
							<Button
								variant="primary"
								disabled={!allowed || busy}
								onClick={() => void answerAsOrdered(delivery)}
							>
								<Trans>Yes, as ordered</Trans>
							</Button>
							<Button
								disabled={!allowed || busy}
								onClick={() => onOpenWithChanges(delivery.orderId)}
							>
								<Trans>Yes, with changes</Trans>
							</Button>
							<Button
								disabled={!allowed || busy}
								onClick={() => openNotYet(delivery.orderId)}
							>
								<Trans>Not yet</Trans>
							</Button>
						</div>
						{pickingDate ? (
							<div className="border-border flex flex-wrap items-end gap-3 border-t pt-3">
								<label className="flex flex-col gap-1">
									<span className="text-sm font-medium">
										<Trans>When is it expected?</Trans>
									</span>
									<Input
										type="date"
										aria-label={_(
											t`New expected date for ${delivery.supplierName}`,
										)}
										min={todayIso}
										value={notYetDate}
										onChange={(event) => setNotYetDate(event.target.value)}
										className="w-44"
									/>
								</label>
								<Button
									variant="primary"
									disabled={busy || !isIsoDate(notYetDate)}
									onClick={() => void submitNotYet(delivery)}
								>
									<Trans>Save date</Trans>
								</Button>
								<Button
									variant="ghost"
									disabled={busy}
									onClick={() => setNotYetOrderId(null)}
								>
									<Trans>Cancel</Trans>
								</Button>
							</div>
						) : null}
						{error ? (
							<p role="alert" className="text-destructive text-sm">
								{error}
							</p>
						) : null}
					</div>
				)
			})}
		</section>
	)
}
