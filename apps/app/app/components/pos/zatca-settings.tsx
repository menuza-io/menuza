import { type I18n } from '@lingui/core'
import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
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
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { FieldLabel } from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Skeleton } from '@repo/ui/skeleton'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import {
	OperatorRequestError,
	useOperatorClient,
} from '#app/hooks/use-operator-client.ts'

const ENVIRONMENTS = ['sandbox', 'simulation', 'production'] as const
type Environment = (typeof ENVIRONMENTS)[number]

const settingsSchema = z.object({
	environment: z.enum(ENVIRONMENTS),
	sellerName: z.string(),
	vatNumber: z.string(),
	crNumber: z.string(),
	street: z.string(),
	buildingNumber: z.string(),
	district: z.string(),
	city: z.string(),
	postalCode: z.string(),
	businessCategory: z.string(),
	branchName: z.string(),
})
type Settings = z.infer<typeof settingsSchema>
const overviewSchema = z.object({
	settings: settingsSchema.nullable(),
	units: z.array(
		z.object({
			deviceId: z.string(),
			status: z.enum(['onboarding', 'active', 'failed']),
			environment: z.string(),
			lastError: z.string().nullable(),
		}),
	),
	submissions: z.record(z.string(), z.number()),
})
const terminalsSchema = z.object({
	devices: z.array(
		z.object({
			id: z.string(),
			label: z.string(),
			terminalCode: z.string(),
			revokedAt: z.number().nullable(),
		}),
	),
})
const rejectedSchema = z.object({
	submissions: z.array(
		z.object({
			docId: z.string(),
			kind: z.string(),
			counter: z.number(),
			lastError: z.string().nullable(),
			terminalCode: z.string().nullable(),
		}),
	),
})

const EMPTY: Settings = {
	environment: 'sandbox',
	sellerName: '',
	vatNumber: '',
	crNumber: '',
	street: '',
	buildingNumber: '',
	district: '',
	city: '',
	postalCode: '',
	businessCategory: '',
	branchName: '',
}

function environmentLabel(_: I18n['_'], environment: Environment) {
	return environment === 'production'
		? _(t`Production (live invoices)`)
		: environment === 'simulation'
			? _(t`Simulation`)
			: _(t`Sandbox (developer portal)`)
}

/**
 * ZATCA e-invoicing (Phase 2) for walk-in sales: the seller as ZATCA knows it,
 * each terminal connected as an EGS unit with a one-time password from the
 * Fatoora portal, and how reporting is going. Everything lives on the
 * organization's regional server.
 */
