import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type SalesSource } from '@repo/staffing'
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
import { type ReactNode, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useSaveBar } from '#app/components/save-bar.tsx'
import { useScopeLabel } from '#app/components/staff/scope-wording-provider.tsx'
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

/** Standards typed as text, by position id. */
type StandardsText = Record<string, string>

function standardsText(
	positions: readonly LaborPosition[],
	standards: Readonly<Record<string, number>> | undefined,
): StandardsText {
	return Object.fromEntries(
		positions.map((position) => [
			position.id,
			standards?.[position.id] !== undefined
				? String(standards[position.id])
				: '',
		]),
	)
}

/** The typed standards as numbers, or null when one is not a valid figure. */
function readStandards(
	positions: readonly LaborPosition[],
	text: StandardsText,
): Record<string, number> | null {
	const next: Record<string, number> = {}
	for (const position of positions) {
		const typed = text[position.id] ?? ''
		if (typed.trim() === '') continue
		const value = readOrdersPerHour(typed)
		if (value === null) return null
		next[position.id] = value
	}
	return next
}

/**
 * Where a scope's sales come from, and how many orders (and, for a
 * restaurant, how many guests) one person in each position handles in an
 * hour. The source decides what the labor share is built
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
	// Guests (covers) only exist where scopes are restaurant locations.
	const { isLocation } = useScopeLabel()
	const savedStandards = standardsText(positions, settings.ordersPerLaborHour)
	const savedVisitStandards = standardsText(
		positions,
		settings.demandPerLaborHour.visits,
	)
	const [standards, setStandards] = useState<StandardsText>(savedStandards)
	const [visitStandards, setVisitStandards] =
		useState<StandardsText>(savedVisitStandards)
	const [problem, setProblem] = useState<string | null>(null)
	const save = useStaffAction(describeLaborError)
	const formRef = useRef<HTMLFormElement>(null)
	const changed = (text: StandardsText, saved: StandardsText) =>
		positions.some(
			(position) =>
				(text[position.id] ?? '').trim() !== (saved[position.id] ?? ''),
		)
	const dirty =
		source !== settings.salesSource ||
		changed(standards, savedStandards) ||
		(isLocation && changed(visitStandards, savedVisitStandards))

	useSaveBar({
		dirty: canEdit && dirty,
		saving: save.pending,
		onSave: () => formRef.current?.requestSubmit(),
		onDiscard: () => {
			setSource(settings.salesSource)
			setStandards(savedStandards)
			setVisitStandards(savedVisitStandards)
			setProblem(null)
			save.reset()
		},
	})

	async function submit() {
		if (save.pending || !canEdit) return
		const next = readStandards(positions, standards)
		if (next === null) {
			setProblem(
				_(t`Enter orders per hour from 0.5 to 200, with at most one decimal.`),
			)
			return
		}
		const visits = isLocation ? readStandards(positions, visitStandards) : null
		if (isLocation && visits === null) {
			setProblem(
				_(t`Enter covers per hour from 0.5 to 200, with at most one decimal.`),
			)
			return
		}
		setProblem(null)
		const result = await save.run(() =>
			saveSettings(client, {
				scopeId: settings.scopeId,
				salesSource: source,
				ordersPerLaborHour: next,
				// Only a restaurant edits covers; other businesses keep what is saved.
				...(visits ? { demandPerLaborHour: { visits } } : {}),
			}),
		)
		if (result.ok) {
			// Show the saved (canonical) text so "12.0" does not stay dirty.
			setStandards(standardsText(positions, next))
			if (visits) setVisitStandards(standardsText(positions, visits))
			toast.success(_(t`Labor settings saved.`))
			onSaved()
		}
	}

	return (
		<form
			ref={formRef}
			className="flex max-w-2xl flex-col gap-8"
			noValidate
			onSubmit={(event) => {
				event.preventDefault()
				void submit()
			}}
		>
			<FieldSet disabled={!canEdit || save.pending}>
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

			<StandardsFieldSet
				legend={<Trans>Orders one person handles in an hour</Trans>}
				description={
					<Trans>
						The schedule compares the orders you usually get each hour with the
						people you have scheduled. Set how many orders one person in a
						position handles in an hour; leave a position empty to leave it out.
					</Trans>
				}
				unit={<Trans>orders/h</Trans>}
				idPrefix="standard"
				positions={positions}
				values={standards}
				locale={locale}
				canEdit={canEdit}
				readOnly={save.pending}
				onChange={(id, value) => {
					setStandards((current) => ({ ...current, [id]: value }))
					setProblem(null)
				}}
			/>

			{isLocation ? (
				<StandardsFieldSet
					legend={<Trans>Covers one person handles in an hour</Trans>}
					description={
						<Trans>
							Covers are the guests at your tables. The schedule adds the people
							this needs for booked and typical covers to what orders need.
							Leave a position empty to leave covers out for it.
						</Trans>
					}
					unit={<Trans>covers/h</Trans>}
					idPrefix="standard-visits"
					positions={positions}
					values={visitStandards}
					locale={locale}
					canEdit={canEdit}
					readOnly={save.pending}
					onChange={(id, value) => {
						setVisitStandards((current) => ({ ...current, [id]: value }))
						setProblem(null)
					}}
				/>
			) : null}

			{problem || save.error ? (
				<FieldError>{problem ?? save.error}</FieldError>
			) : null}
			{canEdit ? null : (
				<p className="text-muted-foreground text-sm">
					<Trans>You can look at these settings but not change them.</Trans>
				</p>
			)}
		</form>
	)
}

function StandardsFieldSet({
	legend,
	description,
	unit,
	idPrefix,
	positions,
	values,
	locale,
	canEdit,
	readOnly,
	onChange,
}: {
	legend: ReactNode
	description: ReactNode
	unit: ReactNode
	idPrefix: string
	positions: readonly LaborPosition[]
	values: StandardsText
	locale: string
	canEdit: boolean
	readOnly: boolean
	onChange: (positionId: string, value: string) => void
}) {
	return (
		<FieldSet disabled={!canEdit}>
			<FieldLegend>{legend}</FieldLegend>
			<FieldDescription>{description}</FieldDescription>
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
									htmlFor={`${idPrefix}-${position.id}`}
									className="min-w-0 truncate"
								>
									{positionLabel(position, locale)}
								</Label>
							</ItemContent>
							<ItemActions>
								<Input
									id={`${idPrefix}-${position.id}`}
									inputMode="decimal"
									dir="ltr"
									value={values[position.id] ?? ''}
									placeholder="–"
									readOnly={readOnly}
									className="h-11 w-24 text-end tabular-nums md:h-8"
									onChange={(event) =>
										onChange(position.id, event.target.value)
									}
								/>
								<span className="text-muted-foreground text-xs">{unit}</span>
							</ItemActions>
						</Item>
					))}
				</ItemGroup>
			)}
		</FieldSet>
	)
}
