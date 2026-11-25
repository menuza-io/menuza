'use client'

import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	distanceBandRanges,
	MAX_DELIVERY_DISTANCE_BANDS,
	MAX_DELIVERY_FEE_STEPS,
	type DeliveryDistanceFees,
	type DeliveryFeeStep,
	type DistanceMode,
	type FeeTableProblem,
} from '@repo/common/delivery-fees'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'

/**
 * The fee tables of a delivery zone: a fee by order size (#244) and a fee by
 * distance (#421). Controlled and presentational; the zone dialog owns the
 * values and checks them with `validateFeeSteps` / `validateDistanceBands`.
 */

export function useTableProblemText() {
	const { _ } = useLingui()
	const maxSteps = MAX_DELIVERY_FEE_STEPS
	const maxBands = MAX_DELIVERY_DISTANCE_BANDS
	return (problem: FeeTableProblem | 'invalid_table' | null): string | null => {
		switch (problem) {
			case null:
				return null
			case 'steps_not_distinct':
				return _(msg`Each step needs a different order amount.`)
			case 'steps_first_not_minimum':
				return _(msg`The first step starts at the minimum order.`)
			case 'steps_too_many':
				return _(msg`Use at most ${maxSteps} steps.`)
			case 'bands_not_distinct':
				return _(msg`Each band needs a different distance.`)
			case 'bands_first_not_zero':
				return _(msg`The first band starts at zero.`)
			case 'bands_too_many':
				return _(msg`Use at most ${maxBands} bands.`)
			case 'invalid_table':
				return _(msg`Check the amounts in this table.`)
		}
	}
}

/** Sorts the steps and pins the first to the zone's minimum order. */
export function normalizeFeeSteps(
	steps: readonly DeliveryFeeStep[],
	minimumOrder: number,
): DeliveryFeeStep[] {
	const sorted = [...steps].sort((a, b) => a.from - b.from)
	return sorted.map((step, index) =>
		index === 0 ? { ...step, from: minimumOrder } : step,
	)
}

/** Sorts the bands and pins the first to zero. */
export function normalizeDistanceBands(
	fees: DeliveryDistanceFees,
): DeliveryDistanceFees {
	const sorted = [...fees.bands].sort((a, b) => a.from - b.from)
	return {
		...fees,
		bands: sorted.map((band, index) =>
			index === 0 ? { ...band, from: 0 } : band,
		),
	}
}

