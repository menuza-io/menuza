import { Trans, useLingui } from '@lingui/react/macro'
import {
	BOTTLE_TENTHS_MAX,
	bottlesToMl,
	canCountByWeight,
	type ItemBottle,
	mlToBottleParts,
	openBottleMlFromWeight,
} from '@repo/inventory'
import { Input } from '@repo/ui/input'
import { QuantityStepper } from '@repo/ui/quantity-stepper'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { useId, useState } from 'react'

/**
 * Counting an open bottle (#470): whole full bottles, plus the open one in
 * tenths (a slider on the bottle) or by its weight on a scale, from the full
 * and empty weights the item stores. The answer is millilitres, the amount an
 * ordinary count entry holds, so expected against counted works as for any
 * item. Weight is typed; there is no scale connection.
 */

type Mode = 'tenths' | 'weight'

export function BottleCountInput({
	bottle,
	valueMl,
	onValueMl,
	label,
}: {
	bottle: ItemBottle
	/** What the row holds now, in millilitres (`null` while blank). */
	valueMl: number | null
	onValueMl: (ml: number | null) => void
	label: string
}) {
	const { t, i18n } = useLingui()
	const sliderId = useId()
	const weightId = useId()
	const byWeight = canCountByWeight(bottle)
	const [mode, setMode] = useState<Mode>('tenths')
	const parts = mlToBottleParts(bottle, valueMl ?? 0)
	const [whole, setWhole] = useState(parts.whole)
	const [tenths, setTenths] = useState(parts.openTenths)
	const [weightText, setWeightText] = useState('')
	const touched = valueMl !== null

	function emit(next: { whole: number; tenths: number; weightG: string }) {
		if (mode === 'weight') {
			const grams = Number(next.weightG.replace(',', '.'))
			const open =
				next.weightG.trim() === '' || !Number.isFinite(grams)
					? 0
					: (openBottleMlFromWeight(bottle, Math.max(0, grams)) ?? 0)
			onValueMl(bottlesToMl(bottle, next.whole, 0) + open)
			return
		}
		onValueMl(bottlesToMl(bottle, next.whole, next.tenths))
	}

	const bottles = valueMl === null ? 0 : valueMl / bottle.sizeMl
	const tenthsText = new Intl.NumberFormat(i18n.locale, {
		minimumFractionDigits: 1,
		maximumFractionDigits: 1,
	}).format(tenths / BOTTLE_TENTHS_MAX)
	const bottlesText = new Intl.NumberFormat(i18n.locale, {
		maximumFractionDigits: 2,
	}).format(bottles)
	const mlText =
		valueMl === null ? '' : new Intl.NumberFormat(i18n.locale).format(valueMl)
	const fill = mode === 'weight' ? null : tenths / BOTTLE_TENTHS_MAX

	return (
		<div
			className="flex flex-col gap-3 md:items-end"
			data-testid="bottle-count"
			role="group"
			aria-label={label}
		>
			{byWeight ? (
				<ToggleGroup
					variant="segmented"
					value={[mode]}
					onValueChange={(next) => {
						if (next[0] === 'tenths' || next[0] === 'weight') {
							setMode(next[0])
						}
					}}
					aria-label={t`How to count the open bottle`}
				>
					<ToggleGroupItem value="tenths" data-testid="bottle-mode-tenths">
						<Trans>In tenths</Trans>
					</ToggleGroupItem>
					<ToggleGroupItem value="weight" data-testid="bottle-mode-weight">
						<Trans>By weight</Trans>
					</ToggleGroupItem>
				</ToggleGroup>
			) : null}
			<div className="flex items-center gap-4">
				<div className="flex flex-col gap-1">
					<span className="text-muted-foreground text-xs">
						<Trans>Full bottles</Trans>
					</span>
					<QuantityStepper
						value={touched ? whole : null}
						onValueChange={(next) => {
							const count = Math.max(0, Math.floor(next ?? 0))
							setWhole(count)
							emit({ whole: count, tenths, weightG: weightText })
						}}
						step={1}
						placeholder="0"
						decrementLabel={t`Fewer bottles`}
						incrementLabel={t`More bottles`}
						aria-label={t`Full bottles`}
						data-testid="bottle-whole"
					/>
				</div>
				{mode === 'tenths' ? (
					<div className="flex items-end gap-3">
						<svg
							viewBox="0 0 24 48"
							className="text-primary h-14 w-7 shrink-0"
							aria-hidden="true"
							data-testid="bottle-shape"
						>
							<path
								d="M9 2h6v8l3 4v30a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V14l3-4z"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.5"
							/>
							<rect
								x="7"
								y={46 - 30 * (fill ?? 0)}
								width="10"
								height={30 * (fill ?? 0)}
								fill="currentColor"
								opacity="0.4"
							/>
						</svg>
						<div className="flex flex-col gap-1">
							<label
								htmlFor={sliderId}
								className="text-muted-foreground text-xs"
							>
								<Trans>Open bottle</Trans>{' '}
								<bdi dir="ltr" className="tabular-nums">
									{tenthsText}
								</bdi>
							</label>
							<input
								id={sliderId}
								type="range"
								min={0}
								max={BOTTLE_TENTHS_MAX}
								step={1}
								value={tenths}
								onChange={(event) => {
									const next = Number(event.target.value)
									setTenths(next)
									emit({ whole, tenths: next, weightG: weightText })
								}}
								className="accent-primary h-11 w-40 md:h-6"
								aria-valuetext={`${tenths}/${BOTTLE_TENTHS_MAX}`}
								data-testid="bottle-tenths"
							/>
						</div>
					</div>
				) : (
					<div className="flex flex-col gap-1">
						<label htmlFor={weightId} className="text-muted-foreground text-xs">
							<Trans>Open bottle weight (g)</Trans>
						</label>
						<Input
							id={weightId}
							type="text"
							inputMode="decimal"
							dir="ltr"
							className="w-28"
							value={weightText}
							onChange={(event) => {
								setWeightText(event.target.value)
								emit({ whole, tenths, weightG: event.target.value })
							}}
							data-testid="bottle-weight"
						/>
					</div>
				)}
			</div>
			<span
				className="text-muted-foreground text-xs tabular-nums"
				data-testid="bottle-total"
			>
				{valueMl === null ? (
					<Trans>Nothing counted yet</Trans>
				) : (
					<Trans>
						<bdi dir="ltr">{bottlesText}</bdi> bottles ={' '}
						<bdi dir="ltr">{mlText} ml</bdi>
					</Trans>
				)}
			</span>
		</div>
	)
}
