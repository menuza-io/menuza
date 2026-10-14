import { type I18n } from '@lingui/core'
import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { pickLocalized } from '@repo/common/site-locales'
import {
	STAFFING_PERMISSIONS as P,
	type KioskIdentifyMode,
} from '@repo/staffing'
import { cn } from '@repo/ui'
import { Alert, AlertDescription } from '@repo/ui/alert'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@repo/ui/collapsible'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { FieldLabel } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemMedia,
	ItemTitle,
} from '@repo/ui/item'
import { Skeleton } from '@repo/ui/skeleton'
import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	type FormEvent,
} from 'react'
import { toast } from 'sonner'
import { EmptyState } from '#app/components/empty-state.tsx'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import { SwitchField } from '#app/components/staff/switch-field.tsx'
import { useLiveNow, useVisiblePolling } from '#app/hooks/use-live-clock.ts'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { useStaffClient, useStaffQuery } from '#app/hooks/use-staff-client.ts'
import { buildKioskPairingUrl } from '#app/utils/staffing/kiosk-pairing.ts'
import { describeStaffError } from '#app/utils/staffing/staff-errors.ts'
import {
	DEVICE_QUIET_AFTER_MS,
	formatCountdown,
	formatRelativeTime,
} from '#app/utils/staffing/timeclock-format.ts'
import {
	createdPairingCodeSchema,
	kioskDevicesResponseSchema,
	pendingCodesResponseSchema,
	type CreatedPairingCode,
	type KioskDeviceRow,
} from '#app/utils/staffing/timeclock-types.ts'

type ScopeOption = { id: string; name: string; timeZone: string }

/**
 * Tablets: pair a tablet with a one-time code, see when each was last seen, and
 * remove one at once if it goes missing. The code is shown a single time (it is
 * stored only as a hash), so closing the dialog before the tablet pairs means
 * making another.
 */