export function ZatcaSettings({
	orgSlug,
	canWrite,
}: {
	orgSlug: string
	canWrite: boolean
}) {
	const { _ } = useLingui()
	const { request } = useOperatorClient(orgSlug, '/operator/pos')
	const [overview, setOverview] = useState<z.infer<
		typeof overviewSchema
	> | null>(null)
	const [terminals, setTerminals] = useState<
		z.infer<typeof terminalsSchema>['devices']
	>([])
	const [rejected, setRejected] = useState<
		z.infer<typeof rejectedSchema>['submissions']
	>([])
	const [form, setForm] = useState<Settings>(EMPTY)
	const [error, setError] = useState<string | null>(null)
	const [saving, setSaving] = useState(false)
	const [connecting, setConnecting] = useState<{
		id: string
		label: string
	} | null>(null)

	const load = useCallback(async () => {
		try {
			const [o, t2] = await Promise.all([
				request('/zatca'),
				request('/terminals'),
			])
			const parsed = overviewSchema.parse(o)
			setOverview(parsed)
			setTerminals(
				terminalsSchema.parse(t2).devices.filter((d) => d.revokedAt === null),
			)
			if (parsed.settings) setForm(parsed.settings)
			setRejected(
				(parsed.submissions.rejected ?? 0) > 0
					? rejectedSchema.parse(
							await request('/zatca/submissions?status=rejected'),
						).submissions
					: [],
			)
		} catch (e) {
			setError(
				e instanceof Error
					? e.message
					: _(t`Could not load the ZATCA settings.`),
			)
		}
	}, [request, _])

	useEffect(() => {
		void load()
	}, [load])

	async function save(event: FormEvent) {
		event.preventDefault()
		setSaving(true)
		setError(null)
		try {
			await request('/zatca/settings', {
				method: 'PUT',
				body: JSON.stringify(form),
			})
			toast.success(_(t`Seller details saved.`))
			await load()
		} catch (e) {
			setError(
				e instanceof OperatorRequestError
					? e.message
					: _(t`Could not save the seller details.`),
			)
		} finally {
			setSaving(false)
		}
	}

	async function reportNow() {
		try {
			await request('/zatca/report', { method: 'POST' })
			await load()
		} catch (e) {
			toast.error(
				e instanceof Error ? e.message : _(t`Could not report to ZATCA.`),
			)
		}
	}

	if (!overview) {
		return error ? (
			<Alert variant="destructive">
				<AlertDescription>{error}</AlertDescription>
			</Alert>
		) : (
			<Skeleton className="h-40 w-full" />
		)
	}

	const field = (
		key: keyof Settings,
		label: string,
		options: { inputMode?: 'numeric'; maxLength?: number; dir?: 'ltr' } = {},
	) => (
		<FieldLabel className="flex w-full min-w-0 flex-col items-start gap-2 text-sm">
			<span className="font-medium">{label}</span>
			<Input
				required
				value={form[key]}
				onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
				disabled={!canWrite}
				className="h-11 w-full md:h-9"
				{...options}
			/>
		</FieldLabel>
	)
	const counts = overview.submissions
	const reported = counts.reported ?? 0
	const withWarnings = counts.warning ?? 0
	const waiting = counts.pending ?? 0
	const refused = counts.rejected ?? 0
	const unitFor = (id: string) =>
		overview.units.find((u) => u.deviceId === id) ?? null

	return (
		<Card
			role="region"
			aria-label={_(t`ZATCA e-invoicing`)}
			className="min-w-0 shadow-none"
		>
			<CardHeader className="gap-2 border-b">
				<CardTitle as="h3">
					<Trans>ZATCA e-invoicing</Trans>
				</CardTitle>
				<CardDescription className="max-w-prose leading-relaxed">
					<Trans>
						For restaurants in Saudi Arabia. Each terminal signs its simplified
						tax invoices and credit notes, and they are reported to ZATCA within
						24 hours.
					</Trans>
				</CardDescription>
			</CardHeader>

			<CardContent className="@container flex min-w-0 flex-col gap-6">
				<form
					onSubmit={(e) => void save(e)}
					className="flex min-w-0 flex-col gap-6"
					aria-label={_(t`Seller details`)}
				>
					<fieldset className="grid min-w-0 gap-4 @lg:grid-cols-2 @lg:gap-x-6">
						<legend className="mb-4 font-medium">
							<Trans>Seller details</Trans>
						</legend>
						<FieldLabel className="flex w-full flex-col items-start gap-2 text-sm @lg:col-span-2">
							<span className="font-medium">
								<Trans>Environment</Trans>
							</span>
							<Select
								value={form.environment}
								onValueChange={(value) =>
									setForm((f) => ({ ...f, environment: value as Environment }))
								}
								disabled={!canWrite}
							>
								<SelectTrigger
									className="h-11 w-full sm:w-80 md:h-9"
									aria-label={_(t`Environment`)}
								>
									<SelectValue>
										{environmentLabel(_, form.environment)}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									{ENVIRONMENTS.map((environment) => (
										<SelectItem key={environment} value={environment}>
											{environmentLabel(_, environment)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</FieldLabel>
						{field('sellerName', _(t`Legal name`))}
						{field('branchName', _(t`Branch name`))}
						{field('vatNumber', _(t`VAT number`), {
							inputMode: 'numeric',
							maxLength: 15,
							dir: 'ltr',
						})}
						{field('crNumber', _(t`Commercial registration number`), {
							inputMode: 'numeric',
							maxLength: 10,
							dir: 'ltr',
						})}
						{field('businessCategory', _(t`Business category`))}
					</fieldset>
					<fieldset className="border-border grid min-w-0 gap-4 border-t pt-5 @lg:grid-cols-2 @lg:gap-x-6">
						<legend className="col-span-full float-start mb-4 w-full font-medium">
							<Trans>Address</Trans>
						</legend>
						{field('street', _(t`Street`))}
						{field('buildingNumber', _(t`Building number`), {
							inputMode: 'numeric',
							maxLength: 4,
							dir: 'ltr',
						})}
						{field('district', _(t`District`))}
						{field('city', _(t`City`))}
						{field('postalCode', _(t`Postal code`), {
							inputMode: 'numeric',
							maxLength: 5,
							dir: 'ltr',
						})}
					</fieldset>
					{error ? (
						<Alert variant="destructive">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}
					{canWrite ? (
						<div className="border-border flex justify-end border-t pt-4">
							<Button
								type="submit"
								className="h-11 w-full sm:w-auto md:h-9"
								disabled={saving}
							>
								{saving ? (
									<Trans>Saving…</Trans>
								) : (
									<Trans>Save seller details</Trans>
								)}
							</Button>
						</div>
					) : null}
				</form>

				{overview.settings ? (
					<ul
						className="flex flex-col gap-2"
						aria-label={_(t`Terminals connected to ZATCA`)}
					>
						{terminals.map((device) => {
							const unit = unitFor(device.id)
							return (
								<li
									key={device.id}
									className="border-border flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm"
								>
									<div className="min-w-0 flex-1">
										<p className="font-medium wrap-anywhere">
											{device.label} ({device.terminalCode})
										</p>
										{unit?.status === 'failed' && unit.lastError ? (
											<p className="text-destructive">{unit.lastError}</p>
										) : null}
									</div>
									{unit?.status === 'active' ? (
										<Badge variant="secondary">
											<Trans>Connected</Trans>
										</Badge>
									) : unit?.status === 'failed' ? (
										<Badge variant="destructive">
											<Trans>Not connected</Trans>
										</Badge>
									) : (
										<Badge variant="outline">
											<Trans>Not connected</Trans>
										</Badge>
									)}
									{canWrite ? (
										<Button
											variant="outline"
											className="h-11 md:h-8"
											onClick={() =>
												setConnecting({ id: device.id, label: device.label })
											}
										>
											{unit?.status === 'active' ? (
												<Trans>Reconnect</Trans>
											) : (
												<Trans>Connect</Trans>
											)}
										</Button>
									) : null}
								</li>
							)
						})}
					</ul>
				) : null}

				{Object.keys(counts).length > 0 ? (
					<div
						className="flex flex-wrap items-center gap-2 text-sm"
						role="status"
					>
						<Badge variant="secondary">
							<Trans>Reported {reported}</Trans>
						</Badge>
						{counts.warning ? (
							<Badge variant="outline">
								<Trans>With warnings {withWarnings}</Trans>
							</Badge>
						) : null}
						{counts.pending ? (
							<Badge variant="outline">
								<Trans>Waiting {waiting}</Trans>
							</Badge>
						) : null}
						{counts.rejected ? (
							<Badge variant="destructive">
								<Trans>Rejected {refused}</Trans>
							</Badge>
						) : null}
						{canWrite && counts.pending ? (
							<Button
								variant="ghost"
								className="h-11 md:h-8"
								onClick={() => void reportNow()}
							>
								<Trans>Report now</Trans>
							</Button>
						) : null}
					</div>
				) : null}
				{rejected.length > 0 ? (
					<ul
						className="flex flex-col gap-1 text-sm"
						aria-label={_(t`Documents ZATCA rejected`)}
					>
						{rejected.map((doc) => (
							<li key={doc.docId} className="text-destructive">
								{doc.terminalCode ?? ''} #{doc.counter}: {doc.lastError}
							</li>
						))}
					</ul>
				) : null}

				<ConnectDialog
					target={connecting}
					onClose={() => setConnecting(null)}
					onConnect={async (otp) => {
						await request(
							`/zatca/units/${encodeURIComponent(connecting!.id)}/onboard`,
							{
								method: 'POST',
								body: JSON.stringify({ otp }),
							},
						)
						toast.success(
							_(
								t`Connected to ZATCA. The terminal picks up its certificate the next time it connects.`,
							),
						)
						setConnecting(null)
						await load()
					}}
				/>
			</CardContent>
		</Card>
	)
}

function ConnectDialog({
	target,
	onClose,
	onConnect,
}: {
	target: { id: string; label: string } | null
	onClose: () => void
	onConnect: (otp: string) => Promise<void>
}) {
	const { _ } = useLingui()
	const [otp, setOtp] = useState('')
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const label = target?.label ?? ''

	useEffect(() => {
		if (target) {
			setOtp('')
			setError(null)
		}
	}, [target])

	async function submit(event: FormEvent) {
		event.preventDefault()
		setPending(true)
		setError(null)
		try {
			await onConnect(otp)
		} catch (e) {
			setError(
				e instanceof Error ? e.message : _(t`Could not connect the terminal.`),
			)
		} finally {
			setPending(false)
		}
	}

	return (
		<Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
					<DialogHeader>
						<DialogTitle>
							<Trans>Connect {label} to ZATCA</Trans>
						</DialogTitle>
						<DialogDescription>
							<Trans>
								In the Fatoora portal, generate a one-time password for one EGS
								unit and enter it here within the hour. The server requests the
								terminal’s certificate and runs ZATCA’s compliance checks.
							</Trans>
						</DialogDescription>
					</DialogHeader>
					<FieldLabel className="flex w-full flex-col items-start gap-2 text-sm">
						<span className="font-medium">
							<Trans>One-time password</Trans>
						</span>
						<Input
							required
							autoFocus
							inputMode="numeric"
							maxLength={6}
							value={otp}
							onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
							className="h-11 w-40 md:h-8"
							dir="ltr"
						/>
					</FieldLabel>
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
						<Button type="submit" disabled={pending || otp.length !== 6}>
							{pending ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
