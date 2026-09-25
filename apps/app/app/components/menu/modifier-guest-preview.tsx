import { Trans } from '@lingui/macro'
import { getLocalizedMenuValue } from '@repo/common/menu-types'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Frame,
	FrameAction,
	FrameFooter,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { useEffect, useState } from 'react'

export interface PreviewOption {
	id: string
	displayName: string
	internalName?: string | null
	price: number
	priceWhole?: number | null
	priceLeft?: number | null
	priceRight?: number | null
	minSelections?: number
	maxSelections?: number | null
	isAlcohol?: boolean
	isGlutenFree?: boolean
	isVegetarian?: boolean
	isTopping?: boolean
	isDefault?: boolean
	allergens?: string[]
}

interface ModifierGuestPreviewProps {
	groupName: string
	selectionType: 'single' | 'multiple' | 'quantity' | 'pizza'
	minSelections: number
	maxSelections?: number | null
	options: PreviewOption[]
	locale?: string
	defaultLocale?: string
	className?: string
}

export function ModifierGuestPreview({
	groupName,
	selectionType,
	minSelections,
	maxSelections,
	options,
	locale = 'en',
	defaultLocale = 'en',
	className,
}: ModifierGuestPreviewProps) {
	// State for guest interactions
	const [selectedSingle, setSelectedSingle] = useState<string | null>(null)
	const [selectedMultiple, setSelectedMultiple] = useState<Set<string>>(
		new Set(),
	)
	const [quantities, setQuantities] = useState<Record<string, number>>({})
	// Pizza mode: map option id to 'whole' | 'left' | 'right' | null
	const [pizzaSelections, setPizzaSelections] = useState<
		Record<string, 'whole' | 'left' | 'right'>
	>({})
	const defaultOptionIds = JSON.stringify(
		options.filter((option) => option.isDefault).map((option) => option.id),
	)

	useEffect(() => {
		const defaults = JSON.parse(defaultOptionIds) as string[]
		setSelectedSingle(defaults[0] ?? null)
		setSelectedMultiple(new Set(defaults))
		setQuantities(Object.fromEntries(defaults.map((id) => [id, 1])))
		setPizzaSelections(
			Object.fromEntries(defaults.map((id) => [id, 'whole' as const])),
		)
	}, [defaultOptionIds, selectionType])

	const handleReset = () => {
		setSelectedSingle(null)
		setSelectedMultiple(new Set())
		setQuantities({})
		setPizzaSelections({})
	}

	// Calculate total price and selection count
	let totalCost = 0
	let totalCount = 0

	if (selectionType === 'single') {
		if (selectedSingle) {
			const opt = options.find((o) => o.id === selectedSingle)
			if (opt) {
				totalCost += opt.price
				totalCount = 1
			}
		}
	} else if (selectionType === 'multiple') {
		selectedMultiple.forEach((id) => {
			const opt = options.find((o) => o.id === id)
			if (opt) {
				totalCost += opt.price
				totalCount++
			}
		})
	} else if (selectionType === 'quantity') {
		options.forEach((opt) => {
			const qty = quantities[opt.id] || 0
			totalCost += opt.price * qty
			totalCount += qty
		})
	} else if (selectionType === 'pizza') {
		Object.entries(pizzaSelections).forEach(([id, side]) => {
			const opt = options.find((o) => o.id === id)
			if (opt) {
				totalCount++
				if (side === 'whole') {
					totalCost += opt.priceWhole ?? opt.price
				} else if (side === 'left') {
					totalCost += opt.priceLeft ?? opt.price / 2
				} else if (side === 'right') {
					totalCost += opt.priceRight ?? opt.price / 2
				}
			}
		})
	}

	const isSatisfied =
		totalCount >= minSelections &&
		(!maxSelections || totalCount <= maxSelections)

	const maxSelectionsSuffix = maxSelections ? `-${maxSelections}` : '+'

	return (
		<Frame
			className={cn('border-primary/25 bg-primary/5 shadow-xs', className)}
		>
			<FrameHeader className="gap-1.5 pb-3">
				<div className="flex items-center gap-2">
					<span className="relative flex size-2">
						<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
						<span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
					</span>
					<span className="text-muted-foreground text-xs tracking-wider uppercase">
						<Trans>Guest Live Preview</Trans>
					</span>
				</div>
				<div className="mt-1 flex items-baseline justify-between gap-2">
					<FrameTitle className="text-base leading-tight">
						{getLocalizedMenuValue(groupName, locale, defaultLocale) || (
							<span className="text-muted-foreground font-normal italic">
								<Trans>Modifier Group Name</Trans>
							</span>
						)}
					</FrameTitle>
					<Badge
						variant={minSelections > 0 ? 'default' : 'secondary'}
						className="shrink-0 text-[11px]"
					>
						{minSelections > 0 ? (
							maxSelections === minSelections ? (
								<Trans>Required • Pick {minSelections}</Trans>
							) : (
								<Trans>
									Required • Pick {minSelections}
									{maxSelectionsSuffix}
								</Trans>
							)
						) : maxSelections ? (
							<Trans>Optional • Up to {maxSelections}</Trans>
						) : (
							<Trans>Optional</Trans>
						)}
					</Badge>
				</div>
				{(totalCount > 0 || selectedSingle) && (
					<FrameAction>
						<Button
							type="button"
							variant="ghost"
							size="xs"
							onClick={handleReset}
							className="text-muted-foreground hover:text-foreground h-6 text-xs"
						>
							<Trans>Reset</Trans>
						</Button>
					</FrameAction>
				)}
			</FrameHeader>

			<FramePanel className="divide-muted divide-y p-0">
				{options.length === 0 ? (
					<div className="text-muted-foreground p-6 text-center text-xs">
						<Trans>Add modifier options below to see guest preview.</Trans>
					</div>
				) : (
					options.map((option) => {
						const optName =
							getLocalizedMenuValue(
								option.displayName,
								locale,
								defaultLocale,
							) ||
							option.internalName ||
							`Option ${option.id}`

						if (selectionType === 'single') {
							const isChecked = selectedSingle === option.id
							return (
								<label
									key={option.id}
									onClick={() =>
										setSelectedSingle(isChecked ? null : option.id)
									}
									className={cn(
										'hover:bg-muted/40 flex cursor-pointer items-center justify-between p-3.5 text-sm transition-colors',
										isChecked && 'bg-primary/5',
									)}
								>
									<div className="flex items-center gap-3">
										<div
											className={cn(
												'border-primary/40 flex size-4.5 items-center justify-center rounded-full border transition-all',
												isChecked &&
													'border-primary bg-primary text-primary-foreground',
											)}
										>
											{isChecked && (
												<div className="size-2 rounded-full bg-white" />
											)}
										</div>
										<div>
											<span className="text-foreground font-medium">
												{optName}
											</span>
											<DietaryBadges option={option} />
										</div>
									</div>
									<div className="text-muted-foreground text-xs font-medium">
										{option.price > 0 ? (
											`+$${option.price.toFixed(2)}`
										) : (
											<Trans>Free</Trans>
										)}
									</div>
								</label>
							)
						}

						if (selectionType === 'multiple') {
							const isChecked = selectedMultiple.has(option.id)
							const isDisabled =
								!isChecked &&
								Boolean(maxSelections && selectedMultiple.size >= maxSelections)

							return (
								<label
									key={option.id}
									onClick={() => {
										if (isDisabled) return
										const next = new Set(selectedMultiple)
										if (isChecked) {
											next.delete(option.id)
										} else {
											next.add(option.id)
										}
										setSelectedMultiple(next)
									}}
									className={cn(
										'hover:bg-muted/40 flex cursor-pointer items-center justify-between p-3.5 text-sm transition-colors',
										isChecked && 'bg-primary/5',
										isDisabled && 'cursor-not-allowed opacity-50',
									)}
								>
									<div className="flex items-center gap-3">
										<div
											className={cn(
												'border-primary/40 flex size-4.5 items-center justify-center rounded border transition-all',
												isChecked &&
													'border-primary bg-primary text-primary-foreground',
											)}
										>
											{isChecked && <Icon name="check" className="size-3" />}
										</div>
										<div>
											<span className="text-foreground font-medium">
												{optName}
											</span>
											<DietaryBadges option={option} />
										</div>
									</div>
									<div className="text-muted-foreground text-xs font-medium">
										{option.price > 0 ? (
											`+$${option.price.toFixed(2)}`
										) : (
											<Trans>Free</Trans>
										)}
									</div>
								</label>
							)
						}

						if (selectionType === 'quantity') {
							const currentQty = quantities[option.id] || 0
							const canIncrease =
								(!option.maxSelections || currentQty < option.maxSelections) &&
								(!maxSelections || totalCount < maxSelections)
							const canDecrease = currentQty > (option.minSelections || 0)

							return (
								<div
									key={option.id}
									className="flex items-center justify-between p-3.5 text-sm"
								>
									<div>
										<span className="text-foreground font-medium">
											{optName}
										</span>
										<DietaryBadges option={option} />
										<div className="text-muted-foreground text-xs">
											{option.price > 0 ? (
												`+$${option.price.toFixed(2)} each`
											) : (
												<Trans>Free</Trans>
											)}
										</div>
									</div>
									<div className="flex items-center gap-2">
										<Button
											type="button"
											variant="outline"
											size="icon-xs"
											disabled={!canDecrease}
											onClick={() =>
												setQuantities((prev) => ({
													...prev,
													[option.id]: Math.max(0, currentQty - 1),
												}))
											}
											className="size-7 rounded-md"
										>
											-
										</Button>
										<span className="w-5 text-center text-sm">
											{currentQty}
										</span>
										<Button
											type="button"
											variant="outline"
											size="icon-xs"
											disabled={!canIncrease}
											onClick={() =>
												setQuantities((prev) => ({
													...prev,
													[option.id]: currentQty + 1,
												}))
											}
											className="size-7 rounded-md"
										>
											+
										</Button>
									</div>
								</div>
							)
						}

						if (selectionType === 'pizza') {
							const currentSide = pizzaSelections[option.id]
							const wholePrice = option.priceWhole ?? option.price
							const leftPrice = option.priceLeft ?? option.price / 2
							const rightPrice = option.priceRight ?? option.price / 2

							return (
								<div
									key={option.id}
									className="flex flex-col gap-2 p-3.5 text-sm"
								>
									<div className="flex items-center justify-between">
										<div>
											<span className="text-foreground font-medium">
												{optName}
											</span>
											<DietaryBadges option={option} />
										</div>
										<span className="text-muted-foreground text-xs">
											{currentSide === 'whole' && `+$${wholePrice.toFixed(2)}`}
											{currentSide === 'left' && `+$${leftPrice.toFixed(2)}`}
											{currentSide === 'right' && `+$${rightPrice.toFixed(2)}`}
											{!currentSide && `+$${wholePrice.toFixed(2)} whole`}
										</span>
									</div>
									<div className="bg-muted/60 grid grid-cols-3 gap-1 rounded-lg p-1">
										<button
											type="button"
											onClick={() =>
												setPizzaSelections((prev) => ({
													...prev,
													[option.id]:
														prev[option.id] === 'left'
															? (undefined as any)
															: 'left',
												}))
											}
											className={cn(
												'rounded-md py-1 text-center text-xs font-medium transition-colors',
												currentSide === 'left'
													? 'bg-primary text-primary-foreground shadow-xs'
													: 'text-muted-foreground hover:text-foreground hover:bg-background/50',
											)}
										>
											<Trans>Left ½</Trans>
										</button>
										<button
											type="button"
											onClick={() =>
												setPizzaSelections((prev) => ({
													...prev,
													[option.id]:
														prev[option.id] === 'whole'
															? (undefined as any)
															: 'whole',
												}))
											}
											className={cn(
												'rounded-md py-1 text-center text-xs font-medium transition-colors',
												currentSide === 'whole'
													? 'bg-primary text-primary-foreground shadow-xs'
													: 'text-muted-foreground hover:text-foreground hover:bg-background/50',
											)}
										>
											<Trans>Whole</Trans>
										</button>
										<button
											type="button"
											onClick={() =>
												setPizzaSelections((prev) => ({
													...prev,
													[option.id]:
														prev[option.id] === 'right'
															? (undefined as any)
															: 'right',
												}))
											}
											className={cn(
												'rounded-md py-1 text-center text-xs font-medium transition-colors',
												currentSide === 'right'
													? 'bg-primary text-primary-foreground shadow-xs'
													: 'text-muted-foreground hover:text-foreground hover:bg-background/50',
											)}
										>
											<Trans>Right ½</Trans>
										</button>
									</div>
								</div>
							)
						}

						return null
					})
				)}
			</FramePanel>

			{options.length > 0 && (
				<FrameFooter className="bg-muted/20 flex flex-row items-center justify-between border-t px-4 py-3 text-xs">
					<div className="flex items-center gap-1.5">
						<Icon
							name={isSatisfied ? 'check-circle' : 'circle'}
							className={cn(
								'size-3.5',
								isSatisfied ? 'text-emerald-500' : 'text-amber-500',
							)}
						/>
						<span className="text-muted-foreground">
							{totalCount} selected
							{minSelections > 0 && !isSatisfied && ` (Need ${minSelections})`}
						</span>
					</div>
					<div className="text-foreground">
						{totalCost > 0 ? `+ $${totalCost.toFixed(2)}` : '$0.00'}
					</div>
				</FrameFooter>
			)}
		</Frame>
	)
}

function DietaryBadges({ option }: { option: PreviewOption }) {
	const hasDietary =
		option.isGlutenFree || option.isVegetarian || option.isAlcohol
	if (!hasDietary) return null

	return (
		<div className="mt-0.5 flex flex-wrap gap-1">
			{option.isGlutenFree && (
				<span className="rounded bg-amber-100 px-1 text-[10px] text-amber-800 dark:bg-amber-950 dark:text-amber-300">
					GF
				</span>
			)}
			{option.isVegetarian && (
				<span className="rounded bg-emerald-100 px-1 text-[10px] text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
					V
				</span>
			)}
			{option.isAlcohol && (
				<span className="bg-muted text-muted-foreground rounded px-1 text-[10px]">
					21+
				</span>
			)}
		</div>
	)
}