export function KioskManager({ scopes }: { scopes: readonly ScopeOption[] }) {
	const { _, i18n } = useLingui()
	const { client, can, ready, unavailable } = useStaffClient('timeclock')
	const canWrite = can(P.UPDATE_LABOR_POLICY)
	const [pairing, setPairing] = useState(false)
	const [editing, setEditing] = useState<KioskDeviceRow | null>(null)
	const [removing, setRemoving] = useState<KioskDeviceRow | null>(null)
	const [showRemoved, setShowRemoved] = useState(false)

	const devicesQuery = useStaffQuery(
		client,
		ready ? '/kiosk/devices' : null,
		kioskDevicesResponseSchema,
	)
	const codesQuery = useStaffQuery(
		client,
		ready ? '/kiosk/pairing-codes' : null,
		pendingCodesResponseSchema,
	)
	const reloadAll = useCallback(() => {
		devicesQuery.reload()
		codesQuery.reload()
	}, [devicesQuery, codesQuery])
	// "Last seen" is the point of this screen; keep it honest while it is open.
	useVisiblePolling(devicesQuery.reload, 30_000)
	const now = useLiveNow(30_000)

	const scopeNames = useMemo(
		() =>
			new Map(
				scopes.map((scope) => [
					scope.id,
					pickLocalized(scope.name, i18n.locale, 'en') || scope.name,
				]),
			),
		[scopes, i18n.locale],
	)
	const showScope = scopes.length > 1

	const devices = devicesQuery.data?.devices ?? []
	const active = devices.filter((device) => device.status === 'active')
	const removed = devices.filter((device) => device.status === 'revoked')
	const removedCount = removed.length
	const pending = codesQuery.data?.codes ?? []

	if (unavailable) {
		return (
			<Alert variant="destructive">
				<AlertDescription>
					<Trans>We could not confirm your access. Reload the page.</Trans>
				</AlertDescription>
			</Alert>
		)
	}

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<p className="text-muted-foreground max-w-prose text-sm text-pretty">
					<Trans>
						A tablet at the entrance or the front desk lets people clock in with
						a PIN. Pair it once and it stays signed in until you remove it.
					</Trans>
				</p>
				{canWrite ? (
					<Button
						onClick={() => setPairing(true)}
						disabled={scopes.length === 0}
					>
						<Icon name="plus" />
						<Trans>Pair a tablet</Trans>
					</Button>
				) : null}
			</div>

			{pending.length > 0 ? (
				<section
					aria-labelledby="pending-codes"
					className="flex flex-col gap-2"
				>
					<h2 id="pending-codes" className="text-sm font-medium">
						<Trans>Waiting to be paired</Trans>
					</h2>
					<ItemGroup>
						{pending.map((code) => (
							<PendingCodeRow
								key={code.id}
								name={code.deviceName}
								place={
									showScope ? (scopeNames.get(code.scopeId) ?? null) : null
								}
								expiresAt={code.expiresAt}
								now={now}
								canCancel={canWrite}
								onCancel={async () => {
									try {
										await client.request(`/kiosk/pairing-codes/${code.id}`, {
											method: 'DELETE',
										})
										codesQuery.reload()
									} catch (error) {
										toast.error(describeStaffError(error, _))
									}
								}}
							/>
						))}
					</ItemGroup>
				</section>
			) : null}

			{!ready || devicesQuery.loading ? (
				<div role="status" className="flex flex-col gap-3">
					<span className="sr-only">
						<Trans>Loading tablets</Trans>
					</span>
					<Skeleton className="h-16 w-full" />
					<Skeleton className="h-16 w-full" />
				</div>
			) : devicesQuery.error && !devicesQuery.data ? (
				<Alert variant="destructive">
					<AlertDescription>
						{describeStaffError(devicesQuery.error, _)}
					</AlertDescription>
					<Button
						className="mt-2 justify-self-start"
						variant="outline"
						onClick={reloadAll}
					>
						<Trans>Try again</Trans>
					</Button>
				</Alert>
			) : active.length === 0 ? (
				<EmptyState
					title={
						<>
							<Trans>No tablets paired yet</Trans>
						</>
					}
					description={
						<>
							<Trans>
								Open the pairing page on the tablet, or scan the code with its
								camera. It takes about a minute.
							</Trans>
						</>
					}
					icons={['tablet', 'smartphone', 'clock']}
				>
					{canWrite && scopes.length > 0 ? (
						<>
							<Button onClick={() => setPairing(true)}>
								<Icon name="plus" />
								<Trans>Pair a tablet</Trans>
							</Button>
						</>
					) : null}
				</EmptyState>
			) : (
				<ItemGroup>
					{active.map((device) => (
						<DeviceRow
							key={device.id}
							device={device}
							place={
								showScope ? (scopeNames.get(device.scopeId) ?? null) : null
							}
							now={now}
							locale={i18n.locale}
							canWrite={canWrite}
							onEdit={() => setEditing(device)}
							onRemove={() => setRemoving(device)}
						/>
					))}
				</ItemGroup>
			)}

			{removed.length > 0 ? (
				<Collapsible open={showRemoved} onOpenChange={setShowRemoved}>
					<CollapsibleTrigger
						render={
							<Button
								type="button"
								variant="ghost"
								className="text-muted-foreground"
							/>
						}
					>
						<Icon
							name="chevron-right"
							className={cn(
								'transition-transform motion-reduce:transition-none rtl:-scale-x-100',
								showRemoved && 'rotate-90 rtl:rotate-90',
							)}
						/>
						<Trans>Removed tablets ({removedCount})</Trans>
					</CollapsibleTrigger>
					<CollapsibleContent>
						<ItemGroup className="mt-2 gap-2">
							{removed.map((device) => (
								<Item
									key={device.id}
									variant="muted"
									className="min-h-12 justify-between"
									role="listitem"
								>
									<ItemContent className="min-w-0">
										<span className="truncate">{device.name}</span>
									</ItemContent>
									<ItemActions>
										<span className="text-xs">
											<Trans>Removed</Trans>
										</span>
									</ItemActions>
								</Item>
							))}
						</ItemGroup>
					</CollapsibleContent>
				</Collapsible>
			) : null}

			{pairing ? (
				<PairTabletDialog
					scopes={scopes}
					scopeNames={scopeNames}
					onClose={() => {
						setPairing(false)
						reloadAll()
					}}
					onPaired={reloadAll}
				/>
			) : null}
			{editing ? (
				<EditDeviceDialog
					device={editing}
					onClose={() => setEditing(null)}
					onSaved={() => {
						setEditing(null)
						devicesQuery.reload()
					}}
				/>
			) : null}
			{removing ? (
				<RemoveDeviceDialog
					device={removing}
					onClose={() => setRemoving(null)}
					onRemoved={() => {
						setRemoving(null)
						devicesQuery.reload()
					}}
				/>
			) : null}
		</div>
	)
}

