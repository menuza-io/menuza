import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	type RestaurantSettings,
	restaurantSettingsOf,
} from '@repo/phone-agent-restaurant'
import { AnnotatedSection } from '@repo/ui/annotated-layout'
import { Card, CardContent } from '@repo/ui/card'
import { Checkbox } from '@repo/ui/checkbox'
import { Label } from '@repo/ui/label'
import { Switch } from '@repo/ui/switch'
import { z } from 'zod'
import { type VerticalSettingsSectionProps } from '../vertical-ui-types.ts'

const DataSchema = z
	.object({
		categories: z.array(z.object({ id: z.string(), name: z.string() })),
	})
	.catch({ categories: [] })

/** Add-on suggestions and the rules for orders taken by phone. */
export function PhoneOrderingSection({
	value,
	onChange,
	disabled,
	data,
}: VerticalSettingsSectionProps) {
	const { _ } = useLingui()
	const settings = restaurantSettingsOf({ vertical: value })
	const { categories } = DataSchema.parse(data)
	const { ordering } = settings

	function update(next: Partial<RestaurantSettings>) {
		onChange({ ...value, ...settings, ...next })
	}

	function setOrdering(next: Partial<RestaurantSettings['ordering']>) {
		update({ ordering: { ...ordering, ...next } })
	}

	function toggleCategory(id: string, excluded: boolean) {
		setOrdering({
			excludedCategoryIds: excluded
				? [...new Set([...ordering.excludedCategoryIds, id])]
				: ordering.excludedCategoryIds.filter((item) => item !== id),
		})
	}

	return (
		<AnnotatedSection
			title={<Trans>Phone ordering</Trans>}
			description={
				<Trans>
					What the agent does when it takes an order before texting the ordering
					link.
				</Trans>
			}
		>
			<Card>
				<CardContent className="flex flex-col gap-5">
					<div className="flex items-center justify-between gap-4">
						<div className="flex flex-col gap-1">
							<Label htmlFor="ordering-upsells">
								<Trans>Suggest add-ons</Trans>
							</Label>
							<p className="text-muted-foreground text-xs">
								<Trans>
									The agent follows your Upsells and add-ons training rules.
								</Trans>
							</p>
						</div>
						<Switch
							id="ordering-upsells"
							checked={settings.upsellsEnabled}
							disabled={disabled}
							onCheckedChange={(checked) => update({ upsellsEnabled: checked })}
						/>
					</div>
					{(
						[
							[
								'readBackSummary',
								msg`Read the order back`,
								msg`Repeat each item before sending the link.`,
							],
							[
								'readBackTotal',
								msg`Say the total`,
								msg`Tell the caller the estimated total before tax and fees.`,
							],
							[
								'quoteReadyTime',
								msg`Say when it will be ready`,
								msg`Give the usual pickup or delivery time.`,
							],
						] as const
					).map(([key, label, hint]) => (
						<div key={key} className="flex items-center justify-between gap-4">
							<div className="flex flex-col gap-1">
								<Label htmlFor={`ordering-${key}`}>{_(label)}</Label>
								<p className="text-muted-foreground text-xs">{_(hint)}</p>
							</div>
							<Switch
								id={`ordering-${key}`}
								checked={ordering[key]}
								disabled={disabled}
								onCheckedChange={(checked) => setOrdering({ [key]: checked })}
							/>
						</div>
					))}
					<fieldset className="flex flex-col gap-2">
						<legend className="mb-1 text-sm font-medium">
							<Trans>Don't take phone orders for</Trans>
						</legend>
						<p className="text-muted-foreground text-xs">
							<Trans>
								The agent can still describe these items, but callers are asked
								to order them online or speak with staff.
							</Trans>
						</p>
						{categories.length ? (
							<div className="grid gap-2 sm:grid-cols-2">
								{categories.map((category) => (
									<label
										key={category.id}
										className="flex items-center gap-2 text-sm"
									>
										<Checkbox
											checked={ordering.excludedCategoryIds.includes(
												category.id,
											)}
											disabled={disabled}
											onCheckedChange={(checked) =>
												toggleCategory(category.id, checked === true)
											}
										/>
										{category.name}
									</label>
								))}
							</div>
						) : (
							<p className="text-muted-foreground text-xs">
								<Trans>Publish a menu to choose categories.</Trans>
							</p>
						)}
					</fieldset>
				</CardContent>
			</Card>
		</AnnotatedSection>
	)
}
