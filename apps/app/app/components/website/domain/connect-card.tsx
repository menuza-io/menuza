import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { buildHostChecklist } from '@repo/common/domain-dns'
import { getDomainProvider } from '@repo/common/domain-providers'
import { buildProviderSteps } from '@repo/common/domain-steps'
import {
	describeHostname,
	hostsForConnect,
	type PrimaryForm,
} from '@repo/common/domains'
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
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { RadioGroup } from '@repo/ui/radio-group'
import { useEffect, useMemo, useState } from 'react'
import { type DomainInspection } from '#app/utils/domains/inspect.server.ts'
import {
	Choice,
	CopyValue,
	errorMessage,
	useDomainFetcher,
	type ActionResult,
} from './domain-ui.tsx'
import { ProviderSteps } from './provider-steps.tsx'

/**
 * Connecting a domain (#139, #313, #283): look the domain up first, show what
 * we found before anything changes (email, an existing website, another
 * site), then three ways in: add the records yourself (with steps written for
 * the provider), connect automatically (every change shown first), or let
 * Menuza manage the domain (the nameserver move, email records kept).
 */

type Method = 'records' | 'automatic' | 'nameservers'

type ConnectProps = {
	hasPrimary: boolean
	cnameTarget: string
	apexIps: { a: string[]; aaaa: string[] }
	canUpdate: boolean
}

