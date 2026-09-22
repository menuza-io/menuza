import { Trans } from '@lingui/macro'
import {
	ALLERGENS,
	ALLERGEN_LABELS,
	type Allergen,
} from '@repo/common/menu-types'
import { cn } from '@repo/ui'
import { Icon } from '@repo/ui/icon'
import { Label } from '@repo/ui/label'

interface MenuAllergenSelectorProps {
	selectedAllergens: Set<string> | string[]
	onToggle: (allergen: Allergen) => void
	className?: string
	variant?: 'default' | 'ledger'
}

export function MenuAllergenSelector({
	selectedAllergens,
	onToggle,
	className,
	variant = 'default',
}: MenuAllergenSelectorProps) {
	const isSelected = (allergen: Allergen): boolean => {
		if (selectedAllergens instanceof Set) {
			return selectedAllergens.has(allergen)
		}
		return selectedAllergens.includes(allergen)
	}

	if (variant === 'ledger') {
		return (
			<div className={cn('flex flex-col gap-3', className)}>
				<div className="flex items-center justify-between gap-2">
					<Label className="text-sm">
						<Trans>Common Allergens</Trans>
					</Label>
				</div>
				<p className="text-muted-foreground text-xs leading-4">
					<Trans>
						Disclose any allergens present to inform guest dietary and safety
						filters.
					</Trans>
				</p>
				<div className="grid grid-cols-2 gap-1.5">
					{ALLERGENS.map((allergen: Allergen) => {
						const active = isSelected(allergen)
						return (
							<button
								key={allergen}
								type="button"
								aria-pressed={active}
								onClick={() => onToggle(allergen)}
								className={cn(
									'flex items-center gap-2 rounded-lg border p-2 text-left text-xs transition-colors select-none',
									active
										? 'border-primary bg-primary/5 text-primary'
										: 'border-border bg-muted/30 text-foreground hover:bg-muted/50',
								)}
							>
								<div
									className={cn(
										'flex size-3.5 shrink-0 items-center justify-center rounded-sm border transition-colors',
										active
											? 'border-primary bg-primary text-primary-foreground'
											: 'border-muted-foreground/40 bg-background',
									)}
								>
									{active && <Icon name="check" className="size-2.5" />}
								</div>
								<span className="truncate">{ALLERGEN_LABELS[allergen]}</span>
							</button>
						)
					})}
				</div>
			</div>
		)
	}

	return (
		<div className={cn('space-y-2.5', className)}>
			<div>
				<Label className="text-xs">
					<Trans>Common Allergens</Trans>
				</Label>
			</div>

			<div className="bg-border grid grid-cols-1 gap-px overflow-hidden rounded-md border sm:grid-cols-2">
				{ALLERGENS.map((allergen: Allergen) => {
					const active = isSelected(allergen)
					return (
						<button
							key={allergen}
							type="button"
							aria-pressed={active}
							onClick={() => onToggle(allergen)}
							className={cn(
								'bg-background hover:bg-muted/40 flex items-center gap-3 p-3.5 text-left text-sm transition-colors select-none',
								active ? 'text-foreground' : 'text-foreground',
							)}
						>
							<div
								className={cn(
									'flex size-4 shrink-0 items-center justify-center rounded-sm border transition-colors',
									active
										? 'border-primary bg-primary text-primary-foreground'
										: 'border-muted-foreground/40',
								)}
							>
								{active && <Icon name="check" className="size-3" />}
							</div>
							<span className="truncate">{ALLERGEN_LABELS[allergen]}</span>
						</button>
					)
				})}
			</div>
		</div>
	)
}
