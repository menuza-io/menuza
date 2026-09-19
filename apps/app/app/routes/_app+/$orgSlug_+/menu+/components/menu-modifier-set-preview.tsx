import { Badge } from '@repo/ui/badge'

type ModifierOption = {
	id: string
	name: string
	priceCents: number
	active: boolean
}

export function MenuModifierSetPreview({
	name,
	displayType,
	minSelections,
	maxSelections,
	options,
	preselectedOptionIds,
}: {
	name: string
	displayType: string
	minSelections: number
	maxSelections: number
	options: ModifierOption[]
	preselectedOptionIds: string[]
}) {
	const required = minSelections > 0

	return (
		<div className="overflow-hidden rounded-lg border">
			<div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
				<p className="min-w-0 flex-1 text-sm font-medium">
					{name || 'Untitled modifier set'}
				</p>
				<Badge variant={required ? 'default' : 'outline'}>
					{required ? 'Required' : 'Optional'}
				</Badge>
				<span className="text-muted-foreground text-xs">
					{minSelections}–{maxSelections > 0 ? maxSelections : '∞'}
				</span>
			</div>
			<ul className="divide-y">
				{options.length === 0 ? (
					<li className="text-muted-foreground px-3 py-6 text-center text-sm">
						No options yet.
					</li>
				) : (
					options.map((option) => (
						<li
							key={option.id}
							className="flex items-center gap-3 px-3 py-2 text-sm"
						>
							<span
								className={
									displayType === 'single-select'
										? 'flex size-4 rounded-full border'
										: 'flex size-4 rounded-sm border'
								}
							>
								{preselectedOptionIds.includes(option.id) ? (
									<span className="bg-primary m-auto size-2 rounded-full" />
								) : null}
							</span>
							<span className="flex-1">{option.name}</span>
							{option.priceCents > 0 ? (
								<span className="text-muted-foreground text-xs">
									+${(option.priceCents / 100).toFixed(2)}
								</span>
							) : null}
						</li>
					))
				)}
			</ul>
		</div>
	)
}
