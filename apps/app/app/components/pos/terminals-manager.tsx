import { type I18n } from '@lingui/core'
import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
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
import { Card, CardContent, CardFooter, CardHeader } from '@repo/ui/card'
import { Checkbox } from '@repo/ui/checkbox'
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
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Skeleton } from '@repo/ui/skeleton'
import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	type FormEvent,
} from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { EmptyState } from '#app/components/empty-state.tsx'
import {
	OperatorRequestError,
	useOperatorClient,
} from '#app/hooks/use-operator-client.ts'
import { buildPosPairingUrl } from '#app/utils/pos/pairing.ts'

const terminalSchema = z.object({
	id: z.string(),
	label: z.string(),
	terminalCode: z.string(),
	locationId: z.string().nullable(),
	scopeId: z.string().default('main'),
	// Older servers do not send it: treat as off.
	signInRequired: z.boolean().default(false),
	// Minutes after midnight when the business day turns over. Older servers: 04:00.
	dayStartMinutes: z.number().default(240),
	// Sells only inside a cash drawer shift. Older servers: off.
	shiftsRequired: z.boolean().default(false),
	// Station apps beside the till. Older servers: off.
	timeclockEnabled: z.boolean().default(false),
	reservationsEnabled: z.boolean().default(false),
	pairedAt: z.number(),
	lastSeenAt: z.number().nullable(),
	revokedAt: z.number().nullable(),
})
const pendingSchema = z.object({
	id: z.string(),
	label: z.string(),
	terminalCode: z.string(),
	expiresAt: z.number(),
})
const staffSchema = z.object({
	id: z.string(),
	name: z.string(),
	hasPin: z.boolean(),
	isManager: z.boolean(),
	// The host roster (Station host stand). Older servers: not sent.
	isHost: z.boolean().default(false),
	hostGuestDetails: z.boolean().default(false),
})
type StaffRow = z.infer<typeof staffSchema>
const listSchema = z.object({
	devices: z.array(terminalSchema),
	pendingCodes: z.array(pendingSchema),
	heldUploads: z.number().default(0),
})
const heldSchema = z.object({
	id: z.string(),
	terminalLabel: z.string().nullable(),
	terminalCode: z.string().nullable(),
	orderId: z.string().nullable(),
	error: z.string(),
	message: z.string().nullable(),
	receivedAt: z.number(),
})
type Held = z.infer<typeof heldSchema>

/** When a terminal's business day can turn over: midnight to 06:00, on the hour. */
const DAY_START_CHOICES = [0, 60, 120, 180, 240, 300, 360]
const createdSchema = z.object({
	id: z.string(),
	code: z.string(),
	expiresAt: z.number(),
	terminalCode: z.string(),
})
type Terminal = z.infer<typeof terminalSchema>
type Created = z.infer<typeof createdSchema> & { label: string }

const QUIET_AFTER_MS = 10 * 60 * 1000

/** Walk-in POS terminals: pair a tablet or phone, see when each last sent an order, remove one that is lost. */
/** The Station apps a terminal can offer, as the organization has them switched on. */
export type StationFeatures = { timeclock: boolean; reservations: boolean }
/** What this member may switch on: each app, guest details for hosts, and where. */
export type StationGrants = StationFeatures & {
	guestDetails: boolean
	/** Locations whose host stand this member may open; null is all of them. */
	locationIds: string[] | null
	/** Workplaces where this member may switch the time clock on; null is all of them. */
	scopeIds: string[] | null
}
const NO_GRANTS: StationGrants = {
	timeclock: false,
	reservations: false,
	guestDetails: false,
	locationIds: [],
	scopeIds: [],
}
export type TerminalLocation = { id: string; name: string }