function PendingCodeRow({
	name,
	place,
	expiresAt,
	now,
	canCancel,
	onCancel,
}: {
	name: string
	place: string | null
	expiresAt: number
	now: number
	canCancel: boolean
	onCancel: () => void
}) {
	const left = formatCountdown(expiresAt - now)
	return (
		<Item variant="outline" render={<li />}>
			<div className="flex min-h-12 w-full flex-wrap items-center gap-x-4 gap-y-1">
				<span className="min-w-0 flex-1 truncate text-sm">
					{name}
					{place ? (
						<span className="text-muted-foreground"> · {place}</span>
					) : null}
				</span>
				<span className="text-muted-foreground text-sm tabular-nums">
					<Trans>Expires in {left}</Trans>
				</span>
				{canCancel ? (
					<Button size="sm" type="button" variant="ghost" onClick={onCancel}>
						<Trans>Cancel</Trans>
					</Button>
				) : null}
			</div>
		</Item>
	)
}

function DeviceRow({
	device,
	place,
	now,
	locale,
	canWrite,
	onEdit,
	onRemove,
}: {
	device: KioskDeviceRow
	place: string | null
	now: number
	locale: string
	canWrite: boolean
	onEdit: () => void
	onRemove: () => void
}) {
	const { _ } = useLingui()
	const seen =
		device.lastSeenAt === null
			? null
			: formatRelativeTime(device.lastSeenAt, now, locale)
	const quiet =
		device.lastSeenAt === null ||
		now - device.lastSeenAt > DEVICE_QUIET_AFTER_MS
	const mode =
		device.identifyMode === 'pin' ? _(t`Enter PIN`) : _(t`Pick name, then PIN`)
	return (
		<Item variant="outline" render={<li />}>
			<ItemMedia variant="icon" aria-hidden="true">
				<Icon name="tablet" />
			</ItemMedia>
			<ItemContent>
				<ItemTitle>{device.name}</ItemTitle>
				<ItemDescription>
					{[place, mode].filter(Boolean).join(' · ')}
				</ItemDescription>
			</ItemContent>
			<ItemActions>
				{device.backoffSeconds > 0 ? (
					<Badge variant="secondary">
						<Trans>PIN attempts paused</Trans>
					</Badge>
				) : device.failuresLastHour >= 6 ? (
					<Badge variant="secondary">
						<Trans>Many wrong PINs</Trans>
					</Badge>
				) : null}
				<span
					className={
						quiet
							? 'text-muted-foreground me-2 inline-flex items-center gap-2 text-sm'
							: 'me-2 inline-flex items-center gap-2 text-sm'
					}
				>
					<span
						aria-hidden="true"
						className={
							quiet
								? 'bg-muted-foreground/50 size-1.5 rounded-full'
								: 'bg-primary size-1.5 rounded-full'
						}
					/>
					{seen ? <Trans>Seen {seen}</Trans> : <Trans>Not seen yet</Trans>}
				</span>
				{canWrite ? (
					<>
						<Button type="button" variant="outline" size="sm" onClick={onEdit}>
							<Trans>Edit</Trans>
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="text-destructive"
							onClick={onRemove}
						>
							<Trans>Remove</Trans>
						</Button>
					</>
				) : null}
			</ItemActions>
		</Item>
	)
}

function modeOptions(_: I18n['_']) {
	return [
		{ value: 'pin', label: _(t`Enter PIN`) },
		{ value: 'pick_name', label: _(t`Pick name, then PIN`) },
	]
}

