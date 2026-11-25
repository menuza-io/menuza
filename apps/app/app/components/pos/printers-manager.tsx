import { type I18n } from '@lingui/core'
import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	printerHealthReason,
	type PrinterHealth,
	type PrinterRoutes,
} from '@repo/common/print-devices'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
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
import { Switch } from '@repo/ui/switch'
import { useCallback, useEffect, useState } from 'react'
import { z } from 'zod'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import {
	OperatorRequestError,
	useOperatorClient,
} from '#app/hooks/use-operator-client.ts'

const healthValues = [
	'online',
	'offline',
	'out_of_paper',
	'cover_open',
	'error',
	'never_seen',
	'revoked',
] as const

const routesSchema = z.object({
	kitchen: z.enum(['off', 'all', 'stations']).catch('off'),
	stationIds: z.array(z.string()).catch([]),
	receipts: z.boolean().catch(false),
	isDefault: z.boolean().catch(false),
	deliveryAddress: z.boolean().catch(false),
	arabicFont: z.boolean().catch(false),
})

const printerSchema = z.object({
	id: z.string(),
	ref: z.string(),
	locationId: z.string(),
	name: z.string(),
	protocol: z.enum(['star_cloudprnt', 'epson_sdp']),
	widthMm: z.number(),
	copies: z.number(),
	routes: routesSchema,
	health: z.enum(healthValues).catch('error'),
	lastSeenAt: z.number().nullable(),
	lastTestAt: z.number().nullable(),
	lastTestResult: z.string().nullable(),
	flaggedJobs: z.number().catch(0),
})
export type PrinterRow = z.infer<typeof printerSchema>

const listSchema = z.object({
	printers: z.array(printerSchema),
	enabled: z.boolean(),
	killSwitch: z.boolean().catch(false),
})
const createdSchema = z.object({
	printer: printerSchema,
	password: z.string(),
})

type LocationOption = { id: string; name: string }

function healthLabel(_: I18n['_'], health: PrinterHealth) {
	return {
		online: _(t`Online`),
		offline: _(t`Disconnected`),
		out_of_paper: _(t`Out of paper`),
		cover_open: _(t`Cover open`),
		error: _(t`Problem reported`),
		never_seen: _(t`Not connected yet`),
		revoked: _(t`Removed`),
	}[health]
}

/** The plain-English reason a printer is not ready, in the language of the screen. */
function reasonText(_: I18n['_'], health: PrinterHealth): string | null {
	switch (health) {
		case 'offline':
			return _(
				t`The printer is disconnected. Check its power and network, then try again.`,
			)
		case 'never_seen':
			return _(
				t`The printer has not connected yet. Enter the address and password in its cloud printing settings.`,
			)
		case 'out_of_paper':
			return _(t`The printer is out of paper.`)
		case 'cover_open':
			return _(t`The printer cover is open.`)
		case 'error':
			return _(t`The printer reported a problem.`)
		default:
			return printerHealthReason(health)
	}
}

export function printerSummary(_: I18n['_'], routes: PrinterRoutes) {
	const parts: string[] = []
	if (routes.kitchen === 'all') parts.push(_(t`All kitchen tickets`))
	if (routes.kitchen === 'stations') {
		parts.push(_(t`Kitchen tickets of some stations`))
	}
	if (routes.receipts) parts.push(_(t`Receipts`))
	if (routes.isDefault) parts.push(_(t`Default printer`))
	return parts.length > 0 ? parts.join(' · ') : _(t`Nothing yet`)
}

/**
 * Settings, Terminals, Printers (#117, #426): cloud-connected kitchen and
 * receipt printers per location. The printer polls the regional node itself;
 * this screen talks to the region straight from the browser like the terminals
 * list does. A printer's password is shown once, when it is added or reset.
 */
