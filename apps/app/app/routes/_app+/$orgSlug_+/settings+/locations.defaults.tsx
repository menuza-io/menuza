import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	MAX_LOCK_REASON_LENGTH,
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
import { Icon } from '@repo/ui/icon'
import { Spinner } from '@repo/ui/spinner'
import { useState } from 'react'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	data,
	Link,
	useFetcher,
	useLoaderData,
} from 'react-router'
import {
	LOCATION_ERROR_LABELS,
	SETTING_DESCRIPTIONS,
	SETTING_LABELS,
} from '#app/components/locations/location-setting-labels.ts'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import {
	applyChainDefaultIntent,
	chainDefaultInputSchema,
	loadChainDefaults,
	type ChainDefaultRow,
} from '#app/utils/location/chain-defaults.server.ts'
import { requireHeadOffice } from '#app/utils/location/location-access.server.ts'
import { loadLocationRecords } from '#app/utils/location/location-settings.server.ts'

/**
 * Chain defaults and locks (#417). Head office (a member with every location)
 * gives a setting a default and decides whether locations may override it.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const manager = await requireHeadOffice(request, params.orgSlug)
	const [overview, records] = await Promise.all([
		loadChainDefaults(manager.organization),
		loadLocationRecords(manager.organization),
	])
	return {
		orgSlug: manager.organization.slug,
		...overview,
		locations: records.map((record) => ({ id: record.id, name: record.name })),
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const manager = await requireHeadOffice(request, params.orgSlug)
	const formData = await request.formData()
	const raw = formData.get('payload')
	let body
	try {
		const parsed = chainDefaultInputSchema.safeParse(
			typeof raw === 'string' && raw.length <= 50_000 ? JSON.parse(raw) : null,
		)
		body = parsed.success ? parsed.data : null
	} catch {
		body = null
	}
	if (!body) {
		return data(
			{ ok: false as const, error: 'invalid_request' },
			{ status: 400 },
		)
	}
	const result = await applyChainDefaultIntent({
		organization: manager.organization,
		userId: manager.userId,
		request,
		body,
	})
	return result.ok
		? data({ ok: true as const, result })
		: data(
				{ ok: false as const, error: result.error },
				{ status: result.status },
			)
}

type Response_ =
	| {
			ok: true
			result: {
				updatedLocationIds: string[]
				overrides: Array<{ locationId: string; name: string }>
			}
	  }
	| { ok: false; error: string }

const FULFILLMENT_KEYS = ['pickup', 'delivery', 'dineIn', 'curbside'] as const

function errorText(
	error: string,
	_: ReturnType<typeof useLingui>['_'],
): string {
	if (error in LOCATION_ERROR_LABELS) return _(LOCATION_ERROR_LABELS[error]!)
	switch (error) {
		case 'invalid_value':
			return _(t`That value is not allowed for this setting.`)
		case 'mixed_currencies':
			return _(
				t`Your locations use different currencies, so one amount cannot be the default. Set it on each location instead.`,
			)
		case 'not_supported':
			return _(t`This setting cannot have a chain default.`)
		case 'no_default':
			return _(t`This setting has no chain default yet.`)
		default:
			return error
	}
}

export default function ChainDefaultsRoute() {
	const { orgSlug, rows, locationCount, locations } =
		useLoaderData<typeof loader>()
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
						<Trans>Chain defaults and locks</Trans>
					</h2>
					<p className="text-muted-foreground text-sm">
						<Trans>
							Set a default once for every location. Lock it so locations cannot
							change it, or leave it open and see which locations override it.
						</Trans>
					</p>
				</div>
			</div>

			<p className="text-muted-foreground text-sm">
				<Trans>
					Changing a default updates the locations that use it. Locations that
					already have a different value keep it and are listed as overrides. A
					locked setting is read-only at every location.
				</Trans>
			</p>

			{locationCount === 0 ? (
				<Alert>
					<AlertDescription>
						<Trans>Add a location first.</Trans>
					</AlertDescription>
				</Alert>
			) : (
				<ul className="grid gap-4">
					{rows.map((row) => (
						<li key={row.settingId}>
							<DefaultCard
								row={row as ChainDefaultRow}
								locationCount={locationCount}
								locations={locations}
							/>
						</li>
					))}
				</ul>
			)}
		</div>
	)
}

function DefaultCard({
	row,
	locationCount,
	locations,
}: {
	row: ChainDefaultRow
	locationCount: number
	locations: Array<{ id: string; name: string }>
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<Response_>()
	const [open, setOpen] = useState(false)
	const [showOverrides, setShowOverrides] = useState(false)
	const settingId = row.settingId as LocationSettingId
	const busy = fetcher.state !== 'idle'
	const failure = fetcher.data && !fetcher.data.ok ? fetcher.data : null

	function send(body: Record<string, unknown>) {
		void fetcher.submit(
			{ payload: JSON.stringify({ settingId, ...body }) },
			{ method: 'POST' },
		)
	}

	return (
		<div
			className="bg-card space-y-3 rounded-md border p-4"
			data-testid={`default-card-${settingId}`}
		>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<h3 className="font-medium">{_(SETTING_LABELS[settingId])}</h3>
					<p className="text-muted-foreground text-sm">
						{_(SETTING_DESCRIPTIONS[settingId])}
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{row.hasDefault ? (
						row.locked ? (
							<Badge>
								<Icon name="lock" className="size-3" />
								<Trans>Locked</Trans>
							</Badge>
						) : (
							<Badge variant="outline">
								<Icon name="unlock" className="size-3" />
								<Trans>Overridable</Trans>
							</Badge>
						)
					) : (
						<Badge variant="outline">
							<Trans>No default</Trans>
						</Badge>
					)}
					<Button size="sm" variant="outline" onClick={() => setOpen(true)}>
						{row.hasDefault ? (
							<Trans>Change</Trans>
						) : (
							<Trans>Set default</Trans>
						)}
					</Button>
				</div>
			</div>

			{row.hasDefault ? (
				<div className="space-y-2 text-sm">
					<p>
						<span className="text-muted-foreground">
							<Trans>Default:</Trans>
						</span>{' '}
						<span className="font-medium wrap-anywhere">{row.defaultText}</span>
					</p>
					{row.locked && row.lockReason ? (
						<p className="text-muted-foreground wrap-anywhere">
							<Trans>Reason shown to locations:</Trans> {row.lockReason}
						</p>
					) : null}
					<p data-testid="inherit-count">
						{plural(row.inheritingCount, {
							one: '# location uses the default',
							other: '# locations use the default',
						})}
						{' · '}
						{plural(row.overrides.length, {
							one: '# override',
							other: '# overrides',
						})}
					</p>
					<div className="flex flex-wrap gap-2">
						<Button
							size="sm"
							variant="outline"
							disabled={busy}
							onClick={() =>
								send({
									intent: 'set-lock',
									locked: !row.locked,
									...(row.locked ? {} : { lockReason: row.lockReason ?? '' }),
								})
							}
						>
							{row.locked ? (
								<>
									<Icon name="unlock" className="size-4" />
									<Trans>Unlock</Trans>
								</>
							) : (
								<>
									<Icon name="lock" className="size-4" />
									<Trans>Lock</Trans>
								</>
							)}
						</Button>
						<Button
							size="sm"
							variant="ghost"
							disabled={busy}
							onClick={() => send({ intent: 'remove-default' })}
						>
							<Trans>Remove default</Trans>
						</Button>
						{row.overrides.length > 0 ? (
							<Button
								size="sm"
								variant="ghost"
								onClick={() => setShowOverrides((value) => !value)}
							>
								{showOverrides ? (
									<Trans>Hide overrides</Trans>
								) : (
									<Trans>Show overrides</Trans>
								)}
							</Button>
						) : null}
					</div>

					{showOverrides && row.overrides.length > 0 ? (
						<div className="space-y-2" data-testid="override-list">
							<ul className="divide-y rounded-md border">
								{row.overrides.map((override) => (
									<li
										key={override.locationId}
										className="flex flex-wrap items-center justify-between gap-2 p-2"
									>
										<span className="wrap-anywhere">
											<span className="font-medium">{override.name}</span>
											{': '}
											{override.value}
										</span>
										<Button
											size="sm"
											variant="ghost"
											disabled={busy}
											onClick={() =>
												send({
													intent: 'reset-overrides',
													locationIds: [override.locationId],
												})
											}
										>
											<Trans>Use default</Trans>
										</Button>
									</li>
								))}
							</ul>
							<Button
								size="sm"
								variant="outline"
								disabled={busy}
								onClick={() =>
									send({
										intent: 'reset-overrides',
										locationIds: row.overrides.map((o) => o.locationId),
									})
								}
							>
								<Trans>Use the default at every location</Trans>
							</Button>
						</div>
					) : null}
				</div>
			) : (
				<p className="text-muted-foreground text-sm">
					<Trans>
						Each of your {locationCount} locations has its own value today.
					</Trans>
				</p>
			)}

			{failure ? (
				<Alert variant="destructive">
					<AlertDescription>{errorText(failure.error, _)}</AlertDescription>
				</Alert>
			) : null}

			{open ? (
				<SetDefaultDialog
					row={row}
					locations={locations}
					onClose={() => setOpen(false)}
				/>
			) : null}
		</div>
	)
}

function SetDefaultDialog({
	row,
	locations,
	onClose,
}: {
	row: ChainDefaultRow
	locations: Array<{ id: string; name: string }>
	onClose: () => void
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<Response_>()
	const settingId = row.settingId as LocationSettingId
	const editor = row.editor
	const [mode, setMode] = useState<'value' | 'location'>(
		editor ? 'value' : 'location',
	)
	const [numberValue, setNumberValue] = useState(
		typeof row.defaultRaw === 'number' ? String(row.defaultRaw) : '',
	)
	const [toggles, setToggles] = useState<Record<string, boolean>>(
		row.defaultRaw && typeof row.defaultRaw === 'object'
			? (row.defaultRaw as Record<string, boolean>)
			: { pickup: true, delivery: false, dineIn: false, curbside: false },
	)
	const [sourceId, setSourceId] = useState(locations[0]?.id ?? '')
	const [locked, setLocked] = useState(row.locked)
	const [reason, setReason] = useState(row.lockReason ?? '')
	const [applyToOverrides, setApplyToOverrides] = useState(false)
	const busy = fetcher.state !== 'idle'
	const result = fetcher.data && fetcher.data.ok ? fetcher.data.result : null
	const failure = fetcher.data && !fetcher.data.ok ? fetcher.data : null

	const ready =
		mode === 'location'
			? sourceId !== ''
			: editor?.kind === 'number'
				? numberValue.trim() !== '' && Number.isFinite(Number(numberValue))
				: true

	function save() {
		const common = {
			settingId,
			locked,
			...(locked && reason.trim() ? { lockReason: reason.trim() } : {}),
			applyToOverrides,
		}
		const body =
			mode === 'location'
				? { intent: 'use-location', sourceId, ...common }
				: {
						intent: 'set-default',
						value:
							editor?.kind === 'number'
								? Number(numberValue)
								: Object.fromEntries(
										FULFILLMENT_KEYS.map((key) => [key, toggles[key] === true]),
									),
						...common,
					}
		void fetcher.submit({ payload: JSON.stringify(body) }, { method: 'POST' })
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{_(SETTING_LABELS[settingId])}</DialogTitle>
					<DialogDescription>
						<Trans>
							Locations that use the current default will switch to the new one.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				{result ? (
					<div className="space-y-2" data-testid="default-saved">
						<Alert>
							<AlertDescription>
								{plural(result.updatedLocationIds.length, {
									one: 'Updated # location.',
									other: 'Updated # locations.',
								})}
							</AlertDescription>
						</Alert>
						{result.overrides.length > 0 ? (
							<p className="text-sm">
								<Trans>Kept as overrides:</Trans>{' '}
								{result.overrides.map((o) => o.name).join(', ')}
							</p>
						) : null}
					</div>
				) : (
					<div className="space-y-4">
						<div className="flex flex-wrap gap-2">
							{editor ? (
								<Button
									type="button"
									size="sm"
									variant={mode === 'value' ? 'default' : 'outline'}
									onClick={() => setMode('value')}
								>
									<Trans>Type a value</Trans>
								</Button>
							) : null}
							<Button
								type="button"
								size="sm"
								variant={mode === 'location' ? 'default' : 'outline'}
								onClick={() => setMode('location')}
							>
								<Trans>Use a location&apos;s value</Trans>
							</Button>
						</div>
						{mode === 'value' && editor?.kind === 'number' ? (
							<TextField
								label={<Trans>Default (minutes)</Trans>}
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
						{mode === 'location' ? (
							<SelectField
								label={<Trans>Take the value from</Trans>}
								options={locations.map((location) => ({
									value: location.id,
									label: location.name,
								}))}
								value={sourceId}
								onValueChange={setSourceId}
							/>
						) : null}

						<label className="flex items-start gap-2 text-sm">
							<Checkbox
								checked={locked}
								onCheckedChange={(value) => setLocked(value === true)}
							/>
							<span>
								<span className="font-medium">
									<Trans>Lock this setting</Trans>
								</span>
								<span className="text-muted-foreground block">
									<Trans>
										Locations cannot change it, and it is read-only in their
										settings.
									</Trans>
								</span>
							</span>
						</label>
						{locked ? (
							<TextField
								label={<Trans>Reason shown to locations (optional)</Trans>}
								maxLength={MAX_LOCK_REASON_LENGTH}
								value={reason}
								onChange={(event) => setReason(event.target.value)}
							/>
						) : null}
						{row.hasDefault ? (
							<label className="flex items-start gap-2 text-sm">
								<Checkbox
									checked={applyToOverrides}
									onCheckedChange={(value) =>
										setApplyToOverrides(value === true)
									}
								/>
								<span>
									<Trans>
										Also change locations that override the current default
									</Trans>
								</span>
							</label>
						) : (
							<p className="text-muted-foreground text-sm">
								<Trans>
									Locations that already have a different value keep it and are
									listed as overrides.
								</Trans>
							</p>
						)}
						{failure ? (
							<Alert variant="destructive">
								<AlertDescription>
									{errorText(failure.error, _)}
								</AlertDescription>
							</Alert>
						) : null}
					</div>
				)}

				<DialogFooter>
					<Button type="button" variant="outline" onClick={onClose}>
						{result ? <Trans>Close</Trans> : <Trans>Cancel</Trans>}
					</Button>
					{result ? null : (
						<Button type="button" disabled={busy || !ready} onClick={save}>
							{busy ? <Spinner /> : null}
							<Trans>Save default</Trans>
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
