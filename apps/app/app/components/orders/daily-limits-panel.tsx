import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	type DailyDishStatusData,
	type DailyDishStatusRowData,
	dailyDishStatusSchema,
	DAILY_DISH_MAX_UNITS,
} from '@repo/common/daily-dish-limits'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Input } from '@repo/ui/input'
import { useCallback, useEffect, useState } from 'react'
import { useFetcher } from 'react-router'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { dailyLimitAllowance } from '#app/utils/orders/daily-limit-top-up.ts'

export type DailyLimitsLocation = { id: string; name: string }

type TopUpResult = { ok: boolean; error?: string | null }

/** The quick adds a manager reaches for when a fresh batch comes out. */
const QUICK_ADDS = [5, 10] as const

/**
 * "Today's dish limits" on the Orders page (#409): what is left of every dish
 * and option that has a daily limit at a location, and the manager's way to
 * add more or state the amount left. The App loader only lists locations while
 * the feature is on and something has a limit, so the panel never shows empty;
 * the counts are read from the region by the browser.
 */
export function DailyLimitsPanel({
	orgSlug,
	locations,
	canWrite,
	request,
}: {
	orgSlug: string
	locations: DailyLimitsLocation[]
	canWrite: boolean
	request: (path: string, init?: RequestInit) => Promise<unknown>
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<TopUpResult>()
	const [activeLocationId, setActiveLocationId] = useState(
		locations[0]?.id ?? '',
	)
	const [status, setStatus] = useState<DailyDishStatusData | null>(null)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)

	const location =
		locations.find((row) => row.id === activeLocationId) ?? locations[0]

	const load = useCallback(async () => {
		if (!location) return
		setError(null)
		try {
			const params = new URLSearchParams({ locationId: location.id })
			const body = await request(`/daily-limits?${params.toString()}`)
			const parsed = dailyDishStatusSchema.safeParse(body)
			if (!parsed.success) throw new Error('unreadable')
			setStatus(parsed.data)
		} catch (failure) {
			if (failure instanceof OperatorRequestError && failure.status === 404) {
				// Not on for this location any more: nothing to show.
				setStatus(null)
				return
			}
			setError(_(msg`Could not load today's dish limits.`))
		} finally {
			setLoading(false)
		}
	}, [_, location, request])

	useEffect(() => {
		setLoading(true)
		void load()
	}, [load])

	useEffect(() => {
		if (fetcher.state === 'idle' && fetcher.data?.ok) void load()
	}, [fetcher.data, fetcher.state, load])

	if (!location) return null
	// Nothing to look at while the first read is still out.
	if (loading && !status) return null
	if (!loading && !error && (status === null || !status.enabled)) return null

	const busy = fetcher.state !== 'idle'
	const failed = fetcher.state === 'idle' && fetcher.data?.ok === false

	const submit = (
		row: DailyDishStatusRowData,
		change: { addUnits: number } | { amountLeft: number },
	) => {
		const body = new FormData()
		body.set('locationId', location.id)
		body.set('key', row.key)
		if ('addUnits' in change) body.set('addUnits', String(change.addUnits))
		else body.set('amountLeft', String(change.amountLeft))
		void fetcher.submit(body, {
			method: 'post',
			action: `/${orgSlug}/orders/daily-limits-top-up`,
		})
	}

	return (
		<section
			className="space-y-3 rounded-lg border p-4"
			aria-labelledby="daily-limits-title"
			data-testid="daily-limits-panel"
		>
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div>
					<h2 id="daily-limits-title" className="font-medium">
						<Trans>Today's dish limits</Trans>
					</h2>
					<p className="text-muted-foreground text-sm">
						<Trans>
							What is left of each dish with a daily limit. The count starts
							again each business day.
						</Trans>
					</p>
				</div>
				{locations.length > 1 ? (
					<label className="flex items-center gap-2 text-sm">
						<span className="text-muted-foreground">
							<Trans>Location</Trans>
						</span>
						<select
							className="border-input bg-background rounded-md border px-2 py-1"
							value={activeLocationId}
							onChange={(event) => setActiveLocationId(event.target.value)}
						>
							{locations.map((row) => (
								<option key={row.id} value={row.id}>
									{row.name}
								</option>
							))}
						</select>
					</label>
				) : null}
			</div>

			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : null}
			{failed ? (
				<p role="alert" className="text-destructive text-sm">
					{fetcher.data?.error === 'daily_limit_not_found' ? (
						<Trans>This dish no longer has a daily limit here.</Trans>
					) : (
						<Trans>Could not change the limit. Try again.</Trans>
					)}
				</p>
			) : null}

			{status && status.rows.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					<Trans>No dish has a daily limit at this location.</Trans>
				</p>
			) : null}

			{status && status.rows.length > 0 ? (
				<ul className="divide-border divide-y text-sm">
					{status.rows.map((row) => (
						<DailyLimitRow
							key={row.key}
							row={row}
							canWrite={canWrite}
							busy={busy}
							onChange={(change) => submit(row, change)}
						/>
					))}
				</ul>
			) : null}
		</section>
	)
}