export function PrintersManager({
	orgSlug,
	canWrite,
	locations,
	enabled,
}: {
	orgSlug: string
	canWrite: boolean
	locations: LocationOption[]
	/** The organization has the `kitchen.printers` flag. */
	enabled: boolean
}) {
	const { _ } = useLingui()
	const printerClient = useOperatorClient(orgSlug, '/operator/pos/printers')
	const posClient = useOperatorClient(orgSlug, '/operator/pos')
	// Stable handles: `load` must not change on every render.
	const printers = { request: printerClient.request, tenantApiUrl: printerClient.tenantApiUrl }
	const pos = { request: posClient.request }
	const [state, setState] = useState<
		| { status: 'loading' }
		| { status: 'error'; message: string }
		| { status: 'ready'; data: z.infer<typeof listSchema> }
	>({ status: 'loading' })
	const [adding, setAdding] = useState(false)
	const [shown, setShown] = useState<{
		printer: PrinterRow
		password: string
		url: string
	} | null>(null)
	const [notice, setNotice] = useState<{
		id: string
		tone: 'ok' | 'bad'
		text: string
	} | null>(null)
	const [busy, setBusy] = useState<string | null>(null)

	const load = useCallback(async () => {
		try {
			const body = listSchema.parse(
				await printerClient.request('', { readOnly: true }),
			)
			setState({ status: 'ready', data: body })
		} catch (error) {
			setState({
				status: 'error',
				message:
					error instanceof Error ? error.message : _(t`Could not load printers.`),
			})
		}
	}, [printerClient.request, _])

	useEffect(() => {
		if (enabled) void load()
	}, [enabled, load])

	if (!enabled) return null

	const locationName = (id: string) =>
		locations.find((location) => location.id === id)?.name ?? id

	const addressFor = async (ref: string) =>
		`${await printers.tenantApiUrl()}/print/${ref}/poll`

	/** Prints a test ticket, or opens the drawer, and says how it went. */
	const test = async (printer: PrinterRow, kind: 'test' | 'drawer') => {
		setBusy(`${kind}:${printer.id}`)
		setNotice(null)
		try {
			const result = z
				.object({ jobId: z.string() })
				.parse(
					await printers.request(`/${printer.id}/test`, {
						method: 'POST',
						body: JSON.stringify({ kind }),
					}),
				)
			// The printer collects it on its next poll: ask until it answers.
			for (let i = 0; i < 20; i++) {
				await new Promise((resolve) => setTimeout(resolve, 1500))
				const job = z
					.object({
						job: z.object({
							status: z.string(),
							reason: z.string().nullable(),
						}),
					})
					.parse(
						await printers.request(`/${printer.id}/jobs/${result.jobId}`, {
							readOnly: true,
						}),
					)
				if (job.job.status === 'printed') {
					setNotice({
						id: printer.id,
						tone: 'ok',
						text:
							kind === 'drawer'
								? _(t`The drawer opened.`)
								: _(t`The test ticket printed.`),
					})
					await load()
					return
				}
				if (job.job.reason) {
					setNotice({
						id: printer.id,
						tone: 'bad',
						text:
							job.job.reason === 'unsupported'
								? _(t`This printer does not support that.`)
								: job.job.reason === 'out_of_paper'
									? _(t`The printer is out of paper.`)
									: job.job.reason === 'cover_open'
										? _(t`The printer cover is open.`)
										: _(t`The printer could not print it.`),
					})
					await load()
					return
				}
			}
			setNotice({
				id: printer.id,
				tone: 'bad',
				text: _(t`The printer did not pick it up. Check that it is connected.`),
			})
		} catch (error) {
			const reason =
				error instanceof OperatorRequestError &&
				typeof error.body?.reason === 'string'
					? (error.body.reason as PrinterHealth)
					: null
			setNotice({
				id: printer.id,
				tone: 'bad',
				text:
					(reason ? reasonText(_, reason) : null) ??
					(error instanceof Error
						? error.message
						: _(t`The test could not start.`)),
			})
		} finally {
			setBusy(null)
		}
	}

	const remove = async (printer: PrinterRow) => {
		setBusy(`remove:${printer.id}`)
		try {
			await printers.request(`/${printer.id}/revoke`, { method: 'POST' })
			await load()
		} finally {
			setBusy(null)
		}
	}

	const resetPassword = async (printer: PrinterRow) => {
		setBusy(`password:${printer.id}`)
		try {
			const result = createdSchema.parse(
				await printers.request(`/${printer.id}/password`, { method: 'POST' }),
			)
			setShown({
				printer: result.printer,
				password: result.password,
				url: await addressFor(result.printer.ref),
			})
		} finally {
			setBusy(null)
		}
	}

	const ready = state.status === 'ready' ? state.data : null
	return (
		<Card
			role="region"
			aria-label={_(t`Printers`)}
			className="min-w-0 shadow-none"
			data-testid="printers-manager"
		>
			<CardHeader className="gap-2 border-b">
				<CardTitle as="h3">
					<Trans>Printers</Trans>
				</CardTitle>
				<CardDescription className="max-w-prose leading-relaxed">
					<Trans>
						Cloud-connected kitchen and receipt printers (Star CloudPRNT and
						Epson Server Direct Print). New online orders print when they are
						accepted, and Station prints kitchen tickets when you send and a
						receipt when you take payment.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4 pt-4">
				{ready?.killSwitch ? (
					<Alert>
						<AlertDescription>
							<Trans>
								Printing is switched off on this node. Printers stay connected
								but print nothing until it is switched back on.
							</Trans>
						</AlertDescription>
					</Alert>
				) : null}
				{state.status === 'error' ? (
					<Alert variant="destructive">
						<AlertDescription>{state.message}</AlertDescription>
					</Alert>
				) : null}
				{ready && ready.printers.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>No printers yet.</Trans>
					</p>
				) : null}
				<ul className="divide-y">
					{(ready?.printers ?? []).map((printer) => {
						const reason = reasonText(_, printer.health)
						return (
							<li
								key={printer.id}
								className="space-y-2 py-4 first:pt-0"
								data-testid="printer-row"
							>
								<div className="flex flex-wrap items-center gap-2">
									<h4 className="text-base font-semibold wrap-anywhere">
										{printer.name}
									</h4>
									<Badge
										variant={printer.health === 'online' ? 'secondary' : 'outline'}
										data-testid="printer-health"
										data-health={printer.health}
									>
										{healthLabel(_, printer.health)}
									</Badge>
									{locations.length > 1 ? (
										<span className="text-muted-foreground text-sm">
											{locationName(printer.locationId)}
										</span>
									) : null}
								</div>
								<p className="text-muted-foreground text-sm">
									{printer.protocol === 'star_cloudprnt'
										? _(t`Star CloudPRNT`)
										: _(t`Epson Server Direct Print`)}
									{' · '}
									{printer.widthMm} mm{' · '}
									{printerSummary(_, printer.routes)}
								</p>
								<p className="text-muted-foreground text-sm">
									{printer.lastSeenAt
										? _(
												t`Last seen ${new Date(printer.lastSeenAt).toLocaleString()}`,
											)
										: _(t`Never seen`)}
									{printer.lastTestAt
										? ` · ${_(t`Last test ${new Date(printer.lastTestAt).toLocaleString()}`)}`
										: ''}
								</p>
								{reason && printer.health !== 'online' ? (
									<p
										role="status"
										className="text-sm"
										data-testid="printer-reason"
									>
										{reason}
									</p>
								) : null}
								{printer.flaggedJobs > 0 ? (
									<p
										role="alert"
										className="text-destructive text-sm font-medium"
										data-testid="printer-flagged"
									>
										<Trans>
											{printer.flaggedJobs} ticket(s) did not print. The
											printer never confirmed them.
										</Trans>
									</p>
								) : null}
								{notice?.id === printer.id ? (
									<p
										role="status"
										className={
											notice.tone === 'ok'
												? 'text-sm font-medium'
												: 'text-destructive text-sm font-medium'
										}
										data-testid="printer-notice"
									>
										{notice.text}
									</p>
								) : null}
								{canWrite ? (
									<div className="flex flex-wrap gap-2">
										<Button
											variant="outline"
											className="h-11 md:h-8"
											disabled={busy !== null}
											onClick={() => void test(printer, 'test')}
										>
											<Icon name="printer" className="size-4" />
											<Trans>Print a test ticket</Trans>
										</Button>
										<Button
											variant="outline"
											className="h-11 md:h-8"
											disabled={busy !== null}
											onClick={() => void test(printer, 'drawer')}
										>
											<Trans>Open drawer</Trans>
										</Button>
										<Button
											variant="ghost"
											className="h-11 md:h-8"
											disabled={busy !== null}
											onClick={() => void resetPassword(printer)}
										>
											<Trans>New password</Trans>
										</Button>
										<Button
											variant="ghost"
											className="text-destructive h-11 md:h-8"
											disabled={busy !== null}
											onClick={() => void remove(printer)}
										>
											<Trans>Remove</Trans>
										</Button>
									</div>
								) : null}
							</li>
						)
					})}
				</ul>
				{canWrite ? (
					<Button onClick={() => setAdding(true)} className="h-11 md:h-8">
						<Trans>Add a printer</Trans>
					</Button>
				) : null}
			</CardContent>
			{adding ? (
				<AddPrinterDialog
					locations={locations}
					loadStations={async (locationId) =>
						z
							.object({
								stations: z.array(z.object({ id: z.string(), name: z.string() })),
							})
							.parse(
								await pos.request(
									`/kds-stations?locationId=${encodeURIComponent(locationId)}`,
									{ readOnly: true },
								),
							).stations
					}
					onClose={() => setAdding(false)}
					onCreate={async (body) => {
						const created = createdSchema.parse(
							await printers.request('', {
								method: 'POST',
								body: JSON.stringify(body),
							}),
						)
						setAdding(false)
						setShown({
							printer: created.printer,
							password: created.password,
							url: await addressFor(created.printer.ref),
						})
						await load()
					}}
				/>
			) : null}
			{shown ? (
				<Dialog open onOpenChange={(open) => !open && setShown(null)}>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>
								<Trans>Connect {shown.printer.name}</Trans>
							</DialogTitle>
							<DialogDescription>
								<Trans>
									In the printer's cloud printing settings, enter this server
									address and password. The password is shown only now.
								</Trans>
							</DialogDescription>
						</DialogHeader>
						<div className="space-y-3 text-sm">
							<div>
								<p className="text-muted-foreground">
									<Trans>Server address</Trans>
								</p>
								<code
									className="block rounded-md border p-2 break-all"
									data-testid="printer-url"
									dir="ltr"
								>
									{shown.url}
								</code>
							</div>
							<div>
								<p className="text-muted-foreground">
									<Trans>Password</Trans>
								</p>
								<code
									className="block rounded-md border p-2 break-all"
									data-testid="printer-password"
									dir="ltr"
								>
									{shown.password}
								</code>
							</div>
							<p className="text-muted-foreground">
								{shown.printer.protocol === 'star_cloudprnt' ? (
									<Trans>
										Star CloudPRNT: turn on CloudPRNT, paste the address as the
										server URL, and enter the password under Basic
										authentication (any user name).
									</Trans>
								) : (
									<Trans>
										Epson Server Direct Print: turn it on, paste the address as
										the server URL, and enter the password (any ID).
									</Trans>
								)}
							</p>
						</div>
						<DialogFooter>
							<Button onClick={() => setShown(null)}>
								<Trans>Done</Trans>
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			) : null}
		</Card>
	)
}

