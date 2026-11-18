import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	getLocationSetting,
	isLocationSettingId,
	type LocationSettingId,
} from '@repo/common/location-settings-registry'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Spinner } from '@repo/ui/spinner'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useEffect, useMemo, useState } from 'react'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	data,
	Link,
	useFetcher,
	useLoaderData,
	useNavigate,
} from 'react-router'
import {
	LOCATION_ERROR_LABELS,
	SETTING_DESCRIPTIONS,
	SETTING_LABELS,
} from '#app/components/locations/location-setting-labels.ts'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import {
	BULK_EDIT_SETTING_IDS,
	bulkEditInputSchema,
	editLocationSettingBulk,
	loadCompareRows,
} from '#app/utils/location/bulk-edit.server.ts'
import { requireLocationManager } from '#app/utils/location/location-access.server.ts'
import { enabledSettingIds } from '#app/utils/location/location-settings.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const manager = await requireLocationManager(request, params.orgSlug)
	const url = new URL(request.url)
	const enabled = await enabledSettingIds(manager.organization.id)
	const settings = BULK_EDIT_SETTING_IDS.filter((id) => enabled.has(id))
	const requested = url.searchParams.get('setting')
	const settingId: LocationSettingId =
		isLocationSettingId(requested) && settings.includes(requested as never)
			? requested
			: (settings.includes('prepTime') ? 'prepTime' : settings[0]!)

	const compare = await loadCompareRows({
		organization: manager.organization,
		scope: manager.scope,
		settingId,
	})
	const preselected = (url.searchParams.get('locations') ?? '')
		.split(',')
		.filter((id) => id.length > 0 && id.length <= 64)
		.filter((id) => compare.rows.some((row) => row.locationId === id))
	const definition = getLocationSetting(settingId)
	return {
		orgSlug: manager.organization.slug,
		settings,
		settingId,
		editor: definition.editor,
		preselected,
		...compare,
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const manager = await requireLocationManager(request, params.orgSlug)
	const formData = await request.formData()
	const intent = formData.get('intent')
	if (intent !== 'preview-edit' && intent !== 'apply-edit') {
		return data({ ok: false as const, error: 'invalid_request' }, { status: 400 })
	}
	const raw = formData.get('payload')
	let body
	try {
		const parsed = bulkEditInputSchema.safeParse(
			typeof raw === 'string' && raw.length <= 50_000 ? JSON.parse(raw) : null,
		)
		body = parsed.success ? parsed.data : null
	} catch {
		body = null
	}
	if (!body) {
		return data({ ok: false as const, error: 'invalid_request' }, { status: 400 })
	}
	const result = await editLocationSettingBulk({
		organization: manager.organization,
		userId: manager.userId,
		scope: manager.scope,
		request,
		body,
		apply: intent === 'apply-edit',
	})
	return result.ok
		? data({ ok: true as const, edit: result })
		: data({ ok: false as const, error: result.error }, { status: result.status })
}

type EditResponse =
	| {
			ok: true
			edit: {
				applied: boolean
				targets: Array<{
					locationId: string
					name: string
					changed: boolean
					before: string
					after: string
					skipped?: string
				}>
				skipped: Array<{
					locationId: string
					name: string | null
					reason: 'not_manageable' | 'not_found'
				}>
				changedLocationIds: string[]
			}
	  }
	| { ok: false; error: string }

const FULFILLMENT_KEYS = ['pickup', 'delivery', 'dineIn', 'curbside'] as const

