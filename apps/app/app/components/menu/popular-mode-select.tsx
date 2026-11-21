import { Trans } from '@lingui/macro'
import { type PopularMode } from '@repo/common/menu-popular'
import {
	ChoiceCard,
	ChoiceCardContent,
	ChoiceCardDescription,
	ChoiceCardTitle,
} from '@repo/ui/choice-card'
import { Label } from '@repo/ui/label'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'

/**
 * 3-state selector for an item's `popularMode` (`auto` | `always` | `never`).
 * Renders a hidden input with `name` so standard form submissions receive the
 * selected mode.
 */
export function PopularModeSelect({
	idPrefix = 'popular-mode',
	name = 'popularMode',
	value,
	onChange,
}: {
	idPrefix?: string
	name?: string
	value: PopularMode
	onChange: (value: PopularMode) => void
}) {
	return (
		<div className="space-y-3">
			<input type="hidden" name={name} value={value} />
			<Label>
				<Trans>Popular Badge</Trans>
			</Label>
			<RadioGroup
				value={value}
				onValueChange={(next) => onChange(next as PopularMode)}
				className="grid grid-cols-1 gap-3 sm:grid-cols-3"
			>
				<ChoiceCard htmlFor={`${idPrefix}_auto`}>
					<RadioGroupItem value="auto" id={`${idPrefix}_auto`} />
					<ChoiceCardContent>
						<ChoiceCardTitle>
							<Trans>Automatic</Trans>
						</ChoiceCardTitle>
						<ChoiceCardDescription>
							<Trans>Follow daily top-seller ranking.</Trans>
						</ChoiceCardDescription>
					</ChoiceCardContent>
				</ChoiceCard>

				<ChoiceCard htmlFor={`${idPrefix}_always`}>
					<RadioGroupItem value="always" id={`${idPrefix}_always`} />
					<ChoiceCardContent>
						<ChoiceCardTitle>
							<Trans>Always</Trans>
						</ChoiceCardTitle>
						<ChoiceCardDescription>
							<Trans>Always show the Popular badge.</Trans>
						</ChoiceCardDescription>
					</ChoiceCardContent>
				</ChoiceCard>

				<ChoiceCard htmlFor={`${idPrefix}_never`}>
					<RadioGroupItem value="never" id={`${idPrefix}_never`} />
					<ChoiceCardContent>
						<ChoiceCardTitle>
							<Trans>Never</Trans>
						</ChoiceCardTitle>
						<ChoiceCardDescription>
							<Trans>Never mark this dish as Popular.</Trans>
						</ChoiceCardDescription>
					</ChoiceCardContent>
				</ChoiceCard>
			</RadioGroup>
		</div>
	)
}
