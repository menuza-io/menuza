import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
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
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useEffect, useState } from 'react'
import { useFetcher, useParams } from 'react-router'
import { type DomainOverview } from '#app/utils/domains/overview.server.ts'
import { type DomainOffer } from '#app/utils/domains/registrar.server.ts'
import { errorMessage, useDomainFetcher } from './domain-ui.tsx'

/**
 * Get a domain (#183): search with the yearly price and suggestions, buy with
 * the card on file, watch the registration (and the refund, if it fails), and
 * transfer a domain in with its authorization code. Behind `domains.registrar`.
 */

type Job = DomainOverview['jobs'][number]

const money = (cents: number, currency = 'usd') =>
	new Intl.NumberFormat(undefined, {
		style: 'currency',
		currency: currency.toUpperCase(),
	}).format(cents / 100)

const CONTACT_FIELDS: Array<[string, string, string]> = [
	['firstName', 'First name', 'given-name'],
	['lastName', 'Last name', 'family-name'],
	['organization', 'Legal business name', 'organization'],
	['email', 'Owner email', 'email'],
	['phone', 'Phone (with country code)', 'tel'],
	['address1', 'Address', 'address-line1'],
	['address2', 'Address line 2 (optional)', 'address-line2'],
	['city', 'City', 'address-level2'],
	['state', 'State or region', 'address-level1'],
	['postalCode', 'Postal code', 'postal-code'],
	['country', 'Country (2 letters, for example SA)', 'country'],
]

function ContactFields() {
	const { _ } = useLingui()
	const labels: Record<string, string> = {
		firstName: _(msg`First name`),
		lastName: _(msg`Last name`),
		organization: _(msg`Legal business name`),
		email: _(msg`Owner email`),
		phone: _(msg`Phone (with country code)`),
		address1: _(msg`Address`),
		address2: _(msg`Address line 2 (optional)`),
		city: _(msg`City`),
		state: _(msg`State or region`),
		postalCode: _(msg`Postal code`),
		country: _(msg`Country (2 letters, for example SA)`),
	}
	return (
		<div className="grid gap-3 sm:grid-cols-2">
			{CONTACT_FIELDS.map(([key, , autoComplete]) => (
				<div key={key} className="space-y-1">
					<Label htmlFor={`contact_${key}`}>{labels[key]}</Label>
					<Input
						id={`contact_${key}`}
						name={`contact_${key}`}
						autoComplete={autoComplete}
						required={key !== 'address2'}
						maxLength={key === 'country' ? 2 : 120}
					/>
				</div>
			))}
		</div>
	)
}

export function JobProgress({ job }: { job: Job }) {
	const { _ } = useLingui()
	const poller = useFetcher<Job>()
	const { orgSlug } = useParams()
	const [current, setCurrent] = useState<Job>(job)
	const running = current.status === 'queued' || current.status === 'running'
	useEffect(() => {
		if (!running) return
		const timer = setInterval(() => {
			void poller.load(
				`/${orgSlug}/website/domain/job?job=${encodeURIComponent(job.id)}`,
			)
		}, 2500)
		return () => clearInterval(timer)
	}, [running, job.id, poller, orgSlug])
	useEffect(() => {
		if (poller.data) setCurrent(poller.data)
	}, [poller.data])
	const stepLabels: Record<string, string> = {
		charging: _(msg`Taking the payment`),
		registering: _(msg`Registering the domain`),
		zone: _(msg`Setting up DNS`),
		site: _(msg`Connecting your site and its certificate`),
		done: _(msg`Done`),
	}
	return (
		<div className="space-y-1 rounded-xl border p-3 text-sm">
			<p className="font-medium">
				{current.fqdn}{' '}
				<Badge
					variant={
						current.status === 'succeeded'
							? 'success'
							: current.status === 'failed'
								? 'destructive'
								: 'warning'
					}
				>
					{current.status === 'succeeded'
						? _(msg`Ready`)
						: current.status === 'failed'
							? _(msg`Failed`)
							: _(msg`In progress`)}
				</Badge>
			</p>
			{running ? (
				<p className="text-muted-foreground">
					<Icon name="clock" className="me-1 inline size-3.5" />
					{stepLabels[current.step ?? ''] ?? _(msg`Working`)}…
				</p>
			) : null}
			{current.status === 'succeeded' ? (
				<p className="text-muted-foreground">
					<Trans>
						Your site is being set up on it. This page updates as it goes live.
					</Trans>
				</p>
			) : null}
			{current.status === 'failed' ? (
				<p className="text-destructive">
					{current.refunded ? (
						<Trans>
							We could not register it, and the charge was refunded in full.
						</Trans>
					) : current.chargeStatus === 'failed' ||
					  current.chargeStatus === null ? (
						<Trans>It could not be registered. You were not charged.</Trans>
					) : (
						<Trans>We could not register it. Your refund is on its way.</Trans>
					)}
				</p>
			) : null}
		</div>
	)
}

