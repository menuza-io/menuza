import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	CUISINES,
	cuisineLabel,
	formatPriceRange,
	MAX_CUISINES,
} from '@repo/common/cuisines'
import { Checkbox } from '@repo/ui/checkbox'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { useId } from 'react'

/**
 * Cuisines (pick up to three from the fixed list, labels in the reader's
 * language) and price range (`$` to `$$$$` in the local currency). Posts
 * `cuisines` (repeated) and `priceRange` (empty when not set). Used by
 * Settings, Organization and, as an override, by each location (#182).
 */
export function CuisinePriceFields({
	cuisines,
	onCuisinesChange,
	priceRange,
	onPriceRangeChange,
	currency,
	locale,
	inheritLabel,
}: {
	cuisines: string[]
	onCuisinesChange: (next: string[]) => void
	priceRange: string
	onPriceRangeChange: (next: string) => void
	currency: string
	locale: string
	/** For a location: what "not set" falls back to. */
	inheritLabel?: string
}) {
	const { _ } = useLingui()
	const id = useId()
	const full = cuisines.length >= MAX_CUISINES
	const notSet = inheritLabel ?? _(msg`Not set`)
	const priceItems = [
		{ value: '', label: notSet },
		...[1, 2, 3, 4].map((level) => ({
			value: String(level),
			label: formatPriceRange(level, currency),
		})),
	]
	return (
		<div className="space-y-5">
			{cuisines.map((key) => (
				<input key={key} type="hidden" name="cuisines" value={key} />
			))}
			<input type="hidden" name="priceRange" value={priceRange} />
			<fieldset className="space-y-2">
				<legend className="text-sm font-medium">
					<Trans>Cuisines</Trans>
				</legend>
				<p className="text-muted-foreground text-xs">
					<Trans>
						Pick up to three. Search engines and AI assistants use them to know
						what you serve.
					</Trans>
				</p>
				<div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
					{CUISINES.map((cuisine) => {
						const checked = cuisines.includes(cuisine.key)
						const inputId = `${id}-${cuisine.key}`
						return (
							<div key={cuisine.key} className="flex items-center gap-2">
								<Checkbox
									id={inputId}
									checked={checked}
									disabled={!checked && full}
									data-testid={`cuisine-${cuisine.key}`}
									onCheckedChange={(value) => {
										onCuisinesChange(
											value
												? [...cuisines, cuisine.key].slice(0, MAX_CUISINES)
												: cuisines.filter((key) => key !== cuisine.key),
										)
									}}
								/>
								<Label htmlFor={inputId} className="text-sm font-normal">
									{cuisineLabel(cuisine.key, locale)}
								</Label>
							</div>
						)
					})}
				</div>
			</fieldset>
			<div className="space-y-1.5">
				<Label htmlFor={`${id}-price`}>
					<Trans>Price range</Trans>
				</Label>
				<Select
					value={priceRange}
					onValueChange={(value) => onPriceRangeChange(value ?? '')}
					items={priceItems}
				>
					<SelectTrigger id={`${id}-price`} className="w-48">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{priceItems.map((item) => (
							<SelectItem key={item.value || 'none'} value={item.value}>
								{item.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<p className="text-muted-foreground text-xs">
					<Trans>Leave it empty to leave the price range out.</Trans>
				</p>
			</div>
		</div>
	)
}