function ModeHint({ mode }: { mode: KioskIdentifyMode }) {
	return mode === 'pin' ? (
		<Trans>
			People type only their PIN. The tablet never shows a list of names.
		</Trans>
	) : (
		<Trans>
			People tap their name, then type their PIN. Names are shown with a last
			initial on the tablet.
		</Trans>
	)
}

// ---------------------------------------------------------------------------
// Pair a tablet
// ---------------------------------------------------------------------------

function PairTabletDialog({
	scopes,
	scopeNames,
	onClose,
	onPaired,
}: {
	scopes: readonly ScopeOption[]
	scopeNames: Map<string, string>
	onClose: () => void
	onPaired: () => void
}) {
	const { _ } = useLingui()
	const { client } = useStaffClient('timeclock')
	const action = useStaffAction()
	const [name, setName] = useState('')
	const [nameError, setNameError] = useState<string | null>(null)
	const [scopeId, setScopeId] = useState(scopes[0]?.id ?? '')
	const [mode, setMode] = useState<KioskIdentifyMode>('pin')
	const [created, setCreated] = useState<CreatedPairingCode | null>(null)
	const [paired, setPaired] = useState(false)

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		setNameError(null)
		if (!name.trim()) {
			setNameError(_(t`Give the tablet a name, like “Front counter”.`))
			return
		}
		const scope = scopes.find((item) => item.id === scopeId)
		if (!scope) return
		const result = await action.run(async () =>
			createdPairingCodeSchema.parse(
				await client.request('/kiosk/pairing-codes', {
					method: 'POST',
					json: {
						scopeId: scope.id,
						deviceName: name.trim(),
						identifyMode: mode,
						showNextShifts: false,
						timeZone: scope.timeZone,
						scopeName: scopeNames.get(scope.id) ?? scope.name,
					},
				}),
			),
		)
		if (result.ok) setCreated(result.value)
	}

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !action.pending) onClose()
			}}
		>
			<DialogContent className="sm:max-w-lg">
				{created ? (
					<PairingCodeStep
						code={created}
						paired={paired}
						onPaired={() => {
							setPaired(true)
							onPaired()
						}}
						onClose={onClose}
					/>
				) : (
					<form
						onSubmit={(event) => void submit(event)}
						noValidate
						className="flex flex-col gap-4"
					>
						<DialogHeader>
							<DialogTitle>
								<Trans>Pair a tablet</Trans>
							</DialogTitle>
							<DialogDescription>
								<Trans>
									Name it so you can tell tablets apart, then open the pairing
									page on it.
								</Trans>
							</DialogDescription>
						</DialogHeader>
						<TextField
							label={<Trans>Tablet name</Trans>}
							value={name}
							onChange={(event) => setName(event.target.value)}
							error={nameError}
							maxLength={60}
							autoFocus
						/>
						{scopes.length > 1 ? (
							<SelectField
								label={<Trans>Workplace</Trans>}
								value={scopeId}
								onValueChange={setScopeId}
								options={scopes.map((scope) => ({
									value: scope.id,
									label: scopeNames.get(scope.id) ?? scope.name,
								}))}
							/>
						) : null}
						<SelectField
							label={<Trans>How people sign in</Trans>}
							value={mode}
							onValueChange={(value) => setMode(value as KioskIdentifyMode)}
							options={modeOptions(_)}
							hint={<ModeHint mode={mode} />}
						/>
						{action.error ? (
							<Alert variant="destructive">
								<AlertDescription>{action.error}</AlertDescription>
							</Alert>
						) : null}
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={onClose}
								disabled={action.pending}
							>
								<Trans>Cancel</Trans>
							</Button>
							<Button type="submit" disabled={action.pending}>
								{action.pending ? (
									<Trans>Creating…</Trans>
								) : (
									<Trans>Create pairing code</Trans>
								)}
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	)
}

function useQrDataUrl(text: string): string | null {
	const [url, setUrl] = useState<string | null>(null)
	useEffect(() => {
		let live = true
		void import('qrcode').then(async (QRCode) => {
			const dataUrl = await QRCode.toDataURL(text, {
				errorCorrectionLevel: 'M',
				margin: 2,
				width: 320,
			})
			if (live) setUrl(dataUrl)
		})
		return () => {
			live = false
		}
	}, [text])
	return url
}