function BuyDialog({
	offer,
	onClose,
	onStarted,
}: {
	offer: DomainOffer | null
	onClose: () => void
	onStarted: (jobId: string) => void
}) {
	const { _ } = useLingui()
	const fqdn = offer?.fqdn ?? ''
	const firstYear = offer ? money(offer.priceCents, offer.currency) : ''
	const perYear = offer ? money(offer.renewalCents, offer.currency) : ''
	const buy = useDomainFetcher({
		silent: true,
		onSuccess: (result) => {
			onStarted(String(result.jobId))
			onClose()
		},
	})
	return (
		<Dialog open={offer !== null} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						<Trans>Buy {fqdn}</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Your business is the registered owner. The registry emails the
							owner address; click its link to keep the domain.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<buy.Form method="POST" className="space-y-4">
					<input type="hidden" name="intent" value="buy-domain" />
					<input type="hidden" name="fqdn" value={offer?.fqdn ?? ''} />
					<input
						type="hidden"
						name="acceptedPriceCents"
						value={offer?.priceCents ?? 0}
					/>
					<ContactFields />
					{offer ? (
						<p className="text-sm">
							<Trans>
								You will be charged {firstYear} now on the card on file, then{' '}
								{perYear} a year. Privacy protection is on and auto-renew is on
								by default.
							</Trans>
						</p>
					) : null}
					{buy.result && !buy.result.ok ? (
						<p className="text-destructive text-sm">
							{errorMessage(buy.result.error, _)}
							{buy.result.error === 'price_changed' && buy.result.detail
								? ` ${money(Number((buy.result.detail as { priceCents: number }).priceCents))}`
								: ''}
						</p>
					) : null}
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={onClose}>
							<Trans>Cancel</Trans>
						</Button>
						<Button type="submit" disabled={buy.busy}>
							<Trans>Pay and register</Trans>
						</Button>
					</DialogFooter>
				</buy.Form>
			</DialogContent>
		</Dialog>
	)
}