const number = (value: string) => {
	const parsed = parseFloat(value)
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

export function FeeStepsEditor({
	steps,
	minimumOrder,
	onChange,
	error,
}: {
	steps: DeliveryFeeStep[]
	minimumOrder: number
	onChange: (steps: DeliveryFeeStep[]) => void
	error: string | null
}) {
	const { _ } = useLingui()
	const update = (index: number, patch: Partial<DeliveryFeeStep>) =>
		onChange(
			steps.map((step, stepIndex) =>
				stepIndex === index ? { ...step, ...patch } : step,
			),
		)
	return (
		<div className="space-y-2 rounded-md border p-3" data-testid="fee-steps">
			<p className="text-muted-foreground text-xs">
				<Trans>
					From this order amount, charge this fee. The amount is the items total
					before discounts, tax and tip, the same total the minimum order uses. A
					free delivery discount still applies on top.
				</Trans>
			</p>
			{steps.map((step, index) => (
				<div key={index} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
					<div className="space-y-1">
						<Label htmlFor={`fee-step-from-${index}`} className="text-xs">
							<Trans>From order amount ($)</Trans>
						</Label>
						<Input
							id={`fee-step-from-${index}`}
							type="number"
							step="0.50"
							min="0"
							value={index === 0 ? minimumOrder : step.from}
							disabled={index === 0}
							onChange={(event) => update(index, { from: number(event.target.value) })}
						/>
					</div>
					<div className="space-y-1">
						<Label htmlFor={`fee-step-fee-${index}`} className="text-xs">
							<Trans>Fee ($)</Trans>
						</Label>
						<Input
							id={`fee-step-fee-${index}`}
							type="number"
							step="0.50"
							min="0"
							value={step.fee}
							onChange={(event) => update(index, { fee: number(event.target.value) })}
						/>
					</div>
					<Button
						type="button"
						size="icon-sm"
						variant="ghost"
						disabled={steps.length <= 1}
						onClick={() => onChange(steps.filter((_item, i) => i !== index))}
						aria-label={_(msg`Remove step`)}
					>
						<Icon name="trash-2" className="size-3.5" />
					</Button>
				</div>
			))}
			<div className="flex items-center justify-between gap-2">
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={steps.length >= MAX_DELIVERY_FEE_STEPS}
					onClick={() => {
						const last = steps[steps.length - 1]
						onChange([
							...steps,
							{ from: (last?.from ?? minimumOrder) + 10, fee: 0 },
						])
					}}
				>
					<Icon name="plus" className="mr-1.5 size-3.5" />
					<Trans>Add step</Trans>
				</Button>
				{error ? (
					<p role="alert" className="text-destructive text-xs">
						{error}
					</p>
				) : null}
			</div>
		</div>
	)
}

export function DistanceBandsEditor({
	fees,
	onChange,
	error,
}: {
	fees: DeliveryDistanceFees
	onChange: (fees: DeliveryDistanceFees) => void
	error: string | null
}) {
	const { _ } = useLingui()
	const unit = fees.unit === 'km' ? _(msg`km`) : _(msg`mi`)
	const ranges = distanceBandRanges(fees)
	const update = (index: number, patch: Partial<DeliveryFeeStep>) =>
		onChange({
			...fees,
			bands: fees.bands.map((band, bandIndex) =>
				bandIndex === index ? { ...band, ...patch } : band,
			),
		})
	return (
		<div className="space-y-2 rounded-md border p-3" data-testid="distance-bands">
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<div className="space-y-1">
					<Label htmlFor="distance-mode" className="text-xs">
						<Trans>Measure distance</Trans>
					</Label>
					<Select
						value={fees.mode}
						items={{
							straight_line: _(msg`In a straight line`),
							driving: _(msg`By road (driving distance)`),
						}}
						onValueChange={(value) =>
							value && onChange({ ...fees, mode: value as DistanceMode })
						}
					>
						<SelectTrigger id="distance-mode">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="straight_line">
								<Trans>In a straight line</Trans>
							</SelectItem>
							<SelectItem value="driving">
								<Trans>By road (driving distance)</Trans>
							</SelectItem>
						</SelectContent>
					</Select>
				</div>
				<div className="space-y-1">
					<Label htmlFor="distance-unit" className="text-xs">
						<Trans>Distance unit</Trans>
					</Label>
					<Select
						value={fees.unit}
						items={{ km: _(msg`Kilometres`), miles: _(msg`Miles`) }}
						onValueChange={(value) =>
							value && onChange({ ...fees, unit: value as 'km' | 'miles' })
						}
					>
						<SelectTrigger id="distance-unit">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="km">
								<Trans>Kilometres</Trans>
							</SelectItem>
							<SelectItem value="miles">
								<Trans>Miles</Trans>
							</SelectItem>
						</SelectContent>
					</Select>
				</div>
			</div>
			{fees.mode === 'driving' ? (
				<p className="text-muted-foreground text-xs">
					<Trans>
						If the routing service cannot answer, the straight-line distance sets
						the fee instead.
					</Trans>
				</p>
			) : null}
			{fees.bands.map((band, index) => {
				const range = ranges[index]
				const to = range?.to
				const fromDistance = band.from
				return (
					<div
						key={index}
						className="grid grid-cols-[1fr_1fr_auto] items-end gap-2"
					>
						<div className="space-y-1">
							<Label htmlFor={`band-from-${index}`} className="text-xs">
								{to == null ? (
									<Trans>
										From {fromDistance} {unit} and further
									</Trans>
								) : (
									<Trans>
										From {fromDistance} to {to} {unit}
									</Trans>
								)}
							</Label>
							<Input
								id={`band-from-${index}`}
								type="number"
								step="0.5"
								min="0"
								value={index === 0 ? 0 : band.from}
								disabled={index === 0}
								onChange={(event) => update(index, { from: number(event.target.value) })}
							/>
						</div>
						<div className="space-y-1">
							<Label htmlFor={`band-fee-${index}`} className="text-xs">
								<Trans>Fee ($)</Trans>
							</Label>
							<Input
								id={`band-fee-${index}`}
								type="number"
								step="0.50"
								min="0"
								value={band.fee}
								onChange={(event) => update(index, { fee: number(event.target.value) })}
							/>
						</div>
						<Button
							type="button"
							size="icon-sm"
							variant="ghost"
							disabled={fees.bands.length <= 1}
							onClick={() =>
								onChange({
									...fees,
									bands: fees.bands.filter((_item, i) => i !== index),
								})
							}
							aria-label={_(msg`Remove band`)}
						>
							<Icon name="trash-2" className="size-3.5" />
						</Button>
					</div>
				)
			})}
			<div className="flex items-center justify-between gap-2">
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={fees.bands.length >= MAX_DELIVERY_DISTANCE_BANDS}
					onClick={() => {
						const last = fees.bands[fees.bands.length - 1]
						onChange({
							...fees,
							bands: [
								...fees.bands,
								{ from: (last?.from ?? 0) + 3, fee: last?.fee ?? 0 },
							],
						})
					}}
				>
					<Icon name="plus" className="mr-1.5 size-3.5" />
					<Trans>Add band</Trans>
				</Button>
				{error ? (
					<p role="alert" className="text-destructive text-xs">
						{error}
					</p>
				) : null}
			</div>
		</div>
	)
}
