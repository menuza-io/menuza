import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	BOTTLE_TENTHS_MAX,
	bottlesToMl,
	canCountByWeight,
	type ItemBottle,
	mlToBottleParts,
	openBottleMlFromWeight,
} from '@repo/inventory'
import { useState } from 'react'
import { BigStepper } from './BigStepper.tsx'
import { Button, Input } from '~/ui/primitives.tsx'

const TENTHS = Array.from({ length: BOTTLE_TENTHS_MAX + 1 }, (_, i) => i)

/**
 * Counting an open bottle on the tablet (#470): full bottles on the stepper,
 * the open bottle as one of eleven tenth buttons (0 to 1) or, when the item
 * knows its full and empty weight, typed from the scale. The answer is
 * millilitres, the same amount every other count entry holds.
 */
export function BottleInput({
	bottle,
	valueMl,
	label,
	onChange,
}: {
	bottle: ItemBottle
	valueMl: number | null
	label: string
	onChange: (ml: number | null) => void
}) {
	const { _ } = useLingui()
	const initial = mlToBottleParts(bottle, valueMl ?? 0)
	const [whole, setWhole] = useState(initial.whole)
	const [tenths, setTenths] = useState(initial.openTenths)
	const [byWeight, setByWeight] = useState(false)
	const [weight, setWeight] = useState('')
	const weighable = canCountByWeight(bottle)

	const emit = (next: { whole: number; tenths: number; weight: string }) => {
		if (byWeight) {
			const grams = Number(next.weight.replace(',', '.'))
			const open =
				next.weight.trim() === '' || !Number.isFinite(grams)
					? 0
					: (openBottleMlFromWeight(bottle, Math.max(0, grams)) ?? 0)
			onChange(bottlesToMl(bottle, next.whole, 0) + open)
		} else {
			onChange(bottlesToMl(bottle, next.whole, next.tenths))
		}
	}

	return (
		<div className="flex flex-col gap-3" role="group" aria-label={label}>
			<div className="flex flex-wrap items-center gap-3">
				<span className="text-muted-foreground text-sm">
					<Trans>Full bottles</Trans>
				</span>
				<BigStepper
					value={valueMl === null ? null : whole}
					label={_(t`Full bottles`)}
					step={1}
					fractions={false}
					onChange={(next) => {
						const count = Math.max(0, Math.floor(next ?? 0))
						setWhole(count)
						emit({ whole: count, tenths, weight })
					}}
				/>
			</div>
			{byWeight ? (
				<div className="flex flex-wrap items-center gap-3">
					<span className="text-muted-foreground text-sm">
						<Trans>Open bottle weight (g)</Trans>
					</span>
					<Input
						inputMode="decimal"
						dir="ltr"
						className="w-32"
						value={weight}
						aria-label={_(t`Open bottle weight in grams`)}
						onChange={(event) => {
							setWeight(event.target.value)
							emit({ whole, tenths, weight: event.target.value })
						}}
					/>
				</div>
			) : (
				<div className="flex flex-col gap-1">
					<span className="text-muted-foreground text-sm">
						<Trans>Open bottle</Trans>
					</span>
					<div className="flex flex-wrap gap-1.5" role="radiogroup">
						{TENTHS.map((tenth) => (
							<Button
								key={tenth}
								size="md"
								variant={tenth === tenths ? 'primary' : 'secondary'}
								className="min-w-12 px-2"
								role="radio"
								aria-checked={tenth === tenths}
								onClick={() => {
									setTenths(tenth)
									emit({ whole, tenths: tenth, weight })
								}}
							>
								<bdi dir="ltr" className="tnum">
									{(tenth / BOTTLE_TENTHS_MAX).toFixed(1)}
								</bdi>
							</Button>
						))}
					</div>
				</div>
			)}
			{weighable ? (
				<div>
					<Button
						size="md"
						variant="secondary"
						onClick={() => setByWeight((on) => !on)}
					>
						{byWeight ? (
							<Trans>Count in tenths</Trans>
						) : (
							<Trans>Count by weight</Trans>
						)}
					</Button>
				</div>
			) : null}
			{valueMl !== null ? (
				<span className="text-muted-foreground text-sm tabular-nums">
					<bdi dir="ltr">{valueMl.toLocaleString()} ml</bdi>
				</span>
			) : null}
		</div>
	)
}