export function TerminalsManager({
	orgSlug,
	canWrite,
	posUrl,
	appUrl,
	locations = [],
	stationFeatures = { timeclock: false, reservations: false },
	stationGrants = NO_GRANTS,
}: {
	orgSlug: string
	canWrite: boolean
	posUrl: string
	appUrl: string
	locations?: TerminalLocation[]
	stationFeatures?: StationFeatures
	/** Whether this member may switch each Station app on. */
	stationGrants?: StationGrants
}) {
	const { _ } = useLingui()
	const { request, tenantApiUrl } = useOperatorClient(orgSlug, '/operator/pos')
	const [state, setState] = useState<
		| { status: 'loading' }
		| { status: 'error'; message: string }
		| { status: 'ready'; data: z.infer<typeof listSchema> }
	>({ status: 'loading' })
	const [staff, setStaff] = useState<StaffRow[]>([])
	const [pairing, setPairing] = useState(false)
	const [removing, setRemoving] = useState<Terminal | null>(null)
	const [showRemoved, setShowRemoved] = useState(false)
	const [held, setHeld] = useState<Held[]>([])

	const load = useCallback(async () => {
		try {
			const parsed = listSchema.parse(await request('/terminals'))
			setState({ status: 'ready', data: parsed })
			// Uploads the server kept for a person to settle (only fetched when there are some).
			if (parsed.heldUploads > 0) {
				try {
					setHeld(
						z
							.object({ held: z.array(heldSchema) })
							.parse(await request('/held')).held,
					)
				} catch {
					setHeld([])
				}
			} else setHeld([])
			// The roster comes from the staff module; if it is off or empty the page still works.
			try {
				const roster = z
					.object({ staff: z.array(staffSchema) })
					.parse(await request('/staff?scope=all'))
				setStaff(roster.staff)
			} catch {
				setStaff([])
			}
		} catch (error) {
			setState({
				status: 'error',
				message:
					error instanceof Error
						? error.message
						: _(t`Could not load terminals.`),
			})
		}
	}, [request, _])

	useEffect(() => {
		void load()
		// "Last seen" is the point of this screen; keep it honest while it is open.
		const timer = setInterval(() => void load(), 30_000)
		return () => clearInterval(timer)
	}, [load])

	const active =
		state.status === 'ready'
			? state.data.devices.filter((d) => d.revokedAt === null)
			: []
	const removed =
		state.status === 'ready'
			? state.data.devices.filter((d) => d.revokedAt !== null)
			: []
	const pending = state.status === 'ready' ? state.data.pendingCodes : []
	const removedCount = removed.length
	const removingLabel = removing?.label ?? ''

	async function remove(device: Terminal) {
		try {
			await request(`/terminals/${encodeURIComponent(device.id)}`, {
				method: 'DELETE',
			})
			const label = device.label
			toast.success(_(t`${label} was removed.`))
			setRemoving(null)
			await load()
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: _(t`Could not remove the terminal.`),
			)
		}
	}

	async function setSignIn(device: Terminal, signInRequired: boolean) {
		try {
			await request(`/terminals/${encodeURIComponent(device.id)}`, {
				method: 'PATCH',
				body: JSON.stringify({ signInRequired }),
			})
			toast.success(
				signInRequired
					? _(
							t`PIN sign-in is on. The terminal updates the next time it connects.`,
						)
					: _(
							t`PIN sign-in is off. The terminal updates the next time it connects.`,
						),
			)
			await load()
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: _(t`Could not change the setting.`),
			)
		}
	}

	async function setShifts(device: Terminal, shiftsRequired: boolean) {
		try {
			await request(`/terminals/${encodeURIComponent(device.id)}`, {
				method: 'PATCH',
				body: JSON.stringify({ shiftsRequired }),
			})
			toast.success(
				_(t`Saved. The terminal updates the next time it connects.`),
			)
			await load()
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: _(t`Could not change the setting.`),
			)
		}
	}

	async function setStationApp(device: Terminal, patch: StationAppPatch) {
		try {
			await request(`/terminals/${encodeURIComponent(device.id)}`, {
				method: 'PATCH',
				body: JSON.stringify(patch),
			})
			toast.success(
				_(t`Saved. The terminal updates the next time it connects.`),
			)
			await load()
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: _(t`Could not change the setting.`),
			)
		}
	}

	async function setDayStart(device: Terminal, dayStartMinutes: number) {
		try {
			await request(`/terminals/${encodeURIComponent(device.id)}`, {
				method: 'PATCH',
				body: JSON.stringify({ dayStartMinutes }),
			})
			toast.success(
				_(t`Saved. The terminal updates the next time it connects.`),
			)
			await load()
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: _(t`Could not change the setting.`),
			)
		}
	}

	async function settleHeld(item: Held) {
		try {
			await request(`/held/${encodeURIComponent(item.id)}/resolve`, {
				method: 'POST',
			})
			await load()
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: _(t`Could not mark it settled.`),
			)
		}
	}

	async function setManagerFlag(person: StaffRow, isManager: boolean) {
		try {
			await request(`/managers/${encodeURIComponent(person.id)}`, {
				method: isManager ? 'PUT' : 'DELETE',
			})
			await load()
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: _(t`Could not change who can manage terminals.`),
			)
		}
	}

	async function setHostRole(
		person: StaffRow,
		role: 'none' | 'host' | 'guest_details',
	) {
		try {
			await request(`/hosts/${encodeURIComponent(person.id)}`, {
				method: role === 'none' ? 'DELETE' : 'PUT',
				...(role === 'none'
					? {}
					: {
							body: JSON.stringify({
								guestDetails: role === 'guest_details',
							}),
						}),
			})
			await load()
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: _(t`Could not change who runs the host stand.`),
			)
		}
	}

	async function cancelCode(id: string) {
		try {
			await request(`/pairing-codes/${encodeURIComponent(id)}`, {
				method: 'DELETE',
			})
			await load()
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: _(t`Could not cancel the code.`),
			)
		}
	}

	return (
		<div className="flex min-w-0 flex-col gap-6">
			<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
				<div className="max-w-prose min-w-0 space-y-2">
					<h2 className="text-xl font-semibold tracking-tight">
						<Trans>Station terminals</Trans>
					</h2>
					<p className="text-muted-foreground text-sm leading-relaxed">
						<Trans>
							Terminals take walk-in orders in the restaurant, even without
							internet, and send them here when they reconnect. Pair a tablet or
							a waiter's phone with a one-time code.
						</Trans>
					</p>
				</div>
				{canWrite ? (
					<Button
						className="h-11 self-start sm:mt-1 md:h-9"
						onClick={() => setPairing(true)}
					>
						<Icon name="plus" />
						<Trans>Pair a terminal</Trans>
					</Button>
				) : null}
			</div>

			{state.status === 'loading' ? (
				<div className="flex flex-col gap-2" aria-busy="true">
					<Skeleton className="h-16 w-full" />
					<Skeleton className="h-16 w-full" />
				</div>
			) : null}

			{state.status === 'error' ? (
				<Alert variant="destructive">
					<AlertDescription>
						<div className="flex flex-wrap items-center justify-between gap-3">
							<span>{state.message}</span>
							<Button variant="outline" size="sm" onClick={() => void load()}>
								<Trans>Try again</Trans>
							</Button>
						</div>
					</AlertDescription>
				</Alert>
			) : null}

			{state.status === 'ready' &&
			active.length === 0 &&
			pending.length === 0 ? (
				<EmptyState
					icons={['tablet']}
					title={<Trans>No terminals yet</Trans>}
					description={
						<Trans>
							Pair your first terminal to start taking walk-in orders.
						</Trans>
					}
				/>
			) : null}

			{active.length > 0 ? (
				<ul className="flex flex-col gap-4" aria-label={_(t`Paired terminals`)}>
					{active.map((device) => (
						<li key={device.id} className="min-w-0">
							<Card className="shadow-none">
								<CardHeader>
									<div className="flex items-start gap-3">
										<div className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-lg">
											<Icon name="tablet" className="size-5" />
										</div>
										<div className="min-w-0 flex-1 space-y-1">
											<div className="flex flex-wrap items-center gap-2">
												<h3 className="font-semibold wrap-anywhere">
													{device.label}
												</h3>
												<Badge
													variant="outline"
													className="tabular-nums"
													dir="ltr"
												>
													{device.terminalCode}
												</Badge>
											</div>
											<p className="text-muted-foreground text-sm">
												<LastSeen at={device.lastSeenAt} />
											</p>
										</div>
										{canWrite ? (
											<Button
												variant="ghost"
												className="h-11 md:h-8"
												onClick={() => setRemoving(device)}
												aria-label={removeLabel(_, device.label)}
											>
												<Trans>Remove</Trans>
											</Button>
										) : null}
									</div>
								</CardHeader>
								<CardFooter className="@container flex-col items-stretch gap-4">
									<div className="grid w-full min-w-0 gap-4 @lg:grid-cols-3 @lg:gap-6">
										<div className="flex min-w-0 items-center justify-between gap-3 @lg:flex-col @lg:items-start @lg:gap-2">
											<span className="text-muted-foreground text-xs font-medium">
												<Trans>Require a staff PIN</Trans>
											</span>
											{canWrite ? (
												<Button
													variant={
														device.signInRequired ? 'secondary' : 'outline'
													}
													className="h-11 md:h-8"
													onClick={() =>
														void setSignIn(device, !device.signInRequired)
													}
													aria-label={signInLabel(
														_,
														device.label,
														device.signInRequired,
													)}
													aria-pressed={device.signInRequired}
												>
													{device.signInRequired ? <Icon name="check" /> : null}
													{device.signInRequired ? (
														<Trans>PIN sign-in on</Trans>
													) : (
														<Trans>PIN sign-in off</Trans>
													)}
												</Button>
											) : (
												<Badge
													variant={
														device.signInRequired ? 'secondary' : 'outline'
													}
												>
													{device.signInRequired ? (
														<Trans>PIN sign-in on</Trans>
													) : (
														<Trans>PIN sign-in off</Trans>
													)}
												</Badge>
											)}
										</div>
										<div className="flex min-w-0 items-center justify-between gap-3 @lg:flex-col @lg:items-start @lg:gap-2">
											<span className="text-muted-foreground text-xs font-medium">
												<Trans>Cash drawer shifts</Trans>
											</span>
											{canWrite ? (
												<Button
													variant={
														device.shiftsRequired ? 'secondary' : 'outline'
													}
													className="h-11 md:h-8"
													onClick={() =>
														void setShifts(device, !device.shiftsRequired)
													}
													aria-label={shiftsLabel(
														_,
														device.label,
														device.shiftsRequired,
													)}
													aria-pressed={device.shiftsRequired}
												>
													{device.shiftsRequired ? <Icon name="check" /> : null}
													{device.shiftsRequired ? (
														<Trans>Shifts required</Trans>
													) : (
														<Trans>Require shifts</Trans>
													)}
												</Button>
											) : (
												<Badge variant="outline">
													{device.shiftsRequired ? (
														<Trans>Shifts required</Trans>
													) : (
														<Trans>Not required</Trans>
													)}
												</Badge>
											)}
										</div>
										<div className="flex min-w-0 items-center justify-between gap-3 @lg:flex-col @lg:items-start @lg:gap-2">
											<span className="text-muted-foreground text-xs font-medium">
												<Trans>Business day</Trans>
											</span>
											{canWrite ? (
												<DayStartSelect
													value={device.dayStartMinutes}
													label={dayStartLabel(_, device.label)}
													onChange={(minutes) =>
														void setDayStart(device, minutes)
													}
												/>
											) : (
												<Badge variant="outline">
													<DayEnds minutes={device.dayStartMinutes} />
												</Badge>
											)}
										</div>
									</div>
									<StationApps
										device={device}
										canWrite={canWrite}
										features={stationFeatures}
										grants={stationGrants}
										locations={locations}
										locationName={
											locations.find((l) => l.id === device.locationId)?.name ??
											null
										}
										onChange={(patch) => void setStationApp(device, patch)}
									/>
								</CardFooter>
							</Card>
						</li>
					))}
				</ul>
			) : null}

			{held.length > 0 ? (
				<section
					aria-label={_(t`Sales held for review`)}
					className="flex flex-col gap-2"
				>
					<h3 className="text-sm font-medium">
						<Trans>Sales held for review</Trans>
					</h3>
					<p className="text-muted-foreground text-sm">
						<Trans>
							A terminal sent something the server could not apply, such as a
							change to a closed bill or an order from an out-of-date terminal.
							Nothing was lost: check it against the terminal, enter it by hand
							if needed, then mark it settled.
						</Trans>
					</p>
					<ul className="flex flex-col gap-2">
						{held.map((item) => (
							<li
								key={item.id}
								className="border-border flex flex-wrap items-center gap-3 rounded-lg border border-dashed p-3 text-sm"
							>
								<div className="min-w-0 flex-1">
									<p className="font-medium">
										{item.terminalLabel ?? <Trans>Unknown terminal</Trans>}
										{item.terminalCode ? ` (${item.terminalCode})` : ''}
									</p>
									<p className="text-muted-foreground">
										<HeldReason code={item.error} /> ·{' '}
										<span dir="ltr">
											{new Date(item.receivedAt).toLocaleString()}
										</span>
									</p>
								</div>
								{canWrite ? (
									<Button
										variant="outline"
										className="h-11 md:h-8"
										onClick={() => void settleHeld(item)}
									>
										<Trans>Mark settled</Trans>
									</Button>
								) : null}
							</li>
						))}
					</ul>
				</section>
			) : null}

			{pending.length > 0 ? (
				<section
					aria-label={_(t`Waiting to be paired`)}
					className="flex flex-col gap-2"
				>
					<h3 className="text-sm font-medium">
						<Trans>Waiting to be paired</Trans>
					</h3>
					<ul className="flex flex-col gap-2">
						{pending.map((code) => (
							<li
								key={code.id}
								className="border-border flex flex-wrap items-center gap-3 rounded-lg border border-dashed p-3 text-sm"
							>
								<span className="min-w-0 flex-1 truncate">{code.label}</span>
								<Badge variant="outline" className="tabular-nums">
									{code.terminalCode}
								</Badge>
								{canWrite ? (
									<Button
										variant="ghost"
										className="h-11 md:h-8"
										onClick={() => void cancelCode(code.id)}
									>
										<Trans>Cancel</Trans>
									</Button>
								) : null}
							</li>
						))}
					</ul>
				</section>
			) : null}

			{staff.length > 0 ? (
				<Card
					role="region"
					aria-label={_(t`Who can manage terminals`)}
					className="shadow-none"
				>
					<CardHeader>
						<h3 className="font-semibold">
							<Trans>Who can manage terminals</Trans>
						</h3>
						<p className="text-muted-foreground max-w-prose text-sm leading-relaxed">
							<Trans>
								Everyone with a PIN can take orders and use the time clock.
								Managers can also change a terminal's settings. The host stand
								is for the people you choose here. Set a person's PIN under
								Staff.
							</Trans>
						</p>
					</CardHeader>
					<CardContent>
						<ul className="divide-border divide-y">
							{staff.map((person) => (
								<li
									key={person.id}
									className="flex flex-wrap items-center gap-3 py-3 text-sm first:pt-0 last:pb-0"
								>
									<span className="min-w-0 flex-1 font-medium wrap-anywhere">
										{person.name}
									</span>
									{!person.hasPin ? (
										<Badge variant="outline">
											<Trans>No PIN yet</Trans>
										</Badge>
									) : null}
									{person.isManager ? (
										<Badge variant="secondary">
											<Trans>Manager</Trans>
										</Badge>
									) : null}
									{canWrite ? (
										<Button
											variant="outline"
											className="h-11 md:h-8"
											onClick={() =>
												void setManagerFlag(person, !person.isManager)
											}
											aria-label={managerLabel(
												_,
												person.name,
												person.isManager,
											)}
										>
											{person.isManager ? (
												<Trans>Remove manager</Trans>
											) : (
												<Trans>Make manager</Trans>
											)}
										</Button>
									) : null}
									{stationFeatures.reservations ? (
										<HostRoleSelect
											person={person}
											// The roster is organization-wide: changing it needs every location.
											canChange={
												canWrite &&
												stationGrants.reservations &&
												stationGrants.locationIds === null
											}
											canGrantGuestDetails={stationGrants.guestDetails}
											onChange={(role) => void setHostRole(person, role)}
										/>
									) : null}
								</li>
							))}
						</ul>
					</CardContent>
				</Card>
			) : null}

			{removed.length > 0 ? (
				<section className="flex flex-col gap-2">
					<Button
						variant="link"
						className="w-fit px-0"
						aria-expanded={showRemoved}
						onClick={() => setShowRemoved((v) => !v)}
					>
						{showRemoved ? (
							<Trans>Hide removed terminals</Trans>
						) : (
							<Trans>Show {removedCount} removed</Trans>
						)}
					</Button>
					{showRemoved ? (
						<ul className="flex flex-col gap-1 text-sm">
							{removed.map((device) => (
								<li
									key={device.id}
									className="text-muted-foreground flex items-center gap-2"
								>
									<span>{device.label}</span>
									<Badge variant="outline">{device.terminalCode}</Badge>
								</li>
							))}
						</ul>
					) : null}
				</section>
			) : null}

			<PairDialog
				open={pairing}
				onClose={() => {
					setPairing(false)
					void load()
				}}
				request={request}
				tenantApiUrl={tenantApiUrl}
				posUrl={posUrl}
				appUrl={appUrl}
				orgSlug={orgSlug}
				locations={locations}
				stationFeatures={{
					timeclock: stationFeatures.timeclock && stationGrants.timeclock,
					reservations:
						stationFeatures.reservations && stationGrants.reservations,
				}}
				hostLocationIds={stationGrants.locationIds}
				clockScopeIds={stationGrants.scopeIds}
				suggestedCode={suggestCode(
					state.status === 'ready' ? state.data.devices : [],
					pending,
				)}
			/>

			<AlertDialog
				open={removing !== null}
				onOpenChange={(open) => !open && setRemoving(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Remove this terminal?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								{removingLabel} will stop sending orders at once. Orders it has
								already saved stay on that device and send after it is paired
								again. Nothing already received is deleted.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Keep it</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => removing && void remove(removing)}
						>
							<Trans>Remove terminal</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}

function signInLabel(_: I18n['_'], label: string, on: boolean): string {
	return on
		? _(t`Turn off PIN sign-in for ${label}`)
		: _(t`Turn on PIN sign-in for ${label}`)
}

function managerLabel(_: I18n['_'], name: string, isManager: boolean): string {
	return isManager
		? _(t`Remove ${name} as manager`)
		: _(t`Make ${name} a manager`)
}

function removeLabel(_: I18n['_'], label: string): string {
	return _(t`Remove ${label}`)
}

function shiftsLabel(_: I18n['_'], label: string, on: boolean): string {
	return on
		? _(t`Stop requiring cash drawer shifts on ${label}`)
		: _(t`Require a cash drawer shift before ${label} sells`)
}

function dayStartLabel(_: I18n['_'], label: string): string {
	return _(t`When the business day ends for ${label}`)
}

/** "Day ends 04:00", in the viewer's locale. */
function DayEnds({ minutes }: { minutes: number }) {
	const { i18n } = useLingui()
	const time = new Intl.DateTimeFormat(i18n.locale, {
		hour: 'numeric',
		minute: '2-digit',
		timeZone: 'UTC',
	}).format(
		new Date(Date.UTC(2000, 0, 1, Math.floor(minutes / 60), minutes % 60)),
	)
	return <Trans>Day ends {time}</Trans>
}

/**
 * Orders after midnight belong to the previous business day until this time,
 * so a late service keeps one run of order numbers and one day's takings.
 */
const NO_LOCATION = '__any__'

/**
 * Time clock and host stand on one terminal. The host stand shows guests to
 * whoever holds the tablet, so it needs a location and a staff PIN; the server
 * refuses otherwise, and the switch says why before anyone taps it.
 */
/**
 * Who runs the host stand at a till, and who among them also sees guests' full
 * contact details, allergies and notes. Reservation settings decide it.
 */
function HostRoleSelect({
	person,
	canChange,
	canGrantGuestDetails,
	onChange,
}: {
	person: StaffRow
	canChange: boolean
	/** Guest details need the guest permission; taking them away never does. */
	canGrantGuestDetails: boolean
	onChange: (role: 'none' | 'host' | 'guest_details') => void
}) {
	const { _ } = useLingui()
	const role = !person.isHost
		? 'none'
		: person.hostGuestDetails
			? 'guest_details'
			: 'host'
	const labels = {
		none: _(t`No host stand`),
		host: _(t`Host stand`),
		guest_details: _(t`Host stand with guest details`),
	} as const
	if (!canChange)
		return role === 'none' ? null : (
			<Badge variant="secondary">{labels[role]}</Badge>
		)
	const name = person.name
	return (
		<Select
			value={role}
			onValueChange={(next) =>
				next && onChange(next as 'none' | 'host' | 'guest_details')
			}
		>
			<SelectTrigger
				className="h-11 w-fit max-w-full md:h-8"
				aria-label={_(t`Host stand for ${name}`)}
			>
				<SelectValue>{labels[role]}</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{(['none', 'host', 'guest_details'] as const).map((value) => (
					<SelectItem
						key={value}
						value={value}
						disabled={
							value === 'guest_details' &&
							role !== 'guest_details' &&
							!canGrantGuestDetails
						}
					>
						{labels[value]}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)
}

function StationApps({
	device,
	canWrite,
	features,
	grants,
	locations,
	locationName,
	onChange,
}: {
	device: Terminal
	canWrite: boolean
	features: StationFeatures
	/** Whether this member may switch each app on (its module's settings permission). */
	grants: StationGrants
	locations: TerminalLocation[]
	locationName: string | null
	onChange: (patch: StationAppPatch) => void
}) {
	const { _ } = useLingui()
	const label = device.label
	if (!features.timeclock && !features.reservations) return null
	// Where staff work by location, the clock needs the terminal's own (its workplace).
	const timeclockBlocked =
		!device.locationId && locations.length > 0
			? _(t`Choose the terminal's location to use the time clock.`)
			: grants.scopeIds !== null && !grants.scopeIds.includes(device.scopeId)
				? _(t`You can turn on the time clock only at your own locations.`)
				: null
	const reservationsBlocked = !device.locationId
		? _(t`Choose the terminal's location to use reservations.`)
		: !device.signInRequired
			? _(t`Turn on the staff PIN to use reservations.`)
			: grants.locationIds !== null &&
				  !grants.locationIds.includes(device.locationId)
				? _(t`You can open the host stand only at your own locations.`)
				: null
	const toggle = (
		on: boolean,
		label: string,
		onLabel: React.ReactNode,
		offLabel: React.ReactNode,
		run: () => void,
		/** Switching on is not possible (switching off always is). */
		cannotTurnOn: boolean,
	) =>
		canWrite ? (
			<Button
				variant={on ? 'secondary' : 'outline'}
				className="h-11 md:h-8"
				onClick={run}
				disabled={!on && cannotTurnOn}
				aria-label={label}
				aria-pressed={on}
			>
				{on ? <Icon name="check" /> : null}
				{on ? onLabel : offLabel}
			</Button>
		) : (
			<Badge variant={on ? 'secondary' : 'outline'}>
				{on ? onLabel : offLabel}
			</Badge>
		)
	return (
		<div className="border-border flex w-full min-w-0 flex-col gap-3 border-t pt-4">
			<span className="text-muted-foreground text-xs font-medium">
				<Trans>Station apps</Trans>
			</span>
			<div className="flex flex-wrap items-center gap-2">
				{features.timeclock
					? toggle(
							device.timeclockEnabled,
							device.timeclockEnabled
								? _(t`Time clock on ${label}, on`)
								: _(t`Time clock on ${label}, off`),
							<Trans>Time clock on</Trans>,
							<Trans>Time clock off</Trans>,
							() => onChange({ timeclockEnabled: !device.timeclockEnabled }),
							!grants.timeclock || timeclockBlocked !== null,
						)
					: null}
				{features.reservations
					? toggle(
							device.reservationsEnabled,
							device.reservationsEnabled
								? _(t`Reservations on ${label}, on`)
								: _(t`Reservations on ${label}, off`),
							<Trans>Reservations on</Trans>,
							<Trans>Reservations off</Trans>,
							() =>
								onChange({ reservationsEnabled: !device.reservationsEnabled }),
							!grants.reservations || reservationsBlocked !== null,
						)
					: null}
				{features.reservations && locationName ? (
					<span className="text-muted-foreground text-sm">
						<Trans>Host stand for {locationName}</Trans>
					</span>
				) : null}
				{(features.reservations || features.timeclock) &&
				canWrite &&
				!device.locationId &&
				locations.length > 0 ? (
					<Select
						value=""
						onValueChange={(next) => next && onChange({ locationId: next })}
					>
						<SelectTrigger
							className="h-11 w-fit max-w-full md:h-8"
							aria-label={_(t`Location of ${label}`)}
						>
							<SelectValue>
								<Trans>Choose a location</Trans>
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{locations.map((location) => (
								<SelectItem key={location.id} value={location.id}>
									{location.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				) : null}
			</div>
			{features.timeclock &&
			grants.timeclock &&
			!device.timeclockEnabled &&
			timeclockBlocked ? (
				<p className="text-muted-foreground text-sm">{timeclockBlocked}</p>
			) : null}
			{features.reservations &&
			!device.reservationsEnabled &&
			reservationsBlocked ? (
				<p className="text-muted-foreground text-sm">{reservationsBlocked}</p>
			) : null}
			{canWrite &&
			((features.timeclock && !grants.timeclock && !device.timeclockEnabled) ||
				(features.reservations &&
					!grants.reservations &&
					!device.reservationsEnabled)) ? (
				<p className="text-muted-foreground text-sm">
					<Trans>
						Turning an app on needs permission to change its settings (time
						clock rules, or reservation settings).
					</Trans>
				</p>
			) : null}
		</div>
	)
}

type StationAppPatch =
	| { timeclockEnabled: boolean }
	| { reservationsEnabled: boolean }
	| { locationId: string }

function DayStartSelect({
	value,
	label,
	onChange,
}: {
	value: number
	label: string
	onChange: (minutes: number) => void
}) {
	const choices = DAY_START_CHOICES.includes(value)
		? DAY_START_CHOICES
		: [...DAY_START_CHOICES, value].sort((a, b) => a - b)
	return (
		<Select
			value={String(value)}
			onValueChange={(next) => onChange(Number(next))}
		>
			<SelectTrigger
				className="h-11 w-fit max-w-full md:h-8"
				aria-label={label}
			>
				<SelectValue>
					<DayEnds minutes={value} />
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{choices.map((minutes) => (
					<SelectItem key={minutes} value={String(minutes)}>
						<DayEnds minutes={minutes} />
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)
}

function HeldReason({ code }: { code: string }) {
	switch (code) {
		case 'invalid_request':
			return <Trans>The terminal's app may be out of date</Trans>
		case 'order_transferred':
			return <Trans>Sent after another terminal took the tab over</Trans>
		case 'order_closed':
		case 'paid_order_changed':
		case 'payments_changed':
		case 'refunds_changed':
		case 'line_voids_changed':
			return <Trans>A change to a bill that was already settled</Trans>
		case 'wrong_location':
			return <Trans>Sent for a location this terminal is not paired to</Trans>
		default:
			return <Trans>The server could not apply it</Trans>
	}
}

/** The next free `T<n>`, so a manager can just press Create. */
export function suggestCode(
	devices: Terminal[],
	pending: Array<{ terminalCode: string }>,
): string {
	const taken = new Set([
		...devices.filter((d) => d.revokedAt === null).map((d) => d.terminalCode),
		...pending.map((p) => p.terminalCode),
	])
	for (let n = 1; n < 100; n++) if (!taken.has(`T${n}`)) return `T${n}`
	return 'T100'
}

function LastSeen({ at }: { at: number | null }) {
	const { i18n } = useLingui()
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 30_000)
		return () => clearInterval(timer)
	}, [])
	if (at === null) return <Trans>Not seen yet</Trans>
	const ago = now - at
	if (ago < 60_000) return <Trans>Seen just now</Trans>
	const minutes = Math.round(ago / 60_000)
	const rtf = new Intl.RelativeTimeFormat(i18n.locale, { numeric: 'auto' })
	const label =
		minutes < 60
			? rtf.format(-minutes, 'minute')
			: minutes < 60 * 24
				? rtf.format(-Math.round(minutes / 60), 'hour')
				: rtf.format(-Math.round(minutes / 60 / 24), 'day')
	return (
		<span
			className={ago > QUIET_AFTER_MS ? 'text-muted-foreground' : undefined}
		>
			<Trans>Seen {label}</Trans>
		</span>
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

function PairDialog({
	open,
	onClose,
	request,
	tenantApiUrl,
	posUrl,
	appUrl,
	orgSlug,
	locations,
	stationFeatures,
	hostLocationIds = null,
	clockScopeIds = null,
	suggestedCode,
}: {
	open: boolean
	onClose: () => void
	request: (path: string, init?: RequestInit) => Promise<unknown>
	tenantApiUrl: () => Promise<string>
	posUrl: string
	appUrl: string
	orgSlug: string
	locations: TerminalLocation[]
	stationFeatures: StationFeatures
	/** Locations whose host stand this member may open; null is all of them. */
	hostLocationIds?: string[] | null
	/** Workplaces where this member may switch the time clock on; null is all of them. */
	clockScopeIds?: string[] | null
	suggestedCode: string
}) {
	const { _ } = useLingui()
	/** One location is the obvious choice; with several the manager picks (or none). */
	const firstLocation = locations.length === 1 ? locations[0]!.id : NO_LOCATION
	const [locationId, setLocationId] = useState(firstLocation)
	const [timeclockEnabled, setTimeclockEnabled] = useState(false)
	const [reservationsEnabled, setReservationsEnabled] = useState(false)
	const [label, setLabel] = useState('')
	const [terminalCode, setTerminalCode] = useState(suggestedCode)
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [signInRequired, setSignInRequired] = useState(true)
	const [dayStartMinutes, setDayStartMinutes] = useState(240)
	const [created, setCreated] = useState<Created | null>(null)
	const [apiUrl, setApiUrl] = useState<string | null>(null)
	const [paired, setPaired] = useState(false)
	// Where staff work by location, the clock needs the terminal's own (its workplace).
	const timeclockAllowed =
		stationFeatures.timeclock &&
		(locationId === NO_LOCATION
			? locations.length === 0 && clockScopeIds === null
			: clockScopeIds === null || clockScopeIds.includes(locationId))
	// The host stand opens guests' details only for a signed-in person at one location.
	const reservationsAllowed =
		stationFeatures.reservations &&
		locationId !== NO_LOCATION &&
		signInRequired &&
		(hostLocationIds === null || hostLocationIds.includes(locationId))

	useEffect(() => {
		if (open) {
			setLabel('')
			setTerminalCode(suggestedCode)
			setError(null)
			setCreated(null)
			setSignInRequired(true)
			setDayStartMinutes(240)
			setLocationId(firstLocation)
			setTimeclockEnabled(false)
			setReservationsEnabled(false)
			setPaired(false)
		}
		// Re-seed only when the dialog opens.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open])

	async function submit(event: FormEvent) {
		event.preventDefault()
		setPending(true)
		setError(null)
		try {
			const body = createdSchema.parse(
				await request('/pairing-codes', {
					method: 'POST',
					body: JSON.stringify({
						label: label.trim(),
						terminalCode: terminalCode.trim().toUpperCase(),
						signInRequired,
						dayStartMinutes,
						locationId: locationId === NO_LOCATION ? null : locationId,
						timeclockEnabled: timeclockAllowed && timeclockEnabled,
						reservationsEnabled: reservationsAllowed && reservationsEnabled,
					}),
				}),
			)
			setApiUrl(await tenantApiUrl())
			setCreated({ ...body, label: label.trim() })
		} catch (e) {
			setError(
				e instanceof OperatorRequestError
					? e.message
					: _(t`Could not create a pairing code. Try again.`),
			)
		} finally {
			setPending(false)
		}
	}

	return (
		<Dialog open={open} onOpenChange={(next) => !next && onClose()}>
			<DialogContent>
				{created && apiUrl ? (
					<PairingStep
						created={created}
						link={
							posUrl
								? buildPosPairingUrl({
										posUrl,
										tenantApiUrl: apiUrl,
										appUrl,
										slug: orgSlug,
										code: created.code,
									})
								: null
						}
						paired={paired}
						request={request}
						onPaired={() => setPaired(true)}
						onClose={onClose}
					/>
				) : (
					<form
						onSubmit={(e) => void submit(e)}
						className="flex flex-col gap-4"
					>
						<DialogHeader>
							<DialogTitle>
								<Trans>Pair a terminal</Trans>
							</DialogTitle>
							<DialogDescription>
								<Trans>
									Name it so you can tell it apart. The code prefixes its order
									numbers.
								</Trans>
							</DialogDescription>
						</DialogHeader>
						<FieldLabel className="flex w-full flex-col items-start gap-2 text-sm">
							<span className="font-medium">
								<Trans>Name</Trans>
							</span>
							<Input
								required
								autoFocus
								maxLength={60}
								value={label}
								onChange={(e) => setLabel(e.target.value)}
								placeholder={_(t`Front counter`)}
								className="h-11 md:h-8"
							/>
						</FieldLabel>
						<FieldLabel className="flex w-full flex-col items-start gap-2 text-sm">
							<span className="font-medium">
								<Trans>Terminal code</Trans>
							</span>
							<Input
								required
								maxLength={6}
								value={terminalCode}
								onChange={(e) => setTerminalCode(e.target.value.toUpperCase())}
								className="h-11 w-32 md:h-8"
								dir="ltr"
							/>
						</FieldLabel>
						{locations.length > 0 ? (
							<div className="flex flex-col gap-1 text-sm">
								<span className="font-medium">
									<Trans>Location</Trans>
								</span>
								<Select
									value={locationId}
									onValueChange={(next) => setLocationId(next ?? NO_LOCATION)}
								>
									<SelectTrigger
										className="h-11 w-fit max-w-full md:h-8"
										aria-label={_(t`Location`)}
									>
										<SelectValue>
											{locations.find((l) => l.id === locationId)?.name ??
												_(t`Any location`)}
										</SelectValue>
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={NO_LOCATION}>
											<Trans>Any location</Trans>
										</SelectItem>
										{locations.map((location) => (
											<SelectItem key={location.id} value={location.id}>
												{location.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<span className="text-muted-foreground">
									<Trans>
										A terminal bound to a location sells only there and can run
										its host stand.
									</Trans>
								</span>
							</div>
						) : null}
						<div className="flex flex-col gap-1 text-sm">
							<span className="font-medium">
								<Trans>Business day</Trans>
							</span>
							<DayStartSelect
								value={dayStartMinutes}
								label={_(t`When the business day ends`)}
								onChange={setDayStartMinutes}
							/>
							<span className="text-muted-foreground">
								<Trans>
									Orders after midnight count towards the previous day until
									then, so a late service keeps one day's numbers and takings.
								</Trans>
							</span>
						</div>
						<label className="flex items-start gap-3 text-sm">
							<Checkbox
								checked={signInRequired}
								onCheckedChange={(checked) =>
									setSignInRequired(checked === true)
								}
							/>
							<span>
								<span className="block font-medium">
									<Trans>Require a staff PIN</Trans>
								</span>
								<span className="text-muted-foreground">
									<Trans>
										The terminal locks when idle and each order records who took
										it. Staff need a PIN set under Staff.
									</Trans>
								</span>
							</span>
						</label>
						{stationFeatures.timeclock ? (
							<label className="flex items-start gap-3 text-sm">
								<Checkbox
									checked={timeclockAllowed && timeclockEnabled}
									disabled={!timeclockAllowed}
									onCheckedChange={(checked) =>
										setTimeclockEnabled(checked === true)
									}
								/>
								<span>
									<span className="block font-medium">
										<Trans>Time clock</Trans>
									</span>
									<span className="text-muted-foreground">
										{timeclockAllowed ? (
											<Trans>
												Staff clock in and out on this terminal with their PIN,
												even while it is locked.
											</Trans>
										) : locationId === NO_LOCATION ? (
											_(
												t`Choose the terminal's location to use the time clock.`,
											)
										) : (
											_(
												t`You can turn on the time clock only at your own locations.`,
											)
										)}
									</span>
								</span>
							</label>
						) : null}
						{stationFeatures.reservations ? (
							<label className="flex items-start gap-3 text-sm">
								<Checkbox
									checked={reservationsAllowed && reservationsEnabled}
									disabled={!reservationsAllowed}
									onCheckedChange={(checked) =>
										setReservationsEnabled(checked === true)
									}
								/>
								<span>
									<span className="block font-medium">
										<Trans>Reservations</Trans>
									</span>
									<span className="text-muted-foreground">
										{reservationsAllowed ? (
											<Trans>
												The host stand for this location: today’s floor,
												arrivals, walk-ins and the waitlist.
											</Trans>
										) : (
											<Trans>
												Needs a location and a staff PIN, so guests’ details
												only open for someone signed in.
											</Trans>
										)}
									</span>
								</span>
							</label>
						) : null}
						{error ? (
							<Alert variant="destructive">
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={onClose}
								disabled={pending}
							>
								<Trans>Cancel</Trans>
							</Button>
							<Button
								type="submit"
								disabled={pending || !label.trim() || !terminalCode.trim()}
							>
								{pending ? (
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

function PairingStep({
	created,
	link,
	paired,
	request,
	onPaired,
	onClose,
}: {
	created: Created
	/** `null` when POS_URL is not configured: show the bare code instead. */
	link: string | null
	paired: boolean
	request: (path: string, init?: RequestInit) => Promise<unknown>
	onPaired: () => void
	onClose: () => void
}) {
	const { _ } = useLingui()
	const createdLabel = created.label
	const shown = link ?? created.code
	const qr = useQrDataUrl(shown)
	const [now, setNow] = useState(() => Date.now())
	// The code left the pending list without a terminal redeeming it (removed).
	const [withdrawn, setWithdrawn] = useState(false)
	const expired = withdrawn || now >= created.expiresAt
	const seconds = Math.max(0, Math.ceil((created.expiresAt - now) / 1000))
	const left = useMemo(
		() =>
			`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
		[seconds],
	)

	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(timer)
	}, [])

	// Once the terminal redeems the code it leaves the pending list and an
	// active terminal with its code appears. A code that just disappears was
	// removed, not redeemed.
	useEffect(() => {
		if (paired || expired) return
		let live = true
		const timer = setInterval(() => {
			request('/terminals').then(
				(body) => {
					if (!live) return
					const parsed = listSchema.safeParse(body)
					if (
						!parsed.success ||
						parsed.data.pendingCodes.some((c) => c.id === created.id)
					)
						return
					const redeemed = parsed.data.devices.some(
						(device) =>
							device.terminalCode === created.terminalCode &&
							device.revokedAt === null,
					)
					if (redeemed) onPaired()
					else setWithdrawn(true)
				},
				() => undefined,
			)
		}, 3000)
		return () => {
			live = false
			clearInterval(timer)
		}
	}, [request, created.id, paired, expired, onPaired])

	async function copy() {
		try {
			await navigator.clipboard.writeText(shown)
			toast.success(link ? _(t`Link copied.`) : _(t`Code copied.`))
		} catch {
			toast.error(_(t`Could not copy. Select it and copy it by hand.`))
		}
	}

	if (paired) {
		return (
			<div className="flex flex-col gap-4">
				<DialogHeader>
					<DialogTitle>
						<Trans>Terminal paired</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>{createdLabel} is ready to take orders.</Trans>
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
					<Trans>Open this on the terminal</Trans>
				</DialogTitle>
				<DialogDescription>
					{link ? (
						<Trans>
							Scan the code with the device's camera, or open the link in its
							browser. It works once.
						</Trans>
					) : (
						<Trans>
							Enter this code in the Station app's settings on the device. It
							works once.
						</Trans>
					)}
				</DialogDescription>
			</DialogHeader>
			<div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
				<div className="border-border bg-background flex size-44 shrink-0 items-center justify-center rounded-lg border p-1">
					{qr && !expired ? (
						<img
							src={qr}
							alt={_(t`QR code that pairs the terminal`)}
							className="size-full"
						/>
					) : (
						<Skeleton className="size-full" />
					)}
				</div>
				<div className="flex min-w-0 flex-1 flex-col gap-3">
					<p className="text-muted-foreground text-sm tabular-nums">
						{withdrawn ? (
							<Trans>This code was removed. Make a new one.</Trans>
						) : expired ? (
							<Trans>This code expired. Make a new one.</Trans>
						) : (
							<Trans>Expires in {left}</Trans>
						)}
					</p>
					<FieldLabel className="flex w-full flex-col items-start gap-2 text-sm">
						<span className="font-medium">
							{link ? <Trans>Pairing link</Trans> : <Trans>Pairing code</Trans>}
						</span>
						<Input
							readOnly
							dir="ltr"
							value={shown}
							onFocus={(event) => event.currentTarget.select()}
							className="h-11 text-xs md:h-8"
						/>
					</FieldLabel>
					<Button
						type="button"
						variant="outline"
						className="h-11 w-fit md:h-8"
						onClick={() => void copy()}
						disabled={expired}
					>
						<Icon name="copy" />
						{link ? <Trans>Copy link</Trans> : <Trans>Copy code</Trans>}
					</Button>
				</div>
			</div>
			<p role="status" className="text-muted-foreground text-sm">
				{expired ? null : <Trans>Waiting for the terminal…</Trans>}
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
