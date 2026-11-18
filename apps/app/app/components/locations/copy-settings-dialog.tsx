import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	LOCATION_SETTING_IDS,
	type LocationSettingId,
} from '@repo/common/location-settings-registry'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Field, FieldLabel } from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { Spinner } from '@repo/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { useEffect, useId, useState } from 'react'
import { useFetcher } from 'react-router'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import {
	COPY_NOTE_LABELS,
	COPY_SKIP_LABELS,
	LOCATION_ERROR_LABELS,
	SETTING_DESCRIPTIONS,
	SETTING_LABELS,
} from './location-setting-labels.ts'

export type CopyDialogLocation = {
	id: string
	name: string
	isActive: boolean
	/** Inside the person's location scope. */
	manageable: boolean
}

type CopyChange = {
	part: LocationSettingId
	changed: boolean
	before: string
	after: string
	notes: Array<keyof typeof COPY_NOTE_LABELS>
	skipped?: keyof typeof COPY_SKIP_LABELS
}

type CopyTarget = {
	targetId: string
	targetName: string
	changed: boolean
	changes: CopyChange[]
}

type Skipped = {
	locationId: string
	name: string | null
	reason: 'not_manageable' | 'not_found'
}

type CopyResponse =
	| {
			ok: true
			copy: {
				applied: boolean
				targets: CopyTarget[]
				skipped: Skipped[]
				changedLocationIds: string[]
			}
	  }
	| {
			ok: true
			holiday: {
				added: Array<{ locationId: string; name: string }>
				alreadyHadDate: Array<{ locationId: string; name: string }>
				skipped: Skipped[]
			}
	  }
	| { ok: false; error: string; settings?: string[] }

/**
 * Copy chosen settings from one location to others, with a preview of what
 * changes per target, and the "add a holiday to all locations" shortcut. The
 * server decides what a person may do: locations outside their scope are
 * listed as skipped, never written.
 */
