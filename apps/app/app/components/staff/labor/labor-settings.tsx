import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type SalesSource } from '@repo/staffing'
import { Button } from '@repo/ui/button'
import {
	Field,
	FieldContent,
	FieldDescription,
	FieldError,
	FieldLabel,
	FieldLegend,
	FieldSet,
	FieldTitle,
} from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import { Item, ItemActions, ItemContent, ItemGroup } from '@repo/ui/item'
import { Label } from '@repo/ui/label'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { useState } from 'react'
import { toast } from 'sonner'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { saveSettings } from '#app/utils/staffing/labor-api.ts'
import { describeLaborError } from '#app/utils/staffing/labor-errors.ts'
import {
	type LaborPosition,
	type LaborSettings,
} from '#app/utils/staffing/labor-types.ts'
import {
	isSalesSource,
	positionLabel,
	readOrdersPerHour,
	SOURCE_CHOICES,
} from '#app/utils/staffing/labor-view.ts'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'

/**
 * Where a scope's sales come from, and how many orders one person in each
 * position handles in an hour. The source decides what the labor share is built
 * on (and whether it may be judged against a target); the standards feed the
 * "coverage against expected orders" strip in the schedule.
 */
export function LaborSettingsForm({
	client,
	settings,
	positions,
	canEdit,
	onSaved,
}: {
	client: StaffClient
	settings: LaborSettings
	positions: readonly LaborPosition[]
	canEdit: boolean
	onSaved: () => void
}) {
	const { _, i18n } = useLingui()
	const locale = i18n.locale
	const [source, setSource] = useState<SalesSource>(settings.salesSource)
	const [standards, setStandards] = useState<Record<string, string>>(
		Object.fromEntries(
			positions.map((position) => [
				position.id,
				settings.ordersPerLaborHour[position.id] !== undefined
					? String(settings.ordersPerLaborHour[position.id])
					: '',
			]),
		),
	)
	const [problem, setProblem] = useState<string | null>(null)
	const save = useStaffAction(describeLaborError)

	async function submit() {
		if (save.pending || !canEdit) return
		const next: Record<string, number> = {}
		for (const position of positions) {
			const text = standards[position.id] ?? ''
			if (text.trim() === '') continue
			const value = readOrdersPerHour(text)
			if (value === null) {
				setProblem(
					_(
						t`Enter orders per hour from 0.5 to 200, with at most one decimal.`,
					),
				)
				return
			}
			next[position.id] = value
		}
		setProblem(null)
		const result = await save.run(() =>
			saveSettings(client, {
				scopeId: settings.scopeId,
				salesSource: source,
				ordersPerLaborHour: next,
			}),
		)
		if (result.ok) {
			toast.success(_(t`Labor settings saved.`))
			onSaved()
		}
	}

	return (
		<form
			className="flex max-w-2xl flex-col gap-8"
			noValidate
			onSubmit={(event) => {
				event.preventDefault()
				void submit()
			}}
		>
			<FieldSet disabled={!canEdit}>
				<FieldLegend>
					<Trans>Where sales come from</Trans>
				</FieldLegend>
				<RadioGroup
					value={source}
					onValueChange={(value) => isSalesSource(value) && setSource(value)}
					aria-label={_(t`Where sales come from`)}
				>
					{SOURCE_CHOICES.map((choice) => (
						<FieldLabel key={choice.value} className="min-h-11">
							<Field orientation="horizontal">
								<RadioGroupItem value={choice.value} />
								<FieldContent>
									<FieldTitle>{_(choice.title)}</FieldTitle>
									<FieldDescription>{_(choice.description)}</FieldDescription>
								</FieldContent>
							</Field>
						</FieldLabel>
					))}
				</RadioGroup>
			</FieldSet>

			<FieldSet disabled={!canEdit}>
				<FieldLegend>
					<Trans>Orders one person handles in an hour</Trans>
				</FieldLegend>
				<FieldDescription>
					<Trans>
						The schedule compares the orders you usually get each hour with the
						people you have scheduled. Set how many orders one person in a
						position handles in an hour; leave a position empty to leave it out.
					</Trans>
				</FieldDescription>
				{positions.length === 0 ? (
					<FieldDescription>
						<Trans>Add positions on the Team page first.</Trans>
					</FieldDescription>
				) : (
					<ItemGroup className="gap-2">
						{positions.map((position) => (
							<Item key={position.id} variant="outline">
								<ItemContent>
									<Label
										htmlFor={`standard-${position.id}`}
										className="min-w-0 truncate"
									>
										{positionLabel(position, locale)}
									</Label>
								</ItemContent>
								<ItemActions>
									<Input
										id={`standard-${position.id}`}
										inputMode="decimal"
										dir="ltr"
										value={standards[position.id] ?? ''}
										placeholder="–"
										className="h-11 w-24 text-end tabular-nums"
										onChange={(event) => {
											const value = event.target.value
											setStandards((current) => ({
												...current,
												[position.id]: value,
											}))
											setProblem(null)
										}}
									/>
									<span className="text-muted-foreground text-xs">
										<Trans>orders/h</Trans>
									</span>
								</ItemActions>
							</Item>
						))}
					</ItemGroup>
				)}
			</FieldSet>

			{problem || save.error ? (
				<FieldError>{problem ?? save.error}</FieldError>
			) : null}
			{canEdit ? (
				<div>
					<Button type="submit" disabled={save.pending}>
						{save.pending ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
					</Button>
				</div>
			) : (
				<p className="text-muted-foreground text-sm">
					<Trans>You can look at these settings but not change them.</Trans>
				</p>
			)}
		</form>
	)
}
