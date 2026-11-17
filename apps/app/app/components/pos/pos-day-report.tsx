import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { FieldLabel } from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import { Skeleton } from '@repo/ui/skeleton'
import { useEffect, useMemo, useState } from 'react'
import { z } from 'zod'
import { useOperatorClient } from '#app/hooks/use-operator-client.ts'
import { minorToMajorText, parseMoneyToMinor } from '#app/utils/money-input.ts'

const tender = z.object({
	paymentsCents: z.number(),
	refundsCents: z.number(),
	netCents: z.number(),
})
const summarySchema = z.object({
	orders: z.object({
		paid: z.number(),
		refunded: z.number(),
		cancelled: z.number(),
		open: z.number(),
	}),
	grossSalesCents: z.number(),
	refundsCents: z.number(),
	netSalesCents: z.number(),
	taxCents: z.number(),
	tipsCents: z.number(),
	byTender: z.object({ cash: tender, card: tender, other: tender }),
	voids: z.object({
		cancelledOrders: z.number(),
		cancelledCents: z.number(),
		removedItems: z.number(),
		removedCents: z.number(),
	}),
	cash: z.object({ expectedCents: z.number() }),
})
const shiftSchema = z.object({
	shift: z.object({
		id: z.string(),
		status: z.enum(['open', 'closed']),
		openedAt: z.number(),
		closedAt: z.number().nullable(),
		openedBy: z.object({ name: z.string() }).nullable(),
		closedBy: z.object({ name: z.string() }).nullable(),
		countedCashCents: z.number().nullable(),
		closedRemotelyBy: z
			.object({ id: z.string().optional(), name: z.string() })
			.nullable()
			.optional(),
		remoteCloseReason: z.string().nullable().optional(),
	}),
	summary: summarySchema,
	overShortCents: z.number().nullable(),
	terminal: z.object({
		code: z.string().nullable(),
		label: z.string().nullable(),
	}),
})
const daySchema = z.object({
	businessDate: z.string(),
	currency: z.string().nullable(),
	summary: summarySchema,
	byTerminal: z.array(
		z.object({
			terminal: z.object({ code: z.string(), label: z.string() }),
			summary: summarySchema,
		}),
	),
	shifts: z.array(shiftSchema),
})
type Day = z.infer<typeof daySchema>
type DayShift = Day['shifts'][number]