export default function CompareLocationSettingsRoute() {
	const { _ } = useLingui()
	const loaderData = useLoaderData<typeof loader>()
	const {
		orgSlug,
		settings,
		settingId,
		editor,
		rows,
		hiddenCount,
		defaultText,
		locked,
		lockReason,
		preselected,
	} = loaderData
	const navigate = useNavigate()
	const fetcher = useFetcher<EditResponse>()

	const [selected, setSelected] = useState<Set<string>>(new Set(preselected))
	const [mode, setMode] = useState<'value' | 'match' | 'clear'>(
		editor ? 'value' : 'match',
	)
	const [numberValue, setNumberValue] = useState('')
	const [toggles, setToggles] = useState<Record<string, boolean>>({
		pickup: true,
		delivery: false,
		dineIn: false,
		curbside: false,
	})
	const [sourceId, setSourceId] = useState(rows[0]?.locationId ?? '')
	const [lastIntent, setLastIntent] = useState<string | null>(null)

	// A different setting is a different table: start its selection afresh.
	useEffect(() => {
		setSelected(new Set(preselected))
		setMode(editor ? 'value' : 'match')
		setLastIntent(null)
		// eslint-disable-next-line react-hooks/exhaustive-deps -- reset per setting
	}, [settingId])

	const selectLabel = (name: string) => t`Select ${name}`
	const busy = fetcher.state !== 'idle'
	const response = fetcher.data
	const edit = response && response.ok ? response.edit : null
	const failure = response && !response.ok ? response : null
	const settingOptions = useMemo(
		() =>
			settings.map((id) => ({
				value: id,
				label: _(SETTING_LABELS[id as LocationSettingId]),
			})),
		[settings, _],
	)
	const selectedIds = rows
		.filter((row) => selected.has(row.locationId))
		.map((row) => row.locationId)
	const allSelected = rows.length > 0 && selectedIds.length === rows.length

	function payload() {
		const change =
			mode === 'clear'
				? { kind: 'clear' as const }
				: mode === 'match'
					? { kind: 'match' as const, sourceId }
					: {
							kind: 'value' as const,
							value:
								editor?.kind === 'number'
									? Number(numberValue)
									: Object.fromEntries(
											FULFILLMENT_KEYS.map((key) => [key, toggles[key] === true]),
										),
						}
		return JSON.stringify({ settingId, locationIds: selectedIds, change })
	}

	function submit(intent: 'preview-edit' | 'apply-edit') {
		setLastIntent(intent)
		void fetcher.submit({ intent, payload: payload() }, { method: 'POST' })
	}

	const valueReady =
		mode !== 'value' ||
		(editor?.kind === 'number'
			? numberValue.trim() !== '' && Number.isFinite(Number(numberValue))
			: true)
	const canPreview =
		selectedIds.length > 0 && valueReady && (mode !== 'match' || sourceId !== '')
	const previewReady = lastIntent === 'preview-edit' && edit && !edit.applied
	const applied = lastIntent === 'apply-edit' && edit?.applied

	return (
		<div className="flex flex-col gap-6">
			<div className="flex items-center gap-3">
				<Button
					variant="outline"
					size="icon"
					render={<Link to={`/${orgSlug}/settings/locations`} />}
				>
					<Icon name="arrow-left" className="size-4" />
					<span className="sr-only">
						<Trans>Back</Trans>
					</span>
				</Button>
				<div>
					<h2 className="text-xl tracking-tight">
						<Trans>Compare and edit a setting</Trans>
					</h2>
					<p className="text-muted-foreground text-sm">
						<Trans>
							See one setting at every location, choose several, and change
							them together.
						</Trans>
					</p>
				</div>
			</div>

			<SelectField
				className="max-w-sm"
				label={<Trans>Setting</Trans>}
				options={settingOptions}
				value={settingId}
				onValueChange={(value) =>
					void navigate(`?setting=${encodeURIComponent(value)}`)
				}
			/>
			<p className="text-muted-foreground -mt-4 text-sm">
				{_(SETTING_DESCRIPTIONS[settingId as LocationSettingId])}
			</p>

			{locked ? (
				<Alert data-testid="compare-locked">
					<AlertDescription>
						<Trans>
							Head office has locked this setting, so it cannot be changed at a
							location.
						</Trans>{' '}
						{lockReason}
					</AlertDescription>
				</Alert>
			) : null}
			{defaultText ? (
				<p className="text-sm">
					<Trans>Chain default:</Trans>{' '}
					<span className="font-medium">{defaultText}</span>
				</p>
			) : null}
			{hiddenCount > 0 ? (
				<p className="text-muted-foreground text-sm">
					{plural(hiddenCount, {
						one: '# other location is outside your access and is not shown.',
						other:
							'# other locations are outside your access and are not shown.',
					})}
				</p>
			) : null}

			<Frame className="w-full">
				<Table variant="card">
					<TableHeader>
						<TableRow>
							<TableHead className="w-10">
								<Checkbox
									aria-label={t`Select all locations`}
									checked={allSelected}
									onCheckedChange={(value) =>
										setSelected(
											value === true
												? new Set(rows.map((row) => row.locationId))
												: new Set(),
										)
									}
								/>
							</TableHead>
							<TableHead>
								<Trans>Location</Trans>
							</TableHead>
							<TableHead>
								<Trans>Current value</Trans>
							</TableHead>
							<TableHead>
								<Trans>Chain default</Trans>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((row) => (
							<TableRow key={row.locationId} data-testid="compare-row">
								<TableCell className="w-10">
									<Checkbox
										aria-label={selectLabel(row.name)}
										checked={selected.has(row.locationId)}
										onCheckedChange={(value) =>
											setSelected((current) => {
												const next = new Set(current)
												if (value === true) next.add(row.locationId)
												else next.delete(row.locationId)
												return next
											})
										}
									/>
								</TableCell>
								<TableCell className="font-medium wrap-anywhere">
									{row.name}
									{row.isActive ? null : (
										<Badge variant="outline" className="ms-2 text-[10px]">
											<Trans>Inactive</Trans>
										</Badge>
									)}
								</TableCell>
								<TableCell className="wrap-anywhere">{row.value}</TableCell>
								<TableCell>
									{defaultText === null ? (
										<span className="text-muted-foreground">—</span>
									) : row.overridesDefault ? (
										<Badge variant="outline">
											<Trans>Override</Trans>
										</Badge>
									) : (
										<Badge variant="secondary">
											<Trans>Inherits</Trans>
										</Badge>
									)}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</Frame>

			<div className="bg-card space-y-4 rounded-md border p-4">
				<h3 className="font-medium">
					{plural(selectedIds.length, {
						one: 'Change # selected location',
						other: 'Change # selected locations',
					})}
				</h3>
				<div className="flex flex-wrap gap-2">
					{editor ? (
						<Button
							type="button"
							size="sm"
							variant={mode === 'value' ? 'default' : 'outline'}
							disabled={locked}
							onClick={() => setMode('value')}
						>
							<Trans>Set a value</Trans>
						</Button>
					) : null}
					<Button
						type="button"
						size="sm"
						variant={mode === 'match' ? 'default' : 'outline'}
						disabled={locked}
						onClick={() => setMode('match')}
					>
						<Trans>Match another location</Trans>
					</Button>
					<Button
						type="button"
						size="sm"
						variant={mode === 'clear' ? 'default' : 'outline'}
						onClick={() => setMode('clear')}
					>
						<Trans>Clear override (back to the default)</Trans>
					</Button>
				</div>

				{mode === 'value' && editor?.kind === 'number' ? (
					<TextField
						className="max-w-xs"
						label={<Trans>New value (minutes)</Trans>}
						type="text"
						inputMode="numeric"
						dir="ltr"
						value={numberValue}
						onChange={(event) => setNumberValue(event.target.value)}
					/>
				) : null}
				{mode === 'value' && editor?.kind === 'toggles' ? (
					<fieldset className="grid gap-2 sm:grid-cols-2">
						{FULFILLMENT_KEYS.map((key) => (
							<label key={key} className="flex items-center gap-2 text-sm">
								<Checkbox
									checked={toggles[key] === true}
									onCheckedChange={(value) =>
										setToggles((current) => ({
											...current,
											[key]: value === true,
										}))
									}
								/>
								{key === 'pickup' ? (
									<Trans>Pickup</Trans>
								) : key === 'delivery' ? (
									<Trans>Delivery</Trans>
								) : key === 'dineIn' ? (
									<Trans>Dine-in</Trans>
								) : (
									<Trans>Curbside</Trans>
								)}
							</label>
						))}
					</fieldset>
				) : null}
				{mode === 'match' ? (
					<SelectField
						className="max-w-sm"
						label={<Trans>Use the value of</Trans>}
						options={rows.map((row) => ({
							value: row.locationId,
							label: row.name,
						}))}
						value={sourceId}
						onValueChange={setSourceId}
					/>
				) : null}
				{mode === 'clear' ? (
					<p className="text-muted-foreground text-sm">
						{defaultText ? (
							<Trans>
								Each selected location returns to the chain default:{' '}
								{defaultText}.
							</Trans>
						) : (
							<Trans>
								There is no chain default for this setting, so each selected
								location returns to the standard value.
							</Trans>
						)}
					</p>
				) : null}

				{failure ? (
					<Alert variant="destructive">
						<AlertDescription>
							{failure.error in LOCATION_ERROR_LABELS
								? _(LOCATION_ERROR_LABELS[failure.error]!)
								: failure.error === 'invalid_value'
									? _(t`That value is not allowed for this setting.`)
									: failure.error}
						</AlertDescription>
					</Alert>
				) : null}

				{edit ? (
					<div className="space-y-2" data-testid="compare-preview">
						{applied ? (
							<Alert>
								<AlertDescription>
									{plural(edit.changedLocationIds.length, {
										one: 'Updated # location.',
										other: 'Updated # locations.',
									})}
								</AlertDescription>
							</Alert>
						) : null}
						<ul className="space-y-1 text-sm">
							{edit.targets.map((target) => (
								<li key={target.locationId} className="wrap-anywhere">
									<span className="font-medium">{target.name}</span>
									{': '}
									{target.skipped ? (
										<Trans>skipped (different currency)</Trans>
									) : target.changed ? (
										`${target.before} → ${target.after}`
									) : (
										<Trans>already this value</Trans>
									)}
								</li>
							))}
						</ul>
						{edit.skipped.length > 0 ? (
							<Alert data-testid="compare-skipped">
								<AlertDescription>
									<Trans>Not changed (you cannot manage these):</Trans>{' '}
									{edit.skipped
										.map((location) => location.name ?? location.locationId)
										.join(', ')}
								</AlertDescription>
							</Alert>
						) : null}
					</div>
				) : null}

				<div className="flex flex-wrap gap-2">
					{previewReady ? (
						<Button
							type="button"
							disabled={busy || !edit.targets.some((target) => target.changed)}
							onClick={() => submit('apply-edit')}
						>
							{busy ? <Spinner /> : null}
							<Trans>Apply changes</Trans>
						</Button>
					) : (
						<Button
							type="button"
							disabled={busy || !canPreview || (applied === true)}
							onClick={() => submit('preview-edit')}
						>
							{busy ? <Spinner /> : null}
							<Trans>Preview changes</Trans>
						</Button>
					)}
				</div>
			</div>
		</div>
	)
}
