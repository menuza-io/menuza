import { Trans } from '@lingui/macro'
import {
	ChoiceCard,
	ChoiceCardContent,
	ChoiceCardDescription,
	ChoiceCardTitle,
} from '@repo/ui/choice-card'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { Switch } from '@repo/ui/switch'

export type ModifierSelectionType = 'single' | 'multiple' | 'quantity' | 'pizza'

/**
 * How guests choose within a modifier group. Shared by the full group form
 * and the quick create sheet on the dish and option forms.
 */
export function ModifierSelectionModeField({
	idPrefix = 'st',
	value,
	onChange,
}: {
	/** Keeps radio ids unique when two copies are on one page. */
	idPrefix?: string
	value: ModifierSelectionType
	onChange: (value: ModifierSelectionType) => void
}) {
	return (
		<div className="space-y-3">
			<Label>
				<Trans>Selection Mode</Trans>
			</Label>
			<RadioGroup
				value={value}
				onValueChange={(next) => onChange(next as ModifierSelectionType)}
				className="grid grid-cols-1 gap-3 sm:grid-cols-2"
			>
				<ChoiceCard htmlFor={`${idPrefix}_single`}>
					<RadioGroupItem value="single" id={`${idPrefix}_single`} />
					<ChoiceCardContent>
						<ChoiceCardTitle>
							<Trans>Single Choice (Radio)</Trans>
						</ChoiceCardTitle>
						<ChoiceCardDescription>
							<Trans>Guests can pick up to 1 option.</Trans>
						</ChoiceCardDescription>
					</ChoiceCardContent>
				</ChoiceCard>

				<ChoiceCard htmlFor={`${idPrefix}_multiple`}>
					<RadioGroupItem value="multiple" id={`${idPrefix}_multiple`} />
					<ChoiceCardContent>
						<ChoiceCardTitle>
							<Trans>Multiple Choice (Checkboxes)</Trans>
						</ChoiceCardTitle>
						<ChoiceCardDescription>
							<Trans>Guests can pick multiple options.</Trans>
						</ChoiceCardDescription>
					</ChoiceCardContent>
				</ChoiceCard>

				<ChoiceCard htmlFor={`${idPrefix}_quantity`}>
					<RadioGroupItem value="quantity" id={`${idPrefix}_quantity`} />
					<ChoiceCardContent>
						<ChoiceCardTitle>
							<Trans>Quantity Counter (+/-)</Trans>
						</ChoiceCardTitle>
						<ChoiceCardDescription>
							<Trans>Guests choose counts per option.</Trans>
						</ChoiceCardDescription>
					</ChoiceCardContent>
				</ChoiceCard>

				<ChoiceCard htmlFor={`${idPrefix}_pizza`}>
					<RadioGroupItem value="pizza" id={`${idPrefix}_pizza`} />
					<ChoiceCardContent>
						<ChoiceCardTitle>
							<Trans>Pizza Toppings (Whole / Halves)</Trans>
						</ChoiceCardTitle>
						<ChoiceCardDescription>
							<Trans>Whole pizza, left half, or right half pricing.</Trans>
						</ChoiceCardDescription>
					</ChoiceCardContent>
				</ChoiceCard>
			</RadioGroup>
		</div>
	)
}

/** The "must choose one" switch of a single-choice group (label, then switch). */
export function ModifierRequiredSelectionField({
	id = 'single-choice-required',
	required,
	onChange,
}: {
	id?: string
	required: boolean
	onChange: (required: boolean) => void
}) {
	return (
		<>
			<Label
				htmlFor={id}
				className="block min-w-0 cursor-pointer space-y-0.5 font-normal"
			>
				<div className="text-foreground text-sm">
					<Trans>Required selection</Trans>
				</div>
				<p className="text-muted-foreground text-xs">
					{required ? (
						<Trans>Guests must choose one option before continuing.</Trans>
					) : (
						<Trans>Guests can skip this selection.</Trans>
					)}
				</p>
			</Label>
			<Switch id={id} checked={required} onCheckedChange={onChange} />
		</>
	)
}

/** Minimum and maximum picks for every selection mode but single choice. */
export function ModifierSelectionLimitsFields({
	idPrefix = 'limits',
	minSelections,
	maxSelections,
	onMinChange,
	onMaxChange,
}: {
	idPrefix?: string
	minSelections: number
	/** Blank means unlimited. */
	maxSelections: string
	onMinChange: (value: number) => void
	onMaxChange: (value: string) => void
}) {
	return (
		<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
			<div className="space-y-1.5">
				<Label htmlFor={`${idPrefix}_min`}>
					<Trans>Minimum Selections</Trans>
				</Label>
				<Input
					id={`${idPrefix}_min`}
					type="number"
					min="0"
					value={minSelections}
					onChange={(e) => onMinChange(parseInt(e.target.value, 10) || 0)}
				/>
				<span className="text-muted-foreground text-xs">
					<Trans>0 = optional choice, 1+ = required</Trans>
				</span>
			</div>

			<div className="space-y-1.5">
				<Label htmlFor={`${idPrefix}_max`}>
					<Trans>Maximum Selections (Optional)</Trans>
				</Label>
				<Input
					id={`${idPrefix}_max`}
					type="number"
					min="1"
					placeholder="Leave blank for unlimited"
					value={maxSelections}
					onChange={(e) => onMaxChange(e.target.value)}
				/>
			</div>
		</div>
	)
}
