import { type I18n } from '@lingui/core'
import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	DEFAULT_TERMINAL_SETTINGS,
	TERMINAL_IDLE_LOCK_SECONDS,
	terminalSettingsSchema,
	type TerminalSettingKey,
	type TerminalSettings,
} from '@repo/common/terminal-profiles'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Input } from '@repo/ui/input'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Switch } from '@repo/ui/switch'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'

export const terminalProfileSchema = z.object({
	id: z.string(),
	name: z.string(),
	settings: terminalSettingsSchema,
	version: z.number(),
	terminalCount: z.number(),
	pendingCodeCount: z.number(),
	updatedAt: z.number(),
})
export type TerminalProfile = z.infer<typeof terminalProfileSchema>
export const terminalProfilesSchema = z.object({
	profiles: z.array(terminalProfileSchema),
})

export type OperatorRequest = (
	path: string,
	init?: RequestInit & { readOnly?: boolean },
) => Promise<unknown>

export type ProfileLocation = { id: string; name: string }

/** Plain words for each setting a profile bundles (also used to list overrides). */
export function terminalSettingLabels(_: I18n['_']) {
	return {
		signInRequired: _(t`Staff PIN sign-in`),
		shiftsRequired: _(t`Cash drawer shifts`),
		dayStartMinutes: _(t`Business day`),
		timeclockEnabled: _(t`Time clock app`),
		reservationsEnabled: _(t`Host stand app`),
		inventoryEnabled: _(t`Stock app`),
		ordersEnabled: _(t`Online orders app`),
		idleLockSeconds: _(t`Lock after`),
		kdsStationId: _(t`Kitchen station`),
		menuColumns: _(t`Menu columns`),
		menuDensity: _(t`Menu tile size`),
		guestDisplayEnabled: _(t`Guest screen`),
		guestDisplayImageUrl: _(t`Guest screen image`),
	} satisfies Record<TerminalSettingKey, string>
}

/** "Set for this terminal" next to a setting that differs from its profile. */
export function OverrideBadge({ overridden }: { overridden: boolean }) {
	if (!overridden) return null
	return (
		<Badge variant="secondary" className="ms-2 align-middle">
			<Trans>Overridden</Trans>
		</Badge>
	)
}

const DAY_START_CHOICES = [0, 60, 120, 180, 240, 300, 360]