export function CopySettingsDialog({
	open,
	onOpenChange,
	locations,
	enabledSettings,
	initialSourceId,
	initialTargetIds,
	initialTab = 'copy',
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	locations: CopyDialogLocation[]
	/** Settings the organization can use (flagged ones only when their flag is on). */
	enabledSettings: LocationSettingId[]
	initialSourceId?: string
	initialTargetIds?: string[]
	initialTab?: 'copy' | 'holiday'
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<CopyResponse>()
	const idPrefix = useId()
	const manageable = locations.filter((location) => location.manageable)

	const [tab, setTab] = useState<'copy' | 'holiday'>(initialTab)
	const [sourceId, setSourceId] = useState(initialSourceId ?? '')
	const [parts, setParts] = useState<Set<LocationSettingId>>(new Set())
	const [targets, setTargets] = useState<Set<string>>(
		new Set(initialTargetIds ?? []),
	)
	const [specialMode, setSpecialMode] = useState<'add' | 'replace'>('add')
	const [rangeFrom, setRangeFrom] = useState('')
	const [rangeTo, setRangeTo] = useState('')
	const [holidayDate, setHolidayDate] = useState('')
	const [holidayOpen, setHolidayOpen] = useState(false)
	const [holidayStart, setHolidayStart] = useState('10:00')
	const [holidayEnd, setHolidayEnd] = useState('14:00')
	const [holidayNote, setHolidayNote] = useState('')
	const [lastIntent, setLastIntent] = useState<string | null>(null)

	useEffect(() => {
		if (!open) return
		const source = initialSourceId ?? manageable[0]?.id ?? ''
		setTab(initialTab)
		setSourceId(source)
		// Selected rows are the targets; the source is never its own target.
		setTargets(
			new Set(
				(initialTargetIds ?? []).filter(
					(id) => initialTab === 'holiday' || id !== source,
				),
			),
		)
		setParts(new Set())
		setLastIntent(null)
		// eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when it opens
	}, [open])

	const busy = fetcher.state !== 'idle'
	const response = fetcher.data
	const copyResponse =
		response && response.ok && 'copy' in response ? response.copy : null
	const holidayResponse =
		response && response.ok && 'holiday' in response ? response.holiday : null
	const failure = response && !response.ok ? response : null

	const targetOptions = manageable.filter(
		(location) => tab === 'holiday' || location.id !== sourceId,
	)
	const sourceOptions = manageable.map((location) => ({
		value: location.id,
		label: location.name,
	}))

	function toggleTarget(id: string, checked: boolean) {
		setTargets((current) => {
			const next = new Set(current)
			if (checked) next.add(id)
			else next.delete(id)
			return next
		})
	}
	function togglePart(id: LocationSettingId, checked: boolean) {
		setParts((current) => {
			const next = new Set(current)
			if (checked) next.add(id)
			else next.delete(id)
			return next
		})
	}

	function submitCopy(intent: 'preview-copy' | 'copy-settings') {
		setLastIntent(intent)
		void fetcher.submit(
			{
				intent,
				payload: JSON.stringify({
					sourceId,
					targetIds: [...targets].filter((id) => id !== sourceId),
					parts: LOCATION_SETTING_IDS.filter((id) => parts.has(id)),
					...(parts.has('specialHours')
						? {
								specialHours: {
									mode: specialMode,
									from: specialMode === 'replace' ? rangeFrom || null : null,
									to: specialMode === 'replace' ? rangeTo || null : null,
								},
							}
						: {}),
				}),
			},
			{ method: 'POST' },
		)
	}

	function submitHoliday() {
		setLastIntent('add-holiday')
		void fetcher.submit(
			{
				intent: 'add-holiday',
				payload: JSON.stringify({
					targetIds: [...targets],
					date: holidayDate,
					isOpen: holidayOpen,
					slots: holidayOpen ? [{ start: holidayStart, end: holidayEnd }] : [],
					...(holidayNote.trim() ? { note: holidayNote.trim() } : {}),
				}),
			},
			{ method: 'POST' },
		)
	}

	const canPreview = sourceId !== '' && parts.size > 0 && targets.size > 0
	const canHoliday =
		/^\d{4}-\d{2}-\d{2}$/.test(holidayDate) &&
		targets.size > 0 &&
		(!holidayOpen || holidayEnd > holidayStart)
	const previewReady =
		lastIntent === 'preview-copy' && copyResponse && !copyResponse.applied
	const copied = lastIntent === 'copy-settings' && copyResponse?.applied

	const targetPicker = (
		<fieldset className="space-y-2">
			<div className="flex items-center justify-between gap-2">
				<legend className="text-sm font-medium">
					<Trans>Locations to change</Trans>
				</legend>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() =>
						setTargets(
							targets.size === targetOptions.length
								? new Set()
								: new Set(targetOptions.map((location) => location.id)),
						)
					}
				>
					{targets.size === targetOptions.length ? (
						<Trans>Clear all</Trans>
					) : (
						<Trans>Select all</Trans>
					)}
				</Button>
			</div>
			<div className="grid max-h-48 gap-2 overflow-y-auto rounded-md border p-3 sm:grid-cols-2">
				{targetOptions.map((location) => {
					const id = `${idPrefix}-target-${location.id}`
					return (
						<Field key={location.id} orientation="horizontal">
							<Checkbox
								id={id}
								checked={targets.has(location.id)}
								onCheckedChange={(value) =>
									toggleTarget(location.id, value === true)
								}
							/>
							<FieldLabel htmlFor={id} className="wrap-anywhere">
								{location.name}
								{location.isActive ? null : (
									<Badge variant="outline" className="ms-2 text-[10px]">
										<Trans>Inactive</Trans>
									</Badge>
								)}
							</FieldLabel>
						</Field>
					)
				})}
			</div>
		</fieldset>
	)

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						<Trans>Copy settings between locations</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Choose what to copy and where. You see what changes at each
							location before anything is saved.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				<Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)}>
					<TabsList>
						<TabsTrigger value="copy">
							<Trans>Copy settings</Trans>
						</TabsTrigger>
						<TabsTrigger value="holiday">
							<Trans>Add holiday to locations</Trans>
						</TabsTrigger>
					</TabsList>

					<TabsContent value="copy" className="mt-4 space-y-4">
						<SelectField
							label={<Trans>Copy from</Trans>}
							options={sourceOptions}
							value={sourceId}
							onValueChange={(value) => {
								setSourceId(value)
								setTargets((current) => {
									const next = new Set(current)
									next.delete(value)
									return next
								})
							}}
						/>

						<fieldset className="space-y-2">
							<legend className="text-sm font-medium">
								<Trans>What to copy</Trans>
							</legend>
							<div className="grid gap-3 sm:grid-cols-2">
								{LOCATION_SETTING_IDS.filter((id) =>
									enabledSettings.includes(id),
								).map((id) => {
									const fieldId = `${idPrefix}-part-${id}`
									return (
										<Field key={id} orientation="horizontal">
											<Checkbox
												id={fieldId}
												checked={parts.has(id)}
												onCheckedChange={(value) =>
													togglePart(id, value === true)
												}
											/>
											<div className="grid gap-0.5">
												<FieldLabel htmlFor={fieldId}>
													{_(SETTING_LABELS[id])}
												</FieldLabel>
												<span className="text-muted-foreground text-xs">
													{_(SETTING_DESCRIPTIONS[id])}
												</span>
											</div>
										</Field>
									)
								})}
							</div>
						</fieldset>

						{parts.has('specialHours') ? (
							<div className="bg-muted/30 space-y-3 rounded-md border p-3">
								<RadioGroup
									value={specialMode}
									onValueChange={(value) =>
										setSpecialMode(value as 'add' | 'replace')
									}
									aria-label={t`How to copy special hours`}
								>
									<Field orientation="horizontal">
										<RadioGroupItem value="add" id={`${idPrefix}-add`} />
										<FieldLabel htmlFor={`${idPrefix}-add`}>
											<Trans>
												Add: keep each location&apos;s own entries and skip dates
												it already has
											</Trans>
										</FieldLabel>
									</Field>
									<Field orientation="horizontal">
										<RadioGroupItem
											value="replace"
											id={`${idPrefix}-replace`}
										/>
										<FieldLabel htmlFor={`${idPrefix}-replace`}>
											<Trans>
												Replace: swap the entries in the date range below
											</Trans>
										</FieldLabel>
									</Field>
								</RadioGroup>
								{specialMode === 'replace' ? (
									<div className="grid grid-cols-2 gap-3">
										<TextField
											label={<Trans>From (optional)</Trans>}
											type="date"
											value={rangeFrom}
											onChange={(event) => setRangeFrom(event.target.value)}
										/>
										<TextField
											label={<Trans>To (optional)</Trans>}
											type="date"
											value={rangeTo}
											onChange={(event) => setRangeTo(event.target.value)}
										/>
									</div>
								) : null}
							</div>
						) : null}

						{targetPicker}

						{failure ? (
							<Alert variant="destructive">
								<AlertDescription>
									{failure.error in LOCATION_ERROR_LABELS
										? _(LOCATION_ERROR_LABELS[failure.error]!)
										: failure.error}
									{failure.settings && failure.settings.length > 0
										? `: ${failure.settings
												.map((id) => _(SETTING_LABELS[id as LocationSettingId]))
												.join(', ')}`
										: null}
								</AlertDescription>
							</Alert>
						) : null}

						{copyResponse ? (
							<div className="space-y-3" data-testid="copy-preview">
								{copied ? (
									<Alert>
										<AlertDescription>
											{plural(copyResponse.changedLocationIds.length, {
												one: 'Copied to # location.',
												other: 'Copied to # locations.',
											})}
										</AlertDescription>
									</Alert>
								) : null}
								<ul className="space-y-3">
									{copyResponse.targets.map((target) => (
										<li key={target.targetId} className="rounded-md border p-3">
											<p className="font-medium wrap-anywhere">
												{target.targetName}
												{target.changed ? null : (
													<span className="text-muted-foreground ms-2 text-xs font-normal">
														<Trans>Nothing to change</Trans>
													</span>
												)}
											</p>
											<ul className="mt-2 space-y-2 text-sm">
												{target.changes.map((change) => (
													<li key={change.part}>
														<span className="font-medium">
															{_(SETTING_LABELS[change.part])}
														</span>
														{change.skipped ? (
															<span className="text-muted-foreground block">
																{_(COPY_SKIP_LABELS[change.skipped])}
															</span>
														) : change.changed ? (
															<span className="text-muted-foreground block wrap-anywhere">
																{change.before} → {change.after}
															</span>
														) : (
															<span className="text-muted-foreground block">
																<Trans>Already the same</Trans>
															</span>
														)}
														{change.notes.map((note) => (
															<span
																key={note}
																className="text-muted-foreground block text-xs"
															>
																{_(COPY_NOTE_LABELS[note])}
															</span>
														))}
													</li>
												))}
											</ul>
										</li>
									))}
								</ul>
								<SkippedList skipped={copyResponse.skipped} />
							</div>
						) : null}

						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => onOpenChange(false)}
							>
								{copied ? <Trans>Close</Trans> : <Trans>Cancel</Trans>}
							</Button>
							{previewReady ? (
								<Button
									type="button"
									disabled={
										busy ||
										!copyResponse.targets.some((target) => target.changed)
									}
									onClick={() => submitCopy('copy-settings')}
								>
									{busy ? <Spinner /> : null}
									<Trans>Copy settings</Trans>
								</Button>
							) : copied ? null : (
								<Button
									type="button"
									disabled={busy || !canPreview}
									onClick={() => submitCopy('preview-copy')}
								>
									{busy ? <Spinner /> : null}
									<Trans>Preview changes</Trans>
								</Button>
							)}
						</DialogFooter>
					</TabsContent>

					<TabsContent value="holiday" className="mt-4 space-y-4">
						<TextField
							label={<Trans>Date</Trans>}
							type="date"
							value={holidayDate}
							onChange={(event) => setHolidayDate(event.target.value)}
						/>
						<RadioGroup
							value={holidayOpen ? 'short' : 'closed'}
							onValueChange={(value) => setHolidayOpen(value === 'short')}
							aria-label={t`Closed or short day`}
						>
							<Field orientation="horizontal">
								<RadioGroupItem value="closed" id={`${idPrefix}-closed`} />
								<FieldLabel htmlFor={`${idPrefix}-closed`}>
									<Trans>Closed all day</Trans>
								</FieldLabel>
							</Field>
							<Field orientation="horizontal">
								<RadioGroupItem value="short" id={`${idPrefix}-short`} />
								<FieldLabel htmlFor={`${idPrefix}-short`}>
									<Trans>Short day with these hours</Trans>
								</FieldLabel>
							</Field>
						</RadioGroup>
						{holidayOpen ? (
							<div className="grid grid-cols-2 gap-3">
								<TextField
									label={<Trans>Opens</Trans>}
									type="time"
									value={holidayStart}
									onChange={(event) => setHolidayStart(event.target.value)}
								/>
								<TextField
									label={<Trans>Closes</Trans>}
									type="time"
									value={holidayEnd}
									onChange={(event) => setHolidayEnd(event.target.value)}
								/>
							</div>
						) : null}
						<Field>
							<FieldLabel htmlFor={`${idPrefix}-note`}>
								<Trans>Note (optional)</Trans>
							</FieldLabel>
							<Input
								id={`${idPrefix}-note`}
								maxLength={200}
								value={holidayNote}
								onChange={(event) => setHolidayNote(event.target.value)}
							/>
						</Field>
						{targetPicker}

						{failure && lastIntent === 'add-holiday' ? (
							<Alert variant="destructive">
								<AlertDescription>
									{failure.error in LOCATION_ERROR_LABELS
										? _(LOCATION_ERROR_LABELS[failure.error]!)
										: failure.error}
								</AlertDescription>
							</Alert>
						) : null}

						{holidayResponse && lastIntent === 'add-holiday' ? (
							<div className="space-y-2 text-sm" data-testid="holiday-result">
								<Alert>
									<AlertDescription>
										{plural(holidayResponse.added.length, {
											one: 'Added to # location.',
											other: 'Added to # locations.',
										})}
									</AlertDescription>
								</Alert>
								{holidayResponse.alreadyHadDate.length > 0 ? (
									<p className="text-muted-foreground">
										<Trans>Already had this date, left as it was:</Trans>{' '}
										{holidayResponse.alreadyHadDate
											.map((location) => location.name)
											.join(', ')}
									</p>
								) : null}
								<SkippedList skipped={holidayResponse.skipped} />
							</div>
						) : null}

						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => onOpenChange(false)}
							>
								<Trans>Close</Trans>
							</Button>
							<Button
								type="button"
								disabled={busy || !canHoliday}
								onClick={submitHoliday}
							>
								{busy ? <Spinner /> : null}
								<Trans>Add holiday</Trans>
							</Button>
						</DialogFooter>
					</TabsContent>
				</Tabs>
			</DialogContent>
		</Dialog>
	)
}

function SkippedList({ skipped }: { skipped: Skipped[] }) {
	const { _ } = useLingui()
	if (skipped.length === 0) return null
	return (
		<Alert data-testid="skipped-locations">
			<AlertDescription>
				<p className="font-medium">
					<Trans>Not changed (you cannot manage these locations):</Trans>
				</p>
				<ul className="mt-1 list-disc ps-5">
					{skipped.map((location) => (
						<li key={location.locationId} className="wrap-anywhere">
							{location.name ?? location.locationId} (
							{_(LOCATION_ERROR_LABELS[location.reason]!)})
						</li>
					))}
				</ul>
			</AlertDescription>
		</Alert>
	)
}