export function BuyCard({
	registrar,
	jobs,
	canUpdate,
}: {
	registrar: DomainOverview['registrar']
	jobs: DomainOverview['jobs']
	canUpdate: boolean
}) {
	const { _ } = useLingui()
	const search = useDomainFetcher({ silent: true })
	const transfer = useDomainFetcher({ success: msg`Transfer started` })
	const [offer, setOffer] = useState<DomainOffer | null>(null)
	const [started, setStarted] = useState<string[]>([])
	const [showTransfer, setShowTransfer] = useState(false)
	if (!registrar.enabled || !canUpdate) return null

	const found = search.result?.ok
		? (search.result as unknown as {
				results: DomainOffer[]
				suggestions: DomainOffer[]
			})
		: null
	const liveJobs = jobs.filter((job) => job.kind === 'register')

	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Get a domain</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Buy a domain here and your site is live on it with a certificate, no
						DNS steps. Paid with the card on file; WHOIS privacy included.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{!registrar.configured ? (
					<Alert>
						<Icon name="info" />
						<AlertTitle>
							<Trans>Not set up yet</Trans>
						</AlertTitle>
						<AlertDescription>
							<Trans>
								Buying domains is not connected to a registrar in this
								environment.
							</Trans>
						</AlertDescription>
					</Alert>
				) : (
					<>
						<search.Form
							method="POST"
							className="flex flex-col gap-2 sm:flex-row"
						>
							<input type="hidden" name="intent" value="search-domains" />
							<Input
								name="query"
								placeholder={_(msg`Your restaurant's name`)}
								aria-label={_(msg`Search for a domain`)}
								required
								className="sm:max-w-xs"
							/>
							<Input
								name="city"
								placeholder={_(msg`City (optional)`)}
								aria-label={_(msg`City`)}
								className="sm:max-w-40"
							/>
							<Button type="submit" disabled={search.busy}>
								<Trans>Search</Trans>
							</Button>
						</search.Form>
						{search.result && !search.result.ok ? (
							<p className="text-destructive text-sm">
								{errorMessage(search.result.error, _)}
							</p>
						) : null}
						{found ? (
							<div className="space-y-3">
								{[...found.results, ...found.suggestions].map((entry) => {
									const firstYear = money(entry.priceCents, entry.currency)
									const perYear = money(entry.renewalCents, entry.currency)
									return (
										<div
											key={entry.fqdn}
											className="flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3 text-sm"
										>
											<div className="min-w-0">
												<p className="font-medium break-all">{entry.fqdn}</p>
												<p className="text-muted-foreground text-xs">
													{entry.buyable ? (
														<Trans>
															{firstYear} for the first year, then {perYear}
														</Trans>
													) : entry.premium ? (
														<Trans>A premium name; we do not sell those.</Trans>
													) : (
														<Trans>Already taken</Trans>
													)}
													{entry.suggestion ? (
														<>
															{' '}
															· <Trans>suggestion</Trans>
														</>
													) : null}
												</p>
											</div>
											<Button
												type="button"
												size="sm"
												disabled={!entry.buyable}
												onClick={() => setOffer(entry)}
											>
												<Trans>Buy</Trans>
											</Button>
										</div>
									)
								})}
							</div>
						) : null}
					</>
				)}

				{liveJobs.map((job) => (
					<JobProgress key={job.id} job={job} />
				))}
				{started
					.filter((id) => !liveJobs.some((job) => job.id === id))
					.map((id) => (
						<JobProgress
							key={id}
							job={{
								id,
								kind: 'register',
								status: 'queued',
								step: 'registering',
								error: null,
								fqdn: null,
								refunded: false,
								chargeStatus: null,
								amountCents: null,
							}}
						/>
					))}

				<div className="border-t pt-3">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => setShowTransfer((value) => !value)}
					>
						<Trans>Transfer a domain in</Trans>
					</Button>
					{showTransfer ? (
						<transfer.Form method="POST" className="mt-3 space-y-3">
							<input type="hidden" name="intent" value="transfer-in" />
							<div className="grid gap-3 sm:grid-cols-3">
								<div className="space-y-1">
									<Label htmlFor="transfer-fqdn">
										<Trans>Domain</Trans>
									</Label>
									<Input
										id="transfer-fqdn"
										name="fqdn"
										placeholder="example.com"
										required
									/>
								</div>
								<div className="space-y-1">
									<Label htmlFor="transfer-code">
										<Trans>Authorization code</Trans>
									</Label>
									<Input
										id="transfer-code"
										name="authCode"
										autoComplete="off"
										required
									/>
								</div>
								<div className="space-y-1">
									<Label htmlFor="transfer-price">
										<Trans>Price shown to you (cents)</Trans>
									</Label>
									<Input
										id="transfer-price"
										name="acceptedPriceCents"
										inputMode="numeric"
										defaultValue={registrar.sampleYearlyCents}
										required
									/>
								</div>
							</div>
							<ContactFields />
							<p className="text-muted-foreground text-xs">
								<Trans>
									A transfer adds a year and is charged like one. It fails
									clearly, and refunds, if the domain is locked, the code is
									wrong or it was registered less than 60 days ago. The domain
									keeps its current DNS until you let Menuza manage it.
								</Trans>
							</p>
							{transfer.result && !transfer.result.ok ? (
								<p className="text-destructive text-sm">
									{errorMessage(transfer.result.error, _)}
								</p>
							) : null}
							<Button type="submit" disabled={transfer.busy}>
								<Trans>Start transfer</Trans>
							</Button>
						</transfer.Form>
					) : null}
				</div>

				<BuyDialog
					offer={offer}
					onClose={() => setOffer(null)}
					onStarted={(jobId) => setStarted((previous) => [...previous, jobId])}
				/>
			</CardContent>
		</Card>
	)
}