function dayStartText(minutes: number) {
	const hours = Math.floor(minutes / 60)
	const mins = minutes % 60
	return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`
}

function lockText(_: I18n['_'], seconds: number) {
	if (seconds === 0) return _(t`Never`)
	if (seconds < 60) return _(t`${seconds} seconds`)
	const minutes = seconds / 60
	return minutes === 1 ? _(t`1 minute`) : _(t`${minutes} minutes`)
}

/** The kitchen stations of a location, for choosing what a Kitchen screen shows. */
export function useKitchenStations(
	request: OperatorRequest,
	locationId: string | null,
) {
	const [stations, setStations] = useState<Array<{ id: string; name: string }>>(
		[],
	)
	useEffect(() => {
		if (!locationId) {
			setStations([])
			return
		}
		let cancelled = false
		void (async () => {
			try {
				const body = z
					.object({
						stations: z.array(z.object({ id: z.string(), name: z.string() })),
					})
					.parse(
						await request(
							`/kds-stations?locationId=${encodeURIComponent(locationId)}`,
						),
					)
				if (!cancelled) setStations(body.stations)
			} catch {
				if (!cancelled) setStations([])
			}
		})()
		return () => {
			cancelled = true
		}
	}, [request, locationId])
	return stations
}

function Row({
	label,
	hint,
	overridden = false,
	children,
}: {
	label: React.ReactNode
	hint?: React.ReactNode
	overridden?: boolean
	children: React.ReactNode
}) {
	return (
		<div className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-2">
			<div className="min-w-0 flex-1">
				<p className="text-sm font-medium">
					{label}
					<OverrideBadge overridden={overridden} />
				</p>
				{hint ? (
					<p className="text-muted-foreground text-xs leading-relaxed">
						{hint}
					</p>
				) : null}
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	)
}

/**
 * Every setting a profile bundles, as one form. Used by the profile editor and,
 * for the settings that have no control elsewhere, on a terminal.
 */
export function TerminalSettingsFields({
	value,
	onChange,
	disabled = false,
	only,
	overridden = [],
	stationLocations,
	request,
	stationLocationId,
	onStationLocationChange,
	commitText = false,
}: {
	value: TerminalSettings
	onChange: (patch: Partial<TerminalSettings>) => void
	disabled?: boolean
	/** Show only these settings (default: all). */
	only?: readonly TerminalSettingKey[]
	overridden?: readonly TerminalSettingKey[]
	/** Locations to read kitchen stations from (a profile has no location of its own). */
	stationLocations: ProfileLocation[]
	request: OperatorRequest
	stationLocationId: string | null
	onStationLocationChange?: (id: string) => void
	/** Send a typed address when the field is left, not on every key (a save per change). */
	commitText?: boolean
}) {
	const { _ } = useLingui()
	const labels = terminalSettingLabels(_)
	const stations = useKitchenStations(request, stationLocationId)
	const shows = (key: TerminalSettingKey) => !only || only.includes(key)
	const over = (key: TerminalSettingKey) => overridden.includes(key)
	const toggle = (key: TerminalSettingKey, hint?: React.ReactNode) => (
		<Row label={labels[key]} hint={hint} overridden={over(key)}>
			<Switch
				checked={Boolean(value[key])}
				disabled={disabled}
				aria-label={labels[key]}
				onCheckedChange={(checked) =>
					onChange({ [key]: checked } as Partial<TerminalSettings>)
				}
			/>
		</Row>
	)
	const stationChoices = stations.some((s) => s.id === value.kdsStationId)
		? stations
		: value.kdsStationId
			? [...stations, { id: value.kdsStationId, name: value.kdsStationId }]
			: stations
	return (
		<div className="flex min-w-0 flex-col divide-y">
			{shows('signInRequired')
				? toggle(
						'signInRequired',
						<Trans>
							Staff sign in with a PIN; orders record who took them.
						</Trans>,
					)
				: null}
			{shows('shiftsRequired')
				? toggle(
						'shiftsRequired',
						<Trans>Sell only inside an open cash drawer shift.</Trans>,
					)
				: null}
			{shows('dayStartMinutes') ? (
				<Row
					label={labels.dayStartMinutes}
					overridden={over('dayStartMinutes')}
				>
					<Select
						value={String(value.dayStartMinutes)}
						onValueChange={(next) =>
							onChange({ dayStartMinutes: Number(next) })
						}
						disabled={disabled}
					>
						<SelectTrigger
							className="h-11 w-fit md:h-8"
							aria-label={labels.dayStartMinutes}
						>
							<SelectValue>{dayStartText(value.dayStartMinutes)}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{(DAY_START_CHOICES.includes(value.dayStartMinutes)
								? DAY_START_CHOICES
								: [...DAY_START_CHOICES, value.dayStartMinutes].sort(
										(a, b) => a - b,
									)
							).map((minutes) => (
								<SelectItem key={minutes} value={String(minutes)}>
									{dayStartText(minutes)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Row>
			) : null}
			{shows('timeclockEnabled') ? toggle('timeclockEnabled') : null}
			{shows('reservationsEnabled') ? toggle('reservationsEnabled') : null}
			{shows('inventoryEnabled') ? toggle('inventoryEnabled') : null}
			{shows('ordersEnabled') ? toggle('ordersEnabled') : null}
			{shows('idleLockSeconds') ? (
				<Row
					label={labels.idleLockSeconds}
					hint={
						<Trans>
							The till locks when nobody has touched it for this long.
						</Trans>
					}
					overridden={over('idleLockSeconds')}
				>
					<Select
						value={String(value.idleLockSeconds)}
						onValueChange={(next) =>
							onChange({ idleLockSeconds: Number(next) })
						}
						disabled={disabled}
					>
						<SelectTrigger
							className="h-11 w-fit md:h-8"
							aria-label={labels.idleLockSeconds}
						>
							<SelectValue>{lockText(_, value.idleLockSeconds)}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{TERMINAL_IDLE_LOCK_SECONDS.map((seconds) => (
								<SelectItem key={seconds} value={String(seconds)}>
									{lockText(_, seconds)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Row>
			) : null}
			{shows('kdsStationId') ? (
				<Row
					label={labels.kdsStationId}
					hint={
						<Trans>
							The Kitchen screen on this terminal shows only this station.
						</Trans>
					}
					overridden={over('kdsStationId')}
				>
					<div className="flex flex-wrap items-center justify-end gap-2">
						{onStationLocationChange && stationLocations.length > 0 ? (
							<Select
								value={stationLocationId ?? ''}
								onValueChange={(id) => id && onStationLocationChange(id)}
								disabled={disabled}
							>
								<SelectTrigger
									className="h-11 w-fit md:h-8"
									aria-label={_(t`Location to read stations from`)}
								>
									<SelectValue>
										{stationLocations.find((l) => l.id === stationLocationId)
											?.name ?? _(t`Choose a location`)}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									{stationLocations.map((location) => (
										<SelectItem key={location.id} value={location.id}>
											{location.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						) : null}
						<Select
							value={value.kdsStationId ?? ''}
							onValueChange={(id) =>
								onChange({ kdsStationId: id === '' ? null : id })
							}
							disabled={disabled}
						>
							<SelectTrigger
								className="h-11 w-fit md:h-8"
								aria-label={labels.kdsStationId}
							>
								<SelectValue>
									{stationChoices.find((s) => s.id === value.kdsStationId)
										?.name ?? _(t`The screen chooses`)}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="">
									<Trans>The screen chooses</Trans>
								</SelectItem>
								{stationChoices.map((station) => (
									<SelectItem key={station.id} value={station.id}>
										{station.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				</Row>
			) : null}
			{shows('menuColumns') ? (
				<Row label={labels.menuColumns} overridden={over('menuColumns')}>
					<Select
						value={String(value.menuColumns)}
						onValueChange={(next) =>
							onChange({
								menuColumns:
									next === 'auto'
										? 'auto'
										: (Number(next) as TerminalSettings['menuColumns']),
							})
						}
						disabled={disabled}
					>
						<SelectTrigger
							className="h-11 w-fit md:h-8"
							aria-label={labels.menuColumns}
						>
							<SelectValue>
								{value.menuColumns === 'auto'
									? _(t`Automatic`)
									: String(value.menuColumns)}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="auto">
								<Trans>Automatic</Trans>
							</SelectItem>
							{[2, 3, 4].map((n) => (
								<SelectItem key={n} value={String(n)}>
									{n}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Row>
			) : null}
			{shows('menuDensity') ? (
				<Row label={labels.menuDensity} overridden={over('menuDensity')}>
					<Select
						value={value.menuDensity}
						onValueChange={(next) =>
							onChange({
								menuDensity: next === 'compact' ? 'compact' : 'comfortable',
							})
						}
						disabled={disabled}
					>
						<SelectTrigger
							className="h-11 w-fit md:h-8"
							aria-label={labels.menuDensity}
						>
							<SelectValue>
								{value.menuDensity === 'compact'
									? _(t`Compact`)
									: _(t`Comfortable`)}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="comfortable">
								<Trans>Comfortable</Trans>
							</SelectItem>
							<SelectItem value="compact">
								<Trans>Compact</Trans>
							</SelectItem>
						</SelectContent>
					</Select>
				</Row>
			) : null}
			{shows('guestDisplayEnabled')
				? toggle(
						'guestDisplayEnabled',
						<Trans>
							Offers a screen for guests that mirrors the order, asks for a tip
							and shows an image between orders.
						</Trans>,
					)
				: null}
			{shows('guestDisplayImageUrl') ? (
				<Row
					label={labels.guestDisplayImageUrl}
					hint={
						<Trans>
							An https address of the picture shown when no order is open.
						</Trans>
					}
					overridden={over('guestDisplayImageUrl')}
				>
					<ImageUrlInput
						value={value.guestDisplayImageUrl}
						disabled={disabled}
						label={labels.guestDisplayImageUrl}
						commitOnBlur={commitText}
						onChange={(next) => onChange({ guestDisplayImageUrl: next })}
					/>
				</Row>
			) : null}
		</div>
	)
}

function ImageUrlInput({
	value,
	disabled,
	label,
	commitOnBlur,
	onChange,
}: {
	value: string | null
	disabled: boolean
	label: string
	commitOnBlur: boolean
	onChange: (next: string | null) => void
}) {
	const [draft, setDraft] = useState(value ?? '')
	useEffect(() => setDraft(value ?? ''), [value])
	const commit = () => {
		const next = draft.trim() || null
		if (next !== value) onChange(next)
	}
	return (
		<Input
			type="url"
			inputMode="url"
			dir="ltr"
			className="w-64 max-w-full"
			value={draft}
			disabled={disabled}
			aria-label={label}
			placeholder="https://"
			onChange={(event) => {
				setDraft(event.target.value)
				if (!commitOnBlur) onChange(event.target.value.trim() || null)
			}}
			onBlur={commitOnBlur ? commit : undefined}
			onKeyDown={(event) => {
				if (commitOnBlur && event.key === 'Enter') commit()
			}}
		/>
	)
}

function errorMessage(error: unknown, fallback: string, _: I18n['_']) {
	if (error instanceof OperatorRequestError) {
		if (error.code === 'name_taken')
			return _(t`A profile with that name already exists.`)
		if (error.code === 'stale_version')
			return _(t`This profile changed elsewhere. Close it and open it again.`)
		if (error.code === 'profile_in_use')
			return _(
				t`This profile is in use. Move its terminals to another profile first.`,
			)
		if (error.code === 'profile_conflict') {
			const list = Array.isArray(error.body?.terminals)
				? (error.body.terminals as Array<{ terminalCode?: string }>)
						.map((terminal) => terminal.terminalCode)
						.filter(Boolean)
						.join(', ')
				: ''
			return _(
				t`Some terminals cannot take this change (${list}). Nothing was changed.`,
			)
		}
		return error.message
	}
	return error instanceof Error ? error.message : fallback
}

function ProfileDialog({
	profile,
	locations,
	request,
	onClose,
	onSaved,
}: {
	/** null: a new profile. */
	profile: TerminalProfile | null
	locations: ProfileLocation[]
	request: OperatorRequest
	onClose: () => void
	onSaved: () => void
}) {
	const { _ } = useLingui()
	const [name, setName] = useState(profile?.name ?? '')
	const [settings, setSettings] = useState<TerminalSettings>(
		profile?.settings ?? DEFAULT_TERMINAL_SETTINGS,
	)
	const [stationLocation, setStationLocation] = useState<string | null>(
		locations[0]?.id ?? null,
	)
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)

	async function save() {
		setSaving(true)
		setError(null)
		try {
			if (profile)
				await request(`/profiles/${encodeURIComponent(profile.id)}`, {
					method: 'PUT',
					body: JSON.stringify({
						name,
						settings,
						expectedVersion: profile.version,
					}),
				})
			else
				await request('/profiles', {
					method: 'POST',
					body: JSON.stringify({ name, settings }),
				})
			toast.success(
				profile && profile.terminalCount > 0
					? _(
							t`Saved. Terminals using this profile update next time they connect.`,
						)
					: _(t`Profile saved.`),
			)
			onSaved()
			onClose()
		} catch (cause) {
			setError(errorMessage(cause, _(t`Could not save the profile.`), _))
		} finally {
			setSaving(false)
		}
	}

	return (
		<Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
			<DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>
						{profile ? (
							<Trans>Edit profile</Trans>
						) : (
							<Trans>New terminal profile</Trans>
						)}
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Terminals on this profile follow these settings. A terminal can
							still override a single one.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<label className="flex flex-col gap-1.5 text-sm font-medium">
						<Trans>Profile name</Trans>
						<Input
							value={name}
							maxLength={60}
							onChange={(event) => setName(event.target.value)}
							placeholder={_(t`Counter tablet`)}
						/>
					</label>
					<TerminalSettingsFields
						value={settings}
						onChange={(patch) => setSettings((s) => ({ ...s, ...patch }))}
						stationLocations={locations}
						request={request}
						stationLocationId={stationLocation}
						onStationLocationChange={setStationLocation}
					/>
					{error ? (
						<p role="alert" className="text-destructive text-sm">
							{error}
						</p>
					) : null}
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={onClose} disabled={saving}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						onClick={() => void save()}
						disabled={saving || name.trim() === ''}
					>
						<Trans>Save profile</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

/** Settings, Terminals: the reusable profiles an owner can put terminals on. */
export function TerminalProfilesPanel({
	canWrite,
	profiles,
	locations,
	request,
	reload,
}: {
	canWrite: boolean
	profiles: TerminalProfile[]
	locations: ProfileLocation[]
	request: OperatorRequest
	reload: () => void
}) {
	const { _ } = useLingui()
	const [editing, setEditing] = useState<TerminalProfile | 'new' | null>(null)

	async function remove(profile: TerminalProfile) {
		try {
			await request(`/profiles/${encodeURIComponent(profile.id)}`, {
				method: 'DELETE',
			})
			const name = profile.name
			toast.success(_(t`${name} was deleted.`))
			reload()
		} catch (cause) {
			toast.error(errorMessage(cause, _(t`Could not delete the profile.`), _))
		}
	}

	return (
		<Card
			role="region"
			aria-label={_(t`Terminal profiles`)}
			className="shadow-none"
		>
			<CardHeader className="gap-2 border-b">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="min-w-0 space-y-1">
						<CardTitle as="h3">
							<Trans>Terminal profiles</Trans>
						</CardTitle>
						<CardDescription className="max-w-prose leading-relaxed">
							<Trans>
								A profile bundles the apps, kitchen station, lock timeout, menu
								layout and guest screen a kind of tablet needs. Change it once
								and every terminal on it follows, except settings you override
								on a single terminal.
							</Trans>
						</CardDescription>
					</div>
					{canWrite ? (
						<Button className="h-11 md:h-9" onClick={() => setEditing('new')}>
							<Trans>New profile</Trans>
						</Button>
					) : null}
				</div>
			</CardHeader>
			<CardContent className="flex min-w-0 flex-col divide-y">
				{profiles.length === 0 ? (
					<p className="text-muted-foreground py-3 text-sm">
						<Trans>No profiles yet.</Trans>
					</p>
				) : (
					profiles.map((profile) => {
						const inUse = profile.terminalCount + profile.pendingCodeCount > 0
						const count = profile.terminalCount
						return (
							<div
								key={profile.id}
								className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-3"
							>
								<div className="min-w-0 flex-1">
									<p className="font-medium wrap-anywhere">{profile.name}</p>
									<p className="text-muted-foreground text-sm">
										{count === 1 ? (
											<Trans>1 terminal</Trans>
										) : (
											<Trans>{count} terminals</Trans>
										)}
									</p>
								</div>
								{canWrite ? (
									<div className="flex items-center gap-2">
										<Button
											variant="outline"
											className="h-11 md:h-8"
											onClick={() => setEditing(profile)}
										>
											<Trans>Edit</Trans>
										</Button>
										<Button
											variant="ghost"
											className="h-11 md:h-8"
											disabled={inUse}
											title={
												inUse
													? _(
															t`In use. Move its terminals to another profile first.`,
														)
													: undefined
											}
											onClick={() => void remove(profile)}
										>
											<Trans>Delete</Trans>
										</Button>
									</div>
								) : null}
							</div>
						)
					})
				)}
			</CardContent>
			{editing ? (
				<ProfileDialog
					key={editing === 'new' ? 'new' : editing.id}
					profile={editing === 'new' ? null : editing}
					locations={locations}
					request={request}
					onClose={() => setEditing(null)}
					onSaved={reload}
				/>
			) : null}
		</Card>
	)
}

/** The six settings a terminal has beyond the controls the card already shows. */
export const TERMINAL_EXTRA_SETTING_KEYS = [
	'idleLockSeconds',
	'kdsStationId',
	'menuColumns',
	'menuDensity',
	'guestDisplayEnabled',
	'guestDisplayImageUrl',
] as const satisfies readonly TerminalSettingKey[]

type TerminalProfileFields = TerminalSettings & {
	id: string
	locationId: string | null
	profileId: string | null
	overrides: TerminalSettingKey[]
}

/**
 * On a terminal: which profile it follows, the settings it overrides (with a
 * way back to the profile's value), and the settings that have no control
 * elsewhere on the card.
 */
export function TerminalProfileSection({
	device,
	profiles,
	canWrite,
	request,
	reload,
}: {
	device: TerminalProfileFields
	profiles: TerminalProfile[]
	canWrite: boolean
	request: OperatorRequest
	reload: () => void
}) {
	const { _ } = useLingui()
	const labels = terminalSettingLabels(_)
	const profile = profiles.find((p) => p.id === device.profileId) ?? null
	const names = profiles.map((p) => ({ id: p.id, name: p.name }))
	const profileName = profile?.name ?? ''

	async function patch(body: Record<string, unknown>) {
		try {
			await request(`/terminals/${encodeURIComponent(device.id)}`, {
				method: 'PATCH',
				body: JSON.stringify(body),
			})
			toast.success(
				_(t`Saved. The terminal updates the next time it connects.`),
			)
			reload()
		} catch (cause) {
			toast.error(errorMessage(cause, _(t`Could not change the setting.`), _))
		}
	}

	return (
		<section
			aria-label={_(t`Profile and display settings`)}
			className="border-border w-full min-w-0 border-t pt-4"
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="min-w-0">
					<p className="text-sm font-medium">
						<Trans>Profile</Trans>
					</p>
					<p className="text-muted-foreground text-xs">
						{profile ? (
							<Trans>
								Follows {profileName}. Change a setting here to override it for
								this terminal only.
							</Trans>
						) : (
							<Trans>Not on a profile. Settings are this terminal's own.</Trans>
						)}
					</p>
				</div>
				{canWrite ? (
					<Select
						value={device.profileId ?? ''}
						onValueChange={(next) =>
							void patch({ profileId: next === '' ? null : next })
						}
					>
						<SelectTrigger
							className="h-11 w-fit max-w-full md:h-8"
							aria-label={_(t`Profile for this terminal`)}
						>
							<SelectValue>
								{names.find((p) => p.id === device.profileId)?.name ??
									_(t`No profile`)}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="">
								<Trans>No profile</Trans>
							</SelectItem>
							{names.map((p) => (
								<SelectItem key={p.id} value={p.id}>
									{p.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				) : (
					<Badge variant="outline">
						{profile?.name ?? <Trans>No profile</Trans>}
					</Badge>
				)}
			</div>
			{profile && device.overrides.length > 0 ? (
				<div
					className="bg-muted/50 mt-3 flex flex-wrap items-center gap-2 rounded-lg p-3 text-sm"
					role="status"
				>
					<span className="font-medium">
						<Trans>Overridden on this terminal:</Trans>
					</span>
					{device.overrides.map((key) => (
						<Badge key={key} variant="secondary">
							{labels[key]}
						</Badge>
					))}
					{canWrite ? (
						<Button
							variant="ghost"
							className="h-11 md:h-8"
							onClick={() => void patch({ resetOverrides: 'all' })}
						>
							<Trans>Use the profile's values</Trans>
						</Button>
					) : null}
				</div>
			) : null}
			<div className="mt-2">
				<TerminalSettingsFields
					value={device}
					only={TERMINAL_EXTRA_SETTING_KEYS}
					overridden={profile ? device.overrides : []}
					disabled={!canWrite}
					stationLocations={[]}
					request={request}
					stationLocationId={device.locationId}
					commitText
					onChange={(change) => void patch(change)}
				/>
			</div>
		</section>
	)
}
