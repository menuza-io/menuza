import { type MessageDescriptor } from '@lingui/core'
import { msg, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	DAILY_DISH_MAX_UNITS,
	type DailyDishChangeBody,
	type DailyDishStatusData,
	type DailyDishStatusRowData,
} from '@repo/common/daily-dish-limits'
import { Icon } from '@repo/ui/icon'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type OrdersApi, OrdersError } from './api.ts'
import { Badge, Button, Input } from '~/ui/primitives.tsx'

/** The quick top-ups: a fresh batch of 5 or 10 came out of the kitchen. */
const QUICK_TOP_UPS = [5, 10] as const

function failureText(
	_: (descriptor: MessageDescriptor) => string,
	error: unknown,
): string {
	const code = error instanceof OrdersError ? error.code : ''
	if (code === 'permission_required')
		return _(msg`Only a manager can change this.`)
	if (code === 'daily_limit_not_found')
		return _(msg`That dish no longer has a daily limit here.`)
	// A write that timed out or lost its connection may still have gone
	// through: never claim it did not. The list is read again.
	return _(
		msg`That may not have gone through. Check what is shown below before trying again.`,
	)
}

/** What a typed "amount left" is, or null when it is not a whole number in range. */
export function parseAmountLeft(text: string): number | null {
	const digits = text.trim()
	if (!/^\d{1,5}$/.test(digits)) return null
	const value = Number(digits)
	return value <= DAILY_DISH_MAX_UNITS ? value : null
}

/**
 * "Daily limits" in the manager controls (#409): how many of each limited dish
 * or option can still be sold today at this location, and the way to top it up
 * mid-service (add a batch, or say how many are left after a count). Counts
 * start again with the next business day. Every change goes to the region at
 * once and the list is read again after each answer; offline nothing is
 * offered and nothing is kept to send later. Hidden while the feature is off or
 * no dish has a limit here.
 */
export function DailyLimitsSection({
	open,
	online,
	api,
}: {
	open: boolean
	online: boolean
	api: Pick<OrdersApi, 'dailyLimits' | 'topUpDailyLimit'>
}) {
	const { _ } = useLingui()
	const [status, setStatus] = useState<DailyDishStatusData | null>(null)
	const [busy, setBusy] = useState<string | null>(null)
	const [failure, setFailure] = useState<string | null>(null)
	const [editing, setEditing] = useState<string | null>(null)
	const [amount, setAmount] = useState('')
	const asked = useRef(0)

	const load = useCallback(async () => {
		const ask = ++asked.current
		try {
			const next = await api.dailyLimits()
			if (ask === asked.current) setStatus(next)
		} catch {
			// An older node has no such route, and a lost connection already
			// shows in the sheet: the section just stays out of the way. What it
			// last showed stays (with any error) rather than vanishing.
		}
	}, [api])
	useEffect(() => {
		if (!open) {
			asked.current += 1
			// Never show the last opening's numbers as current.
			setStatus(null)
			setEditing(null)
			setAmount('')
			setFailure(null)
			return
		}
		if (online) void load()
	}, [open, online, load])

	const change = async (
		row: DailyDishStatusRowData,
		body: DailyDishChangeBody,
	) => {
		if (!online || busy) return false
		setBusy(row.key)
		setFailure(null)
		try {
			await api.topUpDailyLimit(body)
			await load()
			return true
		} catch (error) {
			setFailure(failureText(_, error))
			// Whatever happened, show what is true now.
			await load()
			return false
		} finally {
			setBusy(null)
		}
	}

	if (!status?.enabled || status.rows.length === 0) return null
	const disabled = !online || busy !== null
	return (
		<section
			aria-labelledby="controls-daily-limits"
			className="flex flex-col gap-3"
		>
			<h3 id="controls-daily-limits" className="font-semibold">
				<Trans>Daily limits</Trans>
			</h3>
			<p className="text-muted-foreground text-sm">
				<Trans>
					How many of each limited dish can still be sold today. Add more when
					the kitchen makes another batch, or set the number left after a count.
					The count starts again with the next business day.
				</Trans>
			</p>
			{failure ? (
				<p role="alert" className="notice-warning px-4 py-2 text-sm">
					{failure}
				</p>
			) : null}
			<ul className="divide-border border-border divide-y rounded-(--station-control-radius) border">
				{status.rows.map((row) => {
					const soldOut = row.remaining === 0
					const typed = parseAmountLeft(amount)
					return (
						<li
							key={row.key}
							className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2"
						>
							<span className="me-auto min-w-0">
								<bdi className="block truncate">{row.name}</bdi>
								{row.kind === 'option' ? (
									<span className="text-muted-foreground block text-xs">
										<Trans>Option</Trans>
									</span>
								) : null}
								<span className="text-muted-foreground block text-xs">
									<Trans>
										{row.soldUnits} sold · {row.heldUnits} waiting for payment
									</Trans>
								</span>
							</span>
							{soldOut ? (
								<Badge tone="danger">
									<Trans>Sold out</Trans>
								</Badge>
							) : (
								<Badge tone={row.remaining <= 5 ? 'warning' : 'success'}>
									<Trans>Left: {row.remaining}</Trans>
								</Badge>
							)}
							{QUICK_TOP_UPS.map((units) => (
								<Button
									key={units}
									variant="outline"
									disabled={disabled}
									// The visible words lead the name (voice control: "Add 5").
									aria-label={_(t`Add ${units}: ${row.name}`)}
									onClick={() =>
										void change(row, { key: row.key, addUnits: units })
									}
								>
									{busy === row.key ? (
										<Icon name="refresh-cw" className="size-4" />
									) : null}
									+{units}
								</Button>
							))}
							<Button
								variant="outline"
								disabled={disabled}
								aria-label={_(t`Set amount left: ${row.name}`)}
								onClick={() => {
									setEditing(editing === row.key ? null : row.key)
									setAmount(String(row.remaining))
								}}
							>
								<Trans>Set amount left</Trans>
							</Button>
							{editing === row.key ? (
								<form
									className="flex w-full flex-wrap items-center gap-2"
									onSubmit={(event) => {
										event.preventDefault()
										if (typed === null) return
										void change(row, { key: row.key, amountLeft: typed }).then(
											(ok) => {
												if (ok) setEditing(null)
											},
										)
									}}
								>
									<Input
										type="text"
										inputMode="numeric"
										aria-label={_(t`Amount left: ${row.name}`)}
										className="w-28"
										value={amount}
										maxLength={5}
										onChange={(event) => setAmount(event.target.value)}
									/>
									<Button
										type="submit"
										variant="primary"
										disabled={disabled || typed === null}
									>
										<Trans>Save</Trans>
									</Button>
									<Button
										type="button"
										variant="ghost"
										disabled={busy !== null}
										onClick={() => setEditing(null)}
									>
										<Trans>Cancel</Trans>
									</Button>
									{typed === null && amount.trim() !== '' ? (
										<span role="alert" className="text-warning text-xs">
											<Trans>Enter a whole number, 0 or more.</Trans>
										</span>
									) : null}
								</form>
							) : null}
						</li>
					)
				})}
			</ul>
		</section>
	)
}