type NewPrinter = {
	locationId: string
	name: string
	protocol: 'star_cloudprnt' | 'epson_sdp'
	widthMm: 58 | 80
	copies: number
	routes: PrinterRoutes
}

function AddPrinterDialog({
	locations,
	loadStations,
	onClose,
	onCreate,
}: {
	locations: LocationOption[]
	loadStations: (locationId: string) => Promise<Array<{ id: string; name: string }>>
	onClose: () => void
	onCreate: (body: NewPrinter) => Promise<void>
}) {
	const { _ } = useLingui()
	const [locationId, setLocationId] = useState(locations[0]?.id ?? '')
	const [name, setName] = useState('')
	const [protocol, setProtocol] = useState<NewPrinter['protocol']>('star_cloudprnt')
	const [widthMm, setWidthMm] = useState<'58' | '80'>('80')
	const [copies, setCopies] = useState('1')
	const [kitchen, setKitchen] = useState<PrinterRoutes['kitchen']>('all')
	const [stationIds, setStationIds] = useState<string[]>([])
	const [receipts, setReceipts] = useState(false)
	const [isDefault, setIsDefault] = useState(false)
	const [deliveryAddress, setDeliveryAddress] = useState(false)
	const [arabicFont, setArabicFont] = useState(false)
	const [stations, setStations] = useState<Array<{ id: string; name: string }>>([])
	const [error, setError] = useState<string | null>(null)
	const [saving, setSaving] = useState(false)

	useEffect(() => {
		if (!locationId) return
		let live = true
		loadStations(locationId)
			.then((rows) => live && setStations(rows))
			.catch(() => live && setStations([]))
		return () => {
			live = false
		}
	}, [locationId, loadStations])

	const submit = async () => {
		if (!name.trim()) {
			setError(_(t`Give the printer a name.`))
			return
		}
		setSaving(true)
		setError(null)
		try {
			await onCreate({
				locationId,
				name: name.trim(),
				protocol,
				widthMm: widthMm === '58' ? 58 : 80,
				copies: Math.max(1, Math.min(5, Number(copies) || 1)),
				routes: {
					kitchen,
					stationIds: kitchen === 'stations' ? stationIds : [],
					receipts,
					isDefault,
					deliveryAddress,
					arabicFont,
				},
			})
		} catch (failure) {
			setError(
				failure instanceof Error
					? failure.message
					: _(t`Could not add the printer.`),
			)
			setSaving(false)
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						<Trans>Add a printer</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							A printer belongs to one location and only prints that
							location's tickets.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					{locations.length > 1 ? (
						<SelectField
							id="printer-location"
							label={<Trans>Location</Trans>}
							options={locations.map((l) => ({ value: l.id, label: l.name }))}
							value={locationId}
							onValueChange={(v) => {
								setLocationId(v)
								setStationIds([])
							}}
						/>
					) : null}
					<TextField
						id="printer-name"
						label={<Trans>Name</Trans>}
						value={name}
						onChange={(e) => setName(e.target.value)}
						maxLength={60}
					/>
					<div className="grid gap-4 sm:grid-cols-3">
						<SelectField
							id="printer-protocol"
							label={<Trans>Printer type</Trans>}
							options={[
								{ value: 'star_cloudprnt', label: _(t`Star CloudPRNT`) },
								{ value: 'epson_sdp', label: _(t`Epson Server Direct Print`) },
							]}
							value={protocol}
							onValueChange={(v) => setProtocol(v as NewPrinter['protocol'])}
						/>
						<SelectField
							id="printer-width"
							label={<Trans>Paper width</Trans>}
							options={[
								{ value: '58', label: '58 mm' },
								{ value: '80', label: '80 mm' },
							]}
							value={widthMm}
							onValueChange={(v) => setWidthMm(v === '58' ? '58' : '80')}
						/>
						<TextField
							id="printer-copies"
							label={<Trans>Copies</Trans>}
							type="text"
							inputMode="numeric"
							value={copies}
							onChange={(e) => setCopies(e.target.value)}
						/>
					</div>
					<SelectField
						id="printer-kitchen"
						label={<Trans>Kitchen tickets</Trans>}
						options={[
							{ value: 'all', label: _(t`All tickets`) },
							{ value: 'stations', label: _(t`Only some stations`) },
							{ value: 'off', label: _(t`None`) },
						]}
						value={kitchen}
						onValueChange={(v) => setKitchen(v as PrinterRoutes['kitchen'])}
					/>
					{kitchen === 'stations' ? (
						<fieldset className="space-y-2">
							<legend className="text-sm font-medium">
								<Trans>Stations</Trans>
							</legend>
							{stations.map((station) => (
								<label key={station.id} className="flex items-center gap-2 text-sm">
									<Checkbox
										checked={stationIds.includes(station.id)}
										onCheckedChange={(on) =>
											setStationIds((current) =>
												on
													? [...current, station.id]
													: current.filter((id) => id !== station.id),
											)
										}
									/>
									{station.name}
								</label>
							))}
						</fieldset>
					) : null}
					<Row label={_(t`Print guest receipts`)} checked={receipts} onChange={setReceipts} />
					<Row
						label={_(t`Default printer: dishes of stations with no printer`)}
						checked={isDefault}
						onChange={setIsDefault}
					/>
					<Row
						label={_(t`Show the delivery address on delivery tickets`)}
						checked={deliveryAddress}
						onChange={setDeliveryAddress}
					/>
					<Row
						label={_(t`The printer has an Arabic font`)}
						checked={arabicFont}
						onChange={setArabicFont}
					/>
					{error ? (
						<p role="alert" className="text-destructive text-sm">
							{error}
						</p>
					) : null}
				</div>
				<DialogFooter>
					<Button variant="ghost" onClick={onClose}>
						<Trans>Cancel</Trans>
					</Button>
					<Button onClick={() => void submit()} disabled={saving}>
						<Trans>Add printer</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

function Row({
	label,
	checked,
	onChange,
}: {
	label: string
	checked: boolean
	onChange: (on: boolean) => void
}) {
	return (
		<div className="flex items-center justify-between gap-3">
			<span className="text-sm">{label}</span>
			<Switch checked={checked} aria-label={label} onCheckedChange={onChange} />
		</div>
	)
}