function Inspection({
	inspection,
	onUseApex,
}: {
	inspection: DomainInspection
	onUseApex: (apex: string) => void
}) {
	const { _ } = useLingui()
	const providerName = inspection.detection.dns?.name
	const registrarName = inspection.detection.registrar?.name
	const mailProvider = inspection.mail.provider?.name
	const builderName = inspection.website.builder
	const suggestion = inspection.subdomainSuggestion
	const otherLive = inspection.otherLiveDomain
	return (
		<div className="space-y-3">
			<div className="bg-muted rounded-xl p-4 text-sm">
				{providerName ? (
					<p>
						<Trans>
							Your DNS is managed at <strong>{providerName}</strong>.
						</Trans>
					</p>
				) : (
					<p>
						<Trans>
							We could not tell where your DNS is managed, so the steps are
							generic.
						</Trans>
					</p>
				)}
				{registrarName ? (
					<p className="text-muted-foreground">
						<Trans>The domain is registered at {registrarName}.</Trans>
					</p>
				) : null}
				<p className="text-muted-foreground">
					{inspection.setup === 'simple' ? (
						<Trans>The simple setup fits: let Menuza manage this domain.</Trans>
					) : (
						<Trans>
							Adding the records yourself is the safer fit for this domain.
						</Trans>
					)}
				</p>
			</div>

			{inspection.takenByOther ? (
				<Alert variant="destructive">
					<Icon name="alert-triangle" />
					<AlertTitle>
						<Trans>Already connected to another restaurant</Trans>
					</AlertTitle>
					<AlertDescription>
						<Trans>
							This domain belongs to another Menuza site, so it cannot be
							connected here.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}

			{inspection.warnings.includes('mail') ||
			inspection.warnings.includes('mail_records_only') ? (
				<Alert>
					<Icon name="mail" />
					<AlertTitle>
						{inspection.mail.kind === 'mail' ? (
							<Trans>This domain receives email</Trans>
						) : (
							<Trans>This domain has email records</Trans>
						)}
					</AlertTitle>
					<AlertDescription>
						<p>
							{inspection.mail.provider ? (
								<Trans>
									Email looks hosted at {mailProvider}. A wrong change could
									stop it. Nothing is changed until you confirm, and these
									records must stay:
								</Trans>
							) : (
								<Trans>
									A wrong change could stop email from arriving. Nothing is
									changed until you confirm, and these records must stay:
								</Trans>
							)}
						</p>
						<ul className="space-y-1 text-xs">
							{inspection.mail.recordsToKeep.slice(0, 12).map((record) => (
								<li
									key={`${record.type}-${record.name}-${record.value}`}
									className="font-mono break-all"
								>
									{record.type} {record.name}{' '}
									{record.priority !== undefined ? `${record.priority} ` : ''}
									{record.value}
								</li>
							))}
						</ul>
					</AlertDescription>
				</Alert>
			) : null}

			{inspection.warnings.includes('website') ? (
				<Alert>
					<Icon name="globe" />
					<AlertTitle>
						<Trans>A website already answers on this domain</Trans>
					</AlertTitle>
					<AlertDescription>
						{inspection.website.builder ? (
							<Trans>
								It looks like a {builderName} site. It stops working once this
								domain points at your Menuza site.
							</Trans>
						) : (
							<Trans>
								It stops working once this domain points at your Menuza site.
							</Trans>
						)}
					</AlertDescription>
				</Alert>
			) : null}

			{inspection.subdomainSuggestion ? (
				<Alert>
					<Icon name="info" />
					<AlertTitle>
						<Trans>That is a subdomain</Trans>
					</AlertTitle>
					<AlertDescription>
						<p>
							<Trans>
								Did you mean the main domain, {suggestion}? Connecting a
								subdomain only connects that one address.
							</Trans>
						</p>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => onUseApex(inspection.subdomainSuggestion!)}
						>
							<Trans>Use {suggestion}</Trans>
						</Button>
					</AlertDescription>
				</Alert>
			) : null}

			{inspection.acmeLeftovers.length > 0 ? (
				<Alert>
					<Icon name="alert-triangle" />
					<AlertTitle>
						<Trans>A certificate record is left over</Trans>
					</AlertTitle>
					<AlertDescription>
						<p>
							<Trans>
								A previous provider left a record that can block our
								certificate. Remove it:
							</Trans>
						</p>
						{inspection.acmeLeftovers.map((line) => (
							<p key={line} className="font-mono text-xs break-all">
								{line}
							</p>
						))}
					</AlertDescription>
				</Alert>
			) : null}

			{inspection.otherLiveDomain ? (
				<Alert>
					<Icon name="info" />
					<AlertTitle>
						<Trans>You already have a live domain</Trans>
					</AlertTitle>
					<AlertDescription>
						<Trans>
							{otherLive} is live. Two domains for one restaurant can hurt
							search ranking: add this one as an extra domain that redirects,
							rather than a second site.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}

			{inspection.alreadyConnected ? (
				<p className="text-muted-foreground text-sm">
					{_(msg`This domain is already connected here. It is listed above.`)}
				</p>
			) : null}
		</div>
	)
}

function NameserverMove({
	hostname,
	primaryForm,
	inspection,
}: {
	hostname: string
	primaryForm: PrimaryForm
	inspection: DomainInspection
}) {
	const { _ } = useLingui()
	const registrarLabel =
		inspection.detection.registrar?.name ??
		inspection.detection.dns?.name ??
		_(msg`your registrar`)
	const scanner = useDomainFetcher({})
	const connector = useDomainFetcher({})
	const [zoneFile, setZoneFile] = useState('')
	const [typed, setTyped] = useState('')
	const scan = scanner.result?.ok
		? (scanner.result.scan as {
				emailSafety: 'none' | 'captured' | 'attention'
				records: unknown[]
				mail: { kind: string; provider: { name: string } | null }
				zoneFile: {
					used: boolean
					errors: Array<{ line: number; message: string }>
					recordCount: number
				}
			})
		: null
	const moved = connector.result?.ok
		? (connector.result as ActionResult & { nameservers?: string[] })
		: null
	const needsWords = scan?.emailSafety === 'attention'
	const recordCount = scan?.records.length ?? 0
	const unreadLines = scan?.zoneFile.errors.length ?? 0

	if (moved?.nameservers) {
		return (
			<div className="space-y-3">
				<Alert>
					<Icon name="check-circle" />
					<AlertTitle>
						<Trans>The zone is ready. One step left at your registrar.</Trans>
					</AlertTitle>
					<AlertDescription>
						<Trans>
							Your site stays on the old setup until your registrar uses these
							nameservers. We check every 15 minutes and email you when it is
							live.
						</Trans>
					</AlertDescription>
				</Alert>
				<ol className="space-y-2 text-sm">
					<li>
						<Trans>Open the nameserver settings of {registrarLabel}.</Trans>
					</li>
					<li>
						<Trans>
							Choose custom nameservers and replace the current ones with:
						</Trans>
					</li>
				</ol>
				<div className="space-y-1">
					{moved.nameservers.map((ns) => (
						<CopyValue key={ns} value={ns} />
					))}
				</div>
			</div>
		)
	}

	return (
		<div className="space-y-3">
			<p className="text-muted-foreground text-sm">
				<Trans>
					We scan the domain first (website, MX, SPF, DKIM, DMARC). Upload the
					zone file from your registrar to be sure nothing is missed.
				</Trans>
			</p>
			<div className="space-y-1.5">
				<Label htmlFor="zone-file">
					<Trans>Zone file (optional)</Trans>
				</Label>
				<Input
					id="zone-file"
					type="file"
					accept=".txt,.zone,.bind,text/plain"
					onChange={(event) => {
						const file = event.target.files?.[0]
						if (!file) return setZoneFile('')
						if (file.size > 400_000) return
						void file.text().then(setZoneFile)
					}}
				/>
			</div>
			<Button
				type="button"
				variant="outline"
				disabled={scanner.busy}
				onClick={() =>
					scanner.submit({
						intent: 'scan-domain',
						hostname,
						...(zoneFile ? { zoneFile } : {}),
					})
				}
			>
				<Trans>Scan this domain</Trans>
			</Button>
			{scanner.result && !scanner.result.ok ? (
				<p className="text-destructive text-sm">
					{errorMessage(scanner.result.error, _)}
				</p>
			) : null}
			{scan ? (
				<div className="space-y-2">
					<Badge
						variant={scan.emailSafety === 'attention' ? 'warning' : 'success'}
					>
						{scan.emailSafety === 'attention' ? (
							<Trans>Email may need attention</Trans>
						) : (
							<Trans>Website safe, email safe</Trans>
						)}
					</Badge>
					<p className="text-muted-foreground text-sm">
						<Trans>
							We found {recordCount} records and will copy them to the new zone.
						</Trans>
					</p>
					{scan.zoneFile.errors.length > 0 ? (
						<p className="text-warning text-xs">
							<Trans>{unreadLines} lines of the file could not be read.</Trans>
						</p>
					) : null}
					{needsWords ? (
						<div className="space-y-1.5">
							<p className="text-sm">
								<Trans>
									This domain has email records we cannot be sure to have
									captured. If one is missed, email can stop. Type the domain to
									go on anyway, or upload the zone file above and scan again.
								</Trans>
							</p>
							<Input
								value={typed}
								onChange={(event) => setTyped(event.target.value)}
								placeholder={inspection.apex}
								aria-label={_(msg`Type the domain to confirm`)}
							/>
						</div>
					) : null}
				</div>
			) : null}
			<connector.Form method="POST" className="space-y-2">
				<input type="hidden" name="intent" value="connect-nameservers" />
				<input type="hidden" name="hostname" value={hostname} />
				<input type="hidden" name="primaryForm" value={primaryForm} />
				<input type="hidden" name="zoneFile" value={zoneFile} />
				<input type="hidden" name="emailConfirmation" value={typed} />
				<Button
					type="submit"
					disabled={
						connector.busy || !scan || (needsWords && typed.trim() === '')
					}
				>
					<Trans>Let Menuza manage this domain</Trans>
				</Button>
			</connector.Form>
			{connector.result && !connector.result.ok ? (
				<p className="text-destructive text-sm">
					{errorMessage(connector.result.error, _)}
				</p>
			) : null}
		</div>
	)
}

function AutomaticConnect({
	hostname,
	primaryForm,
	providerName,
}: {
	hostname: string
	primaryForm: PrimaryForm
	providerName: string
}) {
	const { _ } = useLingui()
	const planner = useDomainFetcher({ silent: true })
	const approver = useDomainFetcher({})
	const plan = planner.result?.ok
		? (planner.result.plan as {
				changes: Array<{ type: string; name: string; content: string }>
				rootSkipped: boolean
			})
		: null
	const redirect = approver.result?.ok
		? (approver.result.redirect as string | undefined)
		: undefined
	useEffect(() => {
		if (redirect) window.location.assign(redirect)
	}, [redirect])

	return (
		<div className="space-y-3">
			<p className="text-muted-foreground text-sm">
				<Trans>
					We set the records at {providerName} after you approve them here. We
					never change email records.
				</Trans>
			</p>
			{!plan ? (
				<Button
					type="button"
					variant="outline"
					disabled={planner.busy}
					onClick={() =>
						planner.submit({
							intent: 'plan-auto-connect',
							hostname,
							primaryForm,
						})
					}
				>
					<Trans>Show the changes</Trans>
				</Button>
			) : (
				<div className="space-y-2">
					<p className="text-sm font-medium">
						<Trans>These records will be added:</Trans>
					</p>
					<ul className="space-y-1">
						{plan.changes.map((change) => (
							<li
								key={`${change.type}-${change.name}-${change.content}`}
								className="font-mono text-xs break-all"
							>
								{change.type} {change.name} → {change.content}
							</li>
						))}
					</ul>
					{plan.rootSkipped ? (
						<p className="text-warning text-xs">
							<Trans>
								The root domain needs an ALIAS record your provider does not
								offer, so it is left out. Only www is set up.
							</Trans>
						</p>
					) : null}
					<approver.Form method="POST">
						<input type="hidden" name="intent" value="approve-auto-connect" />
						<input type="hidden" name="hostname" value={hostname} />
						<input type="hidden" name="primaryForm" value={primaryForm} />
						<Button type="submit" disabled={approver.busy}>
							<Trans>Approve and connect</Trans>
						</Button>
					</approver.Form>
				</div>
			)}
			{planner.result && !planner.result.ok ? (
				<p className="text-destructive text-sm">
					{errorMessage(planner.result.error, _)}
				</p>
			) : null}
		</div>
	)
}

export function ConnectCard({
	hasPrimary,
	cnameTarget,
	apexIps,
	canUpdate,
}: ConnectProps) {
	const { _ } = useLingui()
	const inspector = useDomainFetcher({ silent: true })
	const adder = useDomainFetcher({ success: msg`Domain added` })
	const sender = useDomainFetcher({ success: msg`Steps sent` })
	const [hostname, setHostname] = useState('')
	const [primaryForm, setPrimaryForm] = useState<PrimaryForm>('www')
	const [method, setMethod] = useState<Method>('records')
	const [showSender, setShowSender] = useState(false)

	const inspection = inspector.result?.ok
		? (inspector.result.inspection as DomainInspection)
		: null
	useEffect(() => {
		if (inspection)
			setMethod(
				inspection.setup === 'simple' && inspection.canManageNameservers
					? 'nameservers'
					: 'records',
			)
	}, [inspection])

	const hosts = useMemo(
		() =>
			inspection ? hostsForConnect(inspection.hostname, primaryForm) : null,
		[inspection, primaryForm],
	)
	const provider = getDomainProvider(inspection?.detection.stepsProviderId)
	const steps = useMemo(() => {
		if (!inspection || !hosts) return []
		const records = [hosts.primary, ...hosts.redirects].flatMap((host) =>
			buildHostChecklist({
				hostname: host,
				role: describeHostname(host)?.role ?? 'subdomain',
				cnameTarget,
				apexIps,
			}),
		)
		return buildProviderSteps(provider, records, inspection.apex)
	}, [inspection, hosts, provider, cnameTarget, apexIps])

	if (!canUpdate) return null
	const mode = hasPrimary ? 'redirect' : 'primary'
	const blocked = Boolean(inspection?.takenByOther)
	const apex = inspection?.apex ?? ''
	const autoProvider = inspection?.autoConnect?.providerName ?? ''

	return (
		<Card>
			<CardHeader>
				<CardTitle>
					{hasPrimary ? (
						<Trans>Add another domain</Trans>
					) : (
						<Trans>Connect your domain</Trans>
					)}
				</CardTitle>
				<CardDescription>
					{hasPrimary ? (
						<Trans>Extra domains redirect to your primary domain.</Trans>
					) : (
						<Trans>
							We set up both example.com and www.example.com. Pick the one
							visitors should see; the other redirects to it.
						</Trans>
					)}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<inspector.Form
					method="POST"
					className="flex flex-col gap-2 sm:flex-row"
				>
					<input type="hidden" name="intent" value="inspect-domain" />
					<Input
						name="hostname"
						value={hostname}
						onChange={(event) => setHostname(event.target.value)}
						placeholder="example.com"
						autoComplete="off"
						aria-label={_(msg`Domain`)}
						className="sm:max-w-sm"
					/>
					<Button
						type="submit"
						disabled={inspector.busy || hostname.trim() === ''}
					>
						<Trans>Check domain</Trans>
					</Button>
				</inspector.Form>
				{inspector.result && !inspector.result.ok ? (
					<p className="text-destructive text-sm">
						{errorMessage(inspector.result.error, _)}
					</p>
				) : null}

				{inspection ? (
					<>
						<Inspection
							inspection={inspection}
							onUseApex={(apex) => {
								setHostname(apex)
								inspector.submit({ intent: 'inspect-domain', hostname: apex })
							}}
						/>

						{!blocked && !inspection.alreadyConnected ? (
							<>
								{inspection.role !== 'subdomain' ? (
									<div className="space-y-2">
										<p className="text-sm font-medium">
											{hasPrimary ? (
												<Trans>Which form should visitors see?</Trans>
											) : (
												<Trans>Primary form</Trans>
											)}
										</p>
										<RadioGroup
											value={primaryForm}
											onValueChange={(value) =>
												setPrimaryForm(value as PrimaryForm)
											}
											className="grid gap-2 sm:grid-cols-2"
										>
											<Choice
												value="www"
												title={`www.${inspection.apex}`}
												description={_(msg`${apex} redirects here with a 301.`)}
											/>
											<Choice
												value="apex"
												title={inspection.apex}
												description={_(
													msg`www.${apex} redirects here with a 301.`,
												)}
											/>
										</RadioGroup>
									</div>
								) : null}

								<div className="space-y-2">
									<p className="text-sm font-medium">
										<Trans>How do you want to connect it?</Trans>
									</p>
									<RadioGroup
										value={method}
										onValueChange={(value) => setMethod(value as Method)}
										className="grid gap-2"
									>
										{inspection.canManageNameservers && !hasPrimary ? (
											<Choice
												value="nameservers"
												title={_(
													msg`Let Menuza manage this domain (recommended)`,
												)}
												description={_(
													msg`Works for the root and www, renews certificates by itself, and keeps your email records.`,
												)}
											/>
										) : null}
										{inspection.autoConnect ? (
											<Choice
												value="automatic"
												title={_(msg`Connect automatically`)}
												description={_(
													msg`Sets the records at ${autoProvider} after you approve each change.`,
												)}
											/>
										) : null}
										<Choice
											value="records"
											title={_(msg`I'll add records myself`)}
											description={_(
												msg`Steps written for your provider, with every value ready to copy.`,
											)}
										/>
									</RadioGroup>
								</div>

								{method === 'nameservers' &&
								inspection.canManageNameservers &&
								!hasPrimary ? (
									<NameserverMove
										hostname={inspection.hostname}
										primaryForm={primaryForm}
										inspection={inspection}
									/>
								) : null}
								{method === 'automatic' && inspection.autoConnect ? (
									<AutomaticConnect
										hostname={inspection.hostname}
										primaryForm={primaryForm}
										providerName={inspection.autoConnect.providerName}
									/>
								) : null}
								{method === 'records' ||
								(method === 'nameservers' &&
									(hasPrimary || !inspection.canManageNameservers)) ? (
									<div className="space-y-4">
										<ProviderSteps steps={steps} _={_} />
										<div className="flex flex-wrap gap-2">
											<adder.Form method="POST">
												<input type="hidden" name="intent" value="add-domain" />
												<input
													type="hidden"
													name="hostname"
													value={inspection.hostname}
												/>
												<input
													type="hidden"
													name="primaryForm"
													value={primaryForm}
												/>
												<input type="hidden" name="mode" value={mode} />
												<Button type="submit" disabled={adder.busy}>
													<Trans>Connect domain</Trans>
												</Button>
											</adder.Form>
											<Button
												type="button"
												variant="outline"
												onClick={() => setShowSender((value) => !value)}
											>
												<Icon name="send" className="me-1.5 size-3.5" />
												<Trans>Send these steps to someone else</Trans>
											</Button>
										</div>
										{adder.result && !adder.result.ok ? (
											<p className="text-destructive text-sm">
												{errorMessage(adder.result.error, _)}
											</p>
										) : null}
										{showSender ? (
											<sender.Form
												method="POST"
												className="flex flex-col gap-2 sm:flex-row"
											>
												<input
													type="hidden"
													name="intent"
													value="send-instructions"
												/>
												<input
													type="hidden"
													name="hostname"
													value={inspection.hostname}
												/>
												<input
													type="hidden"
													name="primaryForm"
													value={primaryForm}
												/>
												<Input
													name="to"
													type="email"
													placeholder={_(msg`their@email.com`)}
													aria-label={_(msg`Their email address`)}
													className="sm:max-w-xs"
													required
												/>
												<Button type="submit" disabled={sender.busy}>
													<Trans>Send</Trans>
												</Button>
											</sender.Form>
										) : null}
										{sender.result && !sender.result.ok ? (
											<p className="text-destructive text-sm">
												{errorMessage(sender.result.error, _)}
											</p>
										) : null}
									</div>
								) : null}
							</>
						) : null}
					</>
				) : null}
			</CardContent>
		</Card>
	)
}