function PairingCodeStep({
	code,
	paired,
	onPaired,
	onClose,
}: {
	code: CreatedPairingCode
	paired: boolean
	onPaired: () => void
	onClose: () => void
}) {
	const { _ } = useLingui()
	const { client } = useStaffClient('timeclock')
	const url = useMemo(
		() => buildKioskPairingUrl(window.location.origin, code.fragment),
		[code.fragment],
	)
	const qr = useQrDataUrl(url)
	const now = useLiveNow(1000)
	const expired = now >= code.expiresAt
	const left = formatCountdown(code.expiresAt - now)
	const pairedName = code.deviceName

	// Watch the pending list: once the code is used it disappears.
	useEffect(() => {
		if (paired || expired) return
		let live = true
		const timer = setInterval(() => {
			client.request('/kiosk/pairing-codes').then(
				(body) => {
					if (!live) return
					const parsed = pendingCodesResponseSchema.safeParse(body)
					if (
						parsed.success &&
						!parsed.data.codes.some((item) => item.id === code.id)
					) {
						onPaired()
					}
				},
				() => undefined,
			)
		}, 3000)
		return () => {
			live = false
			clearInterval(timer)
		}
	}, [client, code.id, paired, expired, onPaired])

	async function copy() {
		try {
			await navigator.clipboard.writeText(url)
			toast.success(_(t`Link copied.`))
		} catch {
			toast.error(_(t`Could not copy. Select the link and copy it.`))
		}
	}

	if (paired) {
		return (
			<div className="flex flex-col gap-4">
				<DialogHeader>
					<DialogTitle>
						<Trans>Tablet paired</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							{pairedName} is ready. People can clock in with their PIN.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<div role="status" className="flex items-center gap-2 text-sm">
					<Icon name="check-circle" className="text-primary" />
					<Trans>Connected</Trans>
				</div>
				<DialogFooter>
					<Button onClick={onClose}>
						<Trans>Done</Trans>
					</Button>
				</DialogFooter>
			</div>
		)
	}

	return (
		<div className="flex flex-col gap-4">
			<DialogHeader>
				<DialogTitle>
					<Trans>Open this on the tablet</Trans>
				</DialogTitle>
				<DialogDescription>
					<Trans>
						Scan the code with the tablet's camera, or open the link below in
						its browser. The code works once.
					</Trans>
				</DialogDescription>
			</DialogHeader>
			<div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
				<div className="border-border bg-background flex size-44 shrink-0 items-center justify-center rounded-lg border p-1">
					{qr && !expired ? (
						<img
							src={qr}
							alt={_(t`QR code that opens the pairing page`)}
							className="size-full"
						/>
					) : (
						<Skeleton className="size-full" />
					)}
				</div>
				<div className="flex min-w-0 flex-1 flex-col gap-3">
					<p className="text-muted-foreground text-sm tabular-nums">
						{expired ? (
							<Trans>This code expired. Make a new one.</Trans>
						) : (
							<Trans>Expires in {left}</Trans>
						)}
					</p>
					<FieldLabel className="flex flex-col gap-1 text-sm">
						<span className="font-medium">
							<Trans>Pairing link</Trans>
						</span>
						<Input
							readOnly
							dir="ltr"
							value={url}
							onFocus={(event) => event.currentTarget.select()}
							className="h-11 text-xs"
						/>
					</FieldLabel>
					<Button
						type="button"
						variant="outline"
						className="h-11 w-fit"
						onClick={() => void copy()}
						disabled={expired}
					>
						<Icon name="copy" />
						<Trans>Copy link</Trans>
					</Button>
				</div>
			</div>
			<p role="status" className="text-muted-foreground text-sm">
				{expired ? null : <Trans>Waiting for the tablet…</Trans>}
			</p>
			<DialogFooter>
				<Button variant="outline" onClick={onClose}>
					{expired ? (
						<Trans>Close</Trans>
					) : (
						<Trans>Close, I'll finish later</Trans>
					)}
				</Button>
			</DialogFooter>
		</div>
	)
}

// ---------------------------------------------------------------------------
// Edit and remove
// ---------------------------------------------------------------------------

