import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { MAX_RATE_CENTS } from '@repo/staffing'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useEffect, useState } from 'react'
import {
	type Position,
	type Staff,
	type StaffingLocation,
	staffName,
} from '#app/utils/staffing/client.ts'

export type RateInput = {
	locationId: string
	positionId: string
	rateCents: number | null
}

const AMOUNT_RE = /^\d{1,5}(?:[.,]\d{1,2})?$/

/** Parses "18", "18.5", or "18,50" to cents; `null` for blank, `undefined` if invalid. */
export function parseRate(value: string) {
	const trimmed = value.trim()
	if (!trimmed) return null
	if (!AMOUNT_RE.test(trimmed)) return undefined
	const cents = Math.round(Number(trimmed.replace(',', '.')) * 100)
	return cents <= MAX_RATE_CENTS ? cents : undefined
}

function toAmount(cents: number | null | undefined) {
	return cents === null || cents === undefined ? '' : (cents / 100).toFixed(2)
}

const keyOf = (item: { locationId: string; positionId: string }) =>
	`${item.locationId}|${item.positionId}`

export function PayRatesDialog({
	staff,
	onOpenChange,
	positions,
	locations,
	onSave,
}: {
	staff: Staff | null
	onOpenChange: (open: boolean) => void
	positions: Position[]
	locations: StaffingLocation[]
	onSave: (rates: RateInput[]) => Promise<string | null>
}) {
	const { _ } = useLingui()
	const [values, setValues] = useState<Record<string, string>>({})
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

	useEffect(() => {
		if (!staff) return
		setValues(
			Object.fromEntries(
				staff.assignments.map((item) => [
					keyOf(item),
					toAmount(item.rateCents),
				]),
			),
		)
		setError(null)
	}, [staff])

	if (!staff) return null
	const positionById = new Map(positions.map((item) => [item.id, item]))
	const locationById = new Map(locations.map((item) => [item.id, item]))
	const name = staffName(staff)
	const invalid = staff.assignments.some(
		(item) => parseRate(values[keyOf(item)] ?? '') === undefined,
	)

	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<form
					className="space-y-4"
					onSubmit={async (event) => {
						event.preventDefault()
						if (invalid) return
						setBusy(true)
						const message = await onSave(
							staff.assignments.map((item) => ({
								locationId: item.locationId,
								positionId: item.positionId,
								rateCents: parseRate(values[keyOf(item)] ?? '') ?? null,
							})),
						)
						setBusy(false)
						if (message) setError(message)
						else onOpenChange(false)
					}}
				>
					<DialogHeader>
						<DialogTitle>
							<Trans>Pay rates for {name}</Trans>
						</DialogTitle>
						<DialogDescription>
							<Trans>
								Hourly pay for each position, used for labor cost estimates.
								Time cards keep the rate they were made with. Leave blank for no
								rate.
							</Trans>
						</DialogDescription>
					</DialogHeader>
					{staff.assignments.length === 0 ? (
						<p className="bg-muted rounded-md p-3 text-sm">
							<Trans>Assign a location and position first.</Trans>
						</p>
					) : (
						<div className="space-y-3">
							{staff.assignments.map((item) => {
								const key = keyOf(item)
								const position =
									positionById.get(item.positionId)?.name ?? _(msg`Unknown`)
								const location = locationById.get(item.locationId)
								const label =
									locations.length > 1 && location
										? `${position} · ${location.name}`
										: position
								const currency = location?.currency ?? ''
								const value = values[key] ?? ''
								const bad = parseRate(value) === undefined
								return (
									<div key={key} className="space-y-1">
										<Label htmlFor={`rate-${key}`}>{label}</Label>
										<div className="flex items-center gap-2">
											<Input
												id={`rate-${key}`}
												inputMode="decimal"
												dir="ltr"
												className="w-32"
												aria-invalid={bad || undefined}
												placeholder="0.00"
												value={value}
												onChange={(event) =>
													setValues((current) => ({
														...current,
														[key]: event.target.value,
													}))
												}
											/>
											<span className="text-muted-foreground text-sm">
												<Trans>{currency} per hour</Trans>
											</span>
										</div>
									</div>
								)
							})}
						</div>
					)}
					{invalid ? (
						<p role="alert" className="text-destructive text-sm">
							<Trans>Enter an amount like 18.50.</Trans>
						</p>
					) : null}
					{error ? (
						<p role="alert" className="text-destructive text-sm">
							{error}
						</p>
					) : null}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							type="submit"
							disabled={busy || invalid || staff.assignments.length === 0}
						>
							<Trans>Save rates</Trans>
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