function DailyLimitRow({
	row,
	canWrite,
	busy,
	onChange,
}: {
	row: DailyDishStatusRowData
	canWrite: boolean
	busy: boolean
	onChange: (change: { addUnits: number } | { amountLeft: number }) => void
}) {
	const { _ } = useLingui()
	const [amountLeft, setAmountLeft] = useState('')
	const { name, soldUnits, heldUnits, remaining } = row
	const allowance = dailyLimitAllowance(row)
	const soldOut = remaining === 0
	const parsedAmount = /^\d+$/.test(amountLeft.trim())
		? Number(amountLeft.trim())
		: null
	const amountValid =
		parsedAmount !== null && parsedAmount <= DAILY_DISH_MAX_UNITS

	return (
		<li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
			<div className="min-w-0">
				<div className="flex flex-wrap items-center gap-2">
					<span className="font-medium wrap-anywhere">{row.name}</span>
					{row.kind === 'option' ? (
						<Badge variant="secondary" className="text-[10px] font-normal">
							<Trans>Option</Trans>
						</Badge>
					) : null}
					{soldOut ? (
						<Badge variant="destructive" className="text-[10px] font-normal">
							<Trans>Sold out</Trans>
						</Badge>
					) : null}
				</div>
				<p className="text-muted-foreground text-xs tabular-nums">
					<Trans>
						{soldUnits} sold, {heldUnits} waiting for payment, limit today{' '}
						{allowance}
					</Trans>
				</p>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<span
					className="min-w-16 text-sm font-medium tabular-nums"
					data-testid="daily-limit-remaining"
				>
					<Trans>{remaining} left</Trans>
				</span>
				{canWrite ? (
					<>
						{QUICK_ADDS.map((units) => (
							<Button
								key={units}
								type="button"
								variant="outline"
								size="sm"
								disabled={busy}
								onClick={() => onChange({ addUnits: units })}
								aria-label={_(msg`Add ${units} to ${name}`)}
							>
								+{units}
							</Button>
						))}
						<Input
							type="number"
							inputMode="numeric"
							min={0}
							max={DAILY_DISH_MAX_UNITS}
							step={1}
							value={amountLeft}
							onChange={(event) => setAmountLeft(event.target.value)}
							placeholder={_(msg`Amount left`)}
							aria-label={_(msg`Amount left of ${name}`)}
							className="h-8 w-28 text-xs"
						/>
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={busy || !amountValid}
							onClick={() => {
								if (parsedAmount !== null) {
									onChange({ amountLeft: parsedAmount })
									setAmountLeft('')
								}
							}}
						>
							<Trans>Set amount left</Trans>
						</Button>
					</>
				) : null}
			</div>
		</li>
	)
}