/** Today in the browser's zone, as YYYY-MM-DD. */
function today() {
	const now = new Date()
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/**
 * One business day of walk-in sales across every terminal: totals, tenders,
 * cancellations, and each cash drawer shift with what it was over or short.
 * Read straight from the regional server, like the rest of this page.
 */
export function PosDayReport({
	orgSlug,
	canCloseShifts = false,
}: {
	orgSlug: string
	canCloseShifts?: boolean
}) {
	const { _, i18n } = useLingui()
	const { request } = useOperatorClient(orgSlug, '/operator/pos')
	const [date, setDate] = useState(today)
	const [refreshKey, setRefreshKey] = useState(0)
	const [closingShift, setClosingShift] = useState<DayShift | null>(null)
	const [state, setState] = useState<
		| { status: 'loading' }
		| { status: 'error'; message: string }
		| { status: 'ready'; day: Day }
	>({
		status: 'loading',
	})

	useEffect(() => {
		let live = true
		setState({ status: 'loading' })
		request(`/reports/day?businessDate=${encodeURIComponent(date)}`).then(
			(body) =>
				live && setState({ status: 'ready', day: daySchema.parse(body) }),
			(error: unknown) =>
				live &&
				setState({
					status: 'error',
					message:
						error instanceof Error
							? error.message
							: _(t`Could not load the report.`),
				}),
		)
		return () => {
			live = false
		}
	}, [request, date, refreshKey, _])

	const currency =
		state.status === 'ready' ? (state.day.currency ?? 'USD') : 'USD'
	const money = useMemo(() => {
		const format = new Intl.NumberFormat(i18n.locale, {
			style: 'currency',
			currency,
		})
		return (cents: number) => format.format(cents / 100)
	}, [i18n.locale, currency])

	return (
		<Card
			role="region"
			aria-label={_(t`Day report`)}
			className="min-w-0 shadow-none"
		>
			<CardHeader className="border-b">
				<div className="flex flex-wrap items-center justify-between gap-4">
					<CardTitle as="h3">
						<Trans>Day report</Trans>
					</CardTitle>
					<FieldLabel className="flex flex-wrap items-center gap-2 text-sm">
						<span className="font-medium">
							<Trans>Business day</Trans>
						</span>
						<Input
							type="date"
							value={date}
							onChange={(e) => e.target.value && setDate(e.target.value)}
							className="h-11 w-44 md:h-9"
							dir="ltr"
						/>
					</FieldLabel>
				</div>
			</CardHeader>
			<CardContent className="@container">
				{state.status === 'loading' ? (
					<Skeleton className="h-40 w-full" />
				) : state.status === 'error' ? (
					<Alert variant="destructive">
						<AlertDescription>{state.message}</AlertDescription>
					</Alert>
				) : (
					<DayBody
						day={state.day}
						money={money}
						canCloseShifts={canCloseShifts}
						onCloseShift={setClosingShift}
					/>
				)}
			</CardContent>
			{closingShift ? (
				<RemoteCloseDialog
					shift={closingShift}
					currency={currency}
					money={money}
					onCancel={() => setClosingShift(null)}
					onConfirm={async (countedCashCents, reason) => {
						await request(`/shifts/${closingShift.shift.id}/close`, {
							method: 'POST',
							tokenQuery: 'shift=1',
							body: JSON.stringify({ countedCashCents, reason }),
						})
						setClosingShift(null)
						setRefreshKey((k) => k + 1)
					}}
				/>
			) : null}
		</Card>
	)
}

function ShiftCash({
	expected,
	counted,
}: {
	expected: string
	counted: string | null
}) {
	return counted === null ? (
		<Trans>Expected {expected}</Trans>
	) : (
		<Trans>
			Expected {expected}, counted {counted}
		</Trans>
	)
}

function DayBody({
	day,
	money,
	canCloseShifts,
	onCloseShift,
}: {
	day: Day
	money: (cents: number) => string
	canCloseShifts: boolean
	onCloseShift: (shift: DayShift) => void
}) {
	const { _ } = useLingui()
	const s = day.summary
	if (
		s.orders.paid + s.orders.refunded + s.orders.cancelled + s.orders.open ===
			0 &&
		day.shifts.length === 0
	) {
		return (
			<p className="text-muted-foreground py-6 text-center text-sm">
				<Trans>No walk-in sales on this day.</Trans>
			</p>
		)
	}
	const totals: Array<[string, string]> = [
		[_(t`Sales`), money(s.grossSalesCents)],
		[_(t`Refunds`), `-${money(s.refundsCents)}`],
		[_(t`Net sales`), money(s.netSalesCents)],
	]
	const rows: Array<[string, string]> = [
		[_(t`Tax`), money(s.taxCents)],
		[_(t`Tips`), money(s.tipsCents)],
		[_(t`Cash`), money(s.byTender.cash.netCents)],
		[_(t`Card`), money(s.byTender.card.netCents)],
		[_(t`Other`), money(s.byTender.other.netCents)],
		[
			_(t`Cancelled orders`),
			`${s.voids.cancelledOrders} (${money(s.voids.cancelledCents)})`,
		],
		[
			_(t`Items taken off tabs`),
			`${s.voids.removedItems} (${money(s.voids.removedCents)})`,
		],
		[_(t`Tabs still open`), String(s.orders.open)],
	]
	return (
		<div className="flex flex-col gap-5">
			<dl className="border-border grid grid-cols-1 gap-4 border-b pb-5 @lg:grid-cols-3 @lg:gap-6">
				{totals.map(([label, value]) => (
					<div
						key={label}
						className="flex items-baseline justify-between gap-3 @lg:block @lg:space-y-2"
					>
						<dt className="text-muted-foreground text-sm">{label}</dt>
						<dd className="text-xl font-semibold tracking-tight tabular-nums">
							{value}
						</dd>
					</div>
				))}
			</dl>
			<dl className="grid grid-cols-1 gap-x-10 gap-y-3 text-sm @lg:grid-cols-2">
				{rows.map(([label, value]) => (
					<div key={label} className="flex justify-between gap-3">
						<dt className="text-muted-foreground">{label}</dt>
						<dd className="shrink-0 font-medium tabular-nums">{value}</dd>
					</div>
				))}
			</dl>
			{day.byTerminal.length > 1 ? (
				<ul
					className="flex flex-col gap-1 text-sm"
					aria-label={_(t`Sales by terminal`)}
				>
					{day.byTerminal.map(({ terminal, summary }) => (
						<li key={terminal.code} className="flex justify-between gap-3">
							<span className="wrap-anywhere">
								{terminal.label} ({terminal.code})
							</span>
							<span className="tabular-nums">
								{money(summary.netSalesCents)}
							</span>
						</li>
					))}
				</ul>
			) : null}
			{day.shifts.length > 0 ? (
				<ul
					className="flex flex-col gap-2"
					aria-label={_(t`Cash drawer shifts`)}
				>
					{day.shifts.map(({ shift, summary, overShortCents, terminal }) => {
						const difference = money(Math.abs(overShortCents ?? 0))
						return (
							<li
								key={shift.id}
								className="border-border flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm"
							>
								<div className="min-w-0 flex-1">
									<p className="font-medium wrap-anywhere">
										{terminal.label ?? terminal.code}
										{shift.openedBy ? ` · ${shift.openedBy.name}` : ''}
									</p>
									<p className="text-muted-foreground">
										<ShiftCash
											expected={money(summary.cash.expectedCents)}
											counted={
												shift.countedCashCents === null
													? null
													: money(shift.countedCashCents)
											}
										/>
									</p>
									{(() => {
										const remoteCloserName = shift.closedRemotelyBy?.name
										return remoteCloserName ? (
											<p className="text-muted-foreground text-xs wrap-anywhere">
												<Trans>Closed remotely by {remoteCloserName}</Trans>
												{shift.remoteCloseReason
													? ` — ${shift.remoteCloseReason}`
													: ''}
											</p>
										) : null
									})()}
								</div>
								{shift.status === 'open' ? (
									<div className="flex items-center gap-2">
										<Badge variant="outline">
											<Trans>Open</Trans>
										</Badge>
										{canCloseShifts ? (
											<Button
												type="button"
												variant="outline"
												size="sm"
												onClick={() =>
													onCloseShift({
														shift,
														summary,
														overShortCents,
														terminal,
													})
												}
											>
												<Trans>Close shift</Trans>
											</Button>
										) : null}
									</div>
								) : overShortCents === 0 ? (
									<Badge variant="secondary">
										<Trans>Balanced</Trans>
									</Badge>
								) : overShortCents !== null && overShortCents > 0 ? (
									<Badge variant="secondary">
										<Trans>Over {difference}</Trans>
									</Badge>
								) : (
									<Badge variant="destructive">
										<Trans>Short {difference}</Trans>
									</Badge>
								)}
							</li>
						)
					})}
				</ul>
			) : null}
		</div>
	)
}

function RemoteCloseDialog({
	shift,
	currency,
	money,
	onCancel,
	onConfirm,
}: {
	shift: DayShift
	currency: string
	money: (cents: number) => string
	onCancel: () => void
	onConfirm: (countedCashCents: number, reason: string) => Promise<void>
}) {
	const { _ } = useLingui()
	const [countedText, setCountedText] = useState('')
	const [reason, setReason] = useState('')
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const terminalLabel = shift.terminal.label ?? shift.terminal.code ?? ''
	const expectedCashText = money(shift.summary.cash.expectedCents)

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !saving) onCancel()
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						<Trans>Close shift remotely</Trans>
					</DialogTitle>
					<DialogDescription>
						{terminalLabel ? (
							<Trans>
								Terminal {terminalLabel}. Expected cash in drawer:{' '}
								{expectedCashText}. Closing cannot be undone.
							</Trans>
						) : (
							<Trans>
								Expected cash in drawer: {expectedCashText}. Closing cannot be
								undone.
							</Trans>
						)}
					</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-4"
					onSubmit={async (event) => {
						event.preventDefault()
						const minor = parseMoneyToMinor(countedText, {
							currency,
							min: 0,
							max: 100_000_000,
						})
						if (minor === null) {
							setError(_(t`Enter a valid counted cash amount.`))
							return
						}
						const trimmedReason = reason.trim()
						if (!trimmedReason) {
							setError(_(t`Enter a reason for closing this shift remotely.`))
							return
						}
						setSaving(true)
						setError(null)
						try {
							await onConfirm(minor, trimmedReason)
						} catch (err) {
							setError(
								err instanceof Error
									? err.message
									: _(t`Could not close the shift.`),
							)
							setSaving(false)
						}
					}}
				>
					<FieldLabel className="flex flex-col gap-1.5 text-sm font-medium">
						<Trans>Counted cash</Trans>
						<Input
							inputMode="decimal"
							dir="ltr"
							placeholder={minorToMajorText(0, currency)}
							value={countedText}
							onChange={(e) => setCountedText(e.target.value)}
							disabled={saving}
						/>
					</FieldLabel>
					<FieldLabel className="flex flex-col gap-1.5 text-sm font-medium">
						<Trans>Reason</Trans>
						<Input
							maxLength={280}
							placeholder={_(t`Cashier left without closing the drawer`)}
							value={reason}
							onChange={(e) => setReason(e.target.value)}
							disabled={saving}
						/>
					</FieldLabel>
					{error ? (
						<Alert variant="destructive">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={onCancel}
							disabled={saving}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button type="submit" disabled={saving}>
							<Trans>Confirm close</Trans>
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