function EditDeviceDialog({
	device,
	onClose,
	onSaved,
}: {
	device: KioskDeviceRow
	onClose: () => void
	onSaved: () => void
}) {
	const { _ } = useLingui()
	const { client } = useStaffClient('timeclock')
	const action = useStaffAction()
	const [name, setName] = useState(device.name)
	const [mode, setMode] = useState<KioskIdentifyMode>(device.identifyMode)
	const [nextShifts, setNextShifts] = useState(device.showNextShifts)
	const [nameError, setNameError] = useState<string | null>(null)

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		setNameError(null)
		if (!name.trim()) {
			setNameError(_(t`Give the tablet a name.`))
			return
		}
		const result = await action.run(() =>
			client.request(`/kiosk/devices/${device.id}`, {
				method: 'PATCH',
				json: {
					name: name.trim(),
					identifyMode: mode,
					showNextShifts: nextShifts,
				},
			}),
		)
		if (result.ok) {
			toast.success(_(t`Tablet saved.`))
			onSaved()
		}
	}

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !action.pending) onClose()
			}}
		>
			<DialogContent>
				<form
					onSubmit={(event) => void submit(event)}
					noValidate
					className="flex flex-col gap-4"
				>
					<DialogHeader>
						<DialogTitle>
							<Trans>Edit tablet</Trans>
						</DialogTitle>
						<DialogDescription>
							<Trans>
								Changes reach the tablet the next time it checks in.
							</Trans>
						</DialogDescription>
					</DialogHeader>
					<TextField
						label={<Trans>Tablet name</Trans>}
						value={name}
						onChange={(event) => setName(event.target.value)}
						error={nameError}
						maxLength={60}
						autoFocus
					/>
					<SelectField
						label={<Trans>How people sign in</Trans>}
						value={mode}
						onValueChange={(value) => setMode(value as KioskIdentifyMode)}
						options={modeOptions(_)}
						hint={<ModeHint mode={mode} />}
					/>
					<SwitchField
						label={<Trans>Show upcoming shifts</Trans>}
						description={
							<Trans>
								After someone clocks in, briefly show their next shifts. Only
								works once scheduling is on.
							</Trans>
						}
						checked={nextShifts}
						onCheckedChange={setNextShifts}
					/>
					{action.error ? (
						<Alert variant="destructive">
							<AlertDescription>{action.error}</AlertDescription>
						</Alert>
					) : null}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={onClose}
							disabled={action.pending}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button type="submit" disabled={action.pending}>
							{action.pending ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}

function RemoveDeviceDialog({
	device,
	onClose,
	onRemoved,
}: {
	device: KioskDeviceRow
	onClose: () => void
	onRemoved: () => void
}) {
	const { _ } = useLingui()
	const { client } = useStaffClient('timeclock')
	const action = useStaffAction()
	const deviceName = device.name

	async function remove() {
		const result = await action.run(() =>
			client.request(`/kiosk/devices/${device.id}/revoke`, { method: 'POST' }),
		)
		if (result.ok) {
			toast.success(_(t`${deviceName} was removed.`))
			onRemoved()
		}
	}

	return (
		<AlertDialog
			open
			onOpenChange={(open) => {
				if (!open && !action.pending) onClose()
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						<Trans>Remove {deviceName}?</Trans>
					</AlertDialogTitle>
					<AlertDialogDescription>
						<Trans>
							The tablet stops working right away and people can no longer clock
							in on it. Punches already saved are kept. To use it again, pair it
							again.
						</Trans>
					</AlertDialogDescription>
				</AlertDialogHeader>
				{action.error ? (
					<Alert variant="destructive">
						<AlertDescription>{action.error}</AlertDescription>
					</Alert>
				) : null}
				<AlertDialogFooter>
					<AlertDialogCancel>
						<Trans>Keep it</Trans>
					</AlertDialogCancel>
					<AlertDialogAction
						variant="destructive"
						disabled={action.pending}
						onClick={(event) => {
							event.preventDefault()
							void remove()
						}}
					>
						{action.pending ? <Trans>Removing…</Trans> : <Trans>Remove</Trans>}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
