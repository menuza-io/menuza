import { type MessageDescriptor } from '@lingui/core'
import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { DIETARY_TAGS, type DietaryTag } from '@repo/common/menu-types'
import { Label } from '@repo/ui/label'
import { Switch } from '@repo/ui/switch'

export const DIETARY_TAG_MESSAGES: Record<DietaryTag, MessageDescriptor> = {
	halal: msg`Halal`,
	vegan: msg`Vegan`,
	vegetarian: msg`Vegetarian`,
	gluten_free: msg`Gluten-Free`,
	dairy_free: msg`Dairy-Free`,
	nut_free: msg`Nut-Free`,
	spicy: msg`Spicy`,
}

/**
 * Dietary tags (#335) plus the separate alcohol flag, one switch each. The
 * caller posts `dietaryTags` (JSON) and `isAlcohol`.
 */
export function DietaryTagSwitches({
	idPrefix,
	tags,
	onTagsChange,
	isAlcohol,
	onAlcoholChange,
}: {
	idPrefix: string
	tags: readonly DietaryTag[]
	onTagsChange: (tags: DietaryTag[]) => void
	isAlcohol: boolean
	onAlcoholChange: (value: boolean) => void
}) {
	const { _ } = useLingui()
	const toggle = (tag: DietaryTag, on: boolean) => {
		const next = new Set(tags)
		if (on) next.add(tag)
		else next.delete(tag)
		onTagsChange(DIETARY_TAGS.filter((value) => next.has(value)))
	}
	return (
		<div className="flex flex-col gap-2">
			<div className="divide-border/60 bg-background divide-y overflow-hidden rounded-md border">
				{DIETARY_TAGS.map((tag) => (
					<div
						key={tag}
						className="flex items-center justify-between gap-3 px-3 py-2.5"
					>
						<Label
							htmlFor={`${idPrefix}-${tag}`}
							className="min-w-0 flex-1 cursor-pointer font-normal"
						>
							<span className="text-foreground text-sm font-medium">
								{_(DIETARY_TAG_MESSAGES[tag])}
							</span>
						</Label>
						<Switch
							id={`${idPrefix}-${tag}`}
							checked={tags.includes(tag)}
							onCheckedChange={(on) => toggle(tag, on)}
							className="shrink-0"
						/>
					</div>
				))}
				<div className="flex items-center justify-between gap-3 px-3 py-2.5">
					<Label
						htmlFor={`${idPrefix}-alcohol`}
						className="min-w-0 flex-1 cursor-pointer font-normal"
					>
						<span className="text-foreground text-sm font-medium">
							<Trans>Alcoholic</Trans>
						</span>
					</Label>
					<Switch
						id={`${idPrefix}-alcohol`}
						checked={isAlcohol}
						onCheckedChange={onAlcoholChange}
						className="shrink-0"
					/>
				</div>
			</div>
			<p className="text-muted-foreground text-xs">
				<Trans>
					Tags are your own claims. Guests can filter the menu by them;
					allergens stay listed separately.
				</Trans>
			</p>
		</div>
	)
}
