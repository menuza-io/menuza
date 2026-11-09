import { Trans, useLingui } from '@lingui/react/macro'
import { type PrepLevelItem, prepLevelsSchema } from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Field, FieldError, FieldLabel } from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import { Skeleton } from '@repo/ui/skeleton'
import { WorkspacePanel } from '@repo/ui/workspace'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import {
	useNotifyInventoryChanged,
	useQuantityFormat,
} from '#app/components/inventory/inventory-prefs.tsx'
import { FilterSelect } from '#app/components/staff/controls.tsx'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import { inventorySaveErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import {
	buildPutLevels,
	type LevelDrafts,
	levelDraftProblems,
	levelDraftsChanged,
	levelDraftsFromItem,
	WEEKDAYS,
} from '#app/utils/inventory/prep-view.ts'

const ANY_STATION = 'any'

/** A weekday's name in the viewer's language (0 Sunday ... 6 Saturday). */
function weekdayName(weekday: number, locale: string): string {
	return new Intl.DateTimeFormat(locale, {
		weekday: 'long',
		timeZone: 'UTC',
	}).format(new Date(Date.UTC(2023, 0, 1 + weekday)))
}

/**
 * "Fill up to" per weekday for the things made in house, and which kitchen
 * station makes each. A weekday left empty uses the item's usual level, and an
 * item with no level at all is not planned. Each item saves by itself.
 */
export function PrepLevelsPanel({
	locationId,
	canEdit,
}: {
	locationId: string
	canEdit: boolean
}) {
	const levels = useInventoryQuery(
		`/prep/levels?${new URLSearchParams({ locationId })}`,
		prepLevelsSchema,
	)
	const quantity = useQuantityFormat()
	const [editing, setEditing] = useState<PrepLevelItem | null>(null)

	if (levels.loading && !levels.data) {
		return <Skeleton className="h-24 w-full rounded-xl" />
	}
	const data = levels.data
	if (!data || data.items.length === 0) return null

	const summary = (item: PrepLevelItem) => {
		const setCount = item.weekdays.filter((value) => value !== null).length
		if (setCount > 0) {
			return (
				<Trans>
					Set for <bdi dir="ltr">{setCount}</bdi> of 7 days
				</Trans>
			)
		}
		if (item.usual !== null) {
			const usual = quantity.format(item.usual, {
				baseUnit: item.baseUnit,
				countUnit: item.countUnit,
				units: item.units,
			})
			return (
				<Trans>
					Every day: <bdi dir="ltr">{usual}</bdi>
				</Trans>
			)
		}
		return <Trans>Not planned. Set a level to plan it.</Trans>
	}

	return (
		<WorkspacePanel
			title={<Trans>How much to keep</Trans>}
			description={
				<Trans>
					The most of each made item you want ready for service. Plans fill up
					to this.
				</Trans>
			}
		>
			<ul
				className="flex flex-col divide-y rounded-xl border"
				data-testid="prep-levels"
			>
				{data.items.map((item) => (
					<li
						key={item.itemId}
						className="flex flex-wrap items-center justify-between gap-3 p-3"
						data-testid={`prep-level-${item.itemId}`}
					>
						<span className="flex min-w-0 flex-col">
							<span className="text-sm font-medium wrap-anywhere">
								{item.name}
							</span>
							<span className="text-muted-foreground text-xs">
								{summary(item)}
							</span>
						</span>
						{canEdit ? (
							<Button
								variant="outline"
								size="sm"
								onClick={() => setEditing(item)}
								data-testid={`prep-level-edit-${item.itemId}`}
							>
								<Trans>Set levels</Trans>
							</Button>
						) : null}
					</li>
				))}
			</ul>
			{editing ? (
				<LevelsDialog
					item={editing}
					locationId={locationId}
					stations={data.stations}
					onClose={() => setEditing(null)}
					onSaved={() => {
						setEditing(null)
						levels.reload()
					}}
				/>
			) : null}
		</WorkspacePanel>
	)
}

function LevelsDialog({
	item,
	locationId,
	stations,
	onClose,
	onSaved,
}: {
	item: PrepLevelItem
	locationId: string
	stations: readonly { id: string; name: string }[]
	onClose: () => void
	onSaved: () => void
}) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const notifyChanged = useNotifyInventoryChanged()
	const quantity = useQuantityFormat()
	const idBase = useId()
	const [drafts, setDrafts] = useState<LevelDrafts>(() =>
		levelDraftsFromItem(item),
	)
	const [saving, setSaving] = useState(false)
	const [attempted, setAttempted] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const problems = attempted ? levelDraftProblems(item, drafts) : []
	const unit = quantity.unitName(item.countUnit, item.units)

	async function save(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (saving) return
		setAttempted(true)
		const body = buildPutLevels(item, drafts, locationId)
		if (!body) return
		if (!levelDraftsChanged(item, drafts)) {
			onClose()
			return
		}
		setSaving(true)
		setError(null)
		try {
			await request('/prep/levels', {
				method: 'PUT',
				body: JSON.stringify(body),
			})
			toast.success(t`Levels saved.`)
			notifyChanged()
			onSaved()
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setSaving(false)
		}
	}

	const stationOptions = [
		{ value: ANY_STATION, label: t`Any station` },
		...stations.map((station) => ({ value: station.id, label: station.name })),
	]

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !saving) onClose()
			}}
		>
			<DialogContent
				className="max-h-dvh overflow-y-auto sm:max-w-md"
				data-testid="prep-levels-dialog"
			>
				<DialogHeader>
					<DialogTitle>{item.name}</DialogTitle>
					<DialogDescription>
						<Trans>
							How much to have ready each day, in <bdi dir="ltr">{unit}</bdi>.
							Leave a day empty to use the usual level.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<form
					onSubmit={(event) => void save(event)}
					noValidate
					className="flex flex-col gap-3"
				>
					{error ? (
						<Alert variant="destructive" data-testid="prep-levels-error">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}
					<div className="grid grid-cols-2 gap-3">
						{WEEKDAYS.map((day) => (
							<Field
								key={day}
								data-invalid={problems.includes(day) ? true : undefined}
							>
								<FieldLabel htmlFor={`${idBase}-${day}`}>
									{weekdayName(day, i18n.locale)}
								</FieldLabel>
								<Input
									id={`${idBase}-${day}`}
									inputMode="decimal"
									value={drafts.weekdays[day] ?? ''}
									disabled={saving}
									onChange={(event) =>
										setDrafts({
											...drafts,
											weekdays: drafts.weekdays.map((text, index) =>
												index === day ? event.target.value : text,
											),
										})
									}
									data-testid={`prep-level-day-${day}`}
								/>
								{problems.includes(day) ? (
									<FieldError>
										<Trans>Enter a number.</Trans>
									</FieldError>
								) : null}
							</Field>
						))}
					</div>
					{stations.length > 1 ? (
						<FilterSelect
							label={t`Made at`}
							options={stationOptions}
							value={drafts.stationId ?? ANY_STATION}
							onValueChange={(value) =>
								setDrafts({
									...drafts,
									stationId: value === ANY_STATION ? null : value,
								})
							}
							testId="prep-level-station"
						/>
					) : null}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={onClose}
							disabled={saving}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							type="submit"
							disabled={saving}
							data-testid="prep-levels-save"
						>
							{saving ? <Trans>Saving…</Trans> : <Trans>Save levels</Trans>}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
