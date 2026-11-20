import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
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
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { useState } from 'react'
import { type DomainOverview } from '#app/utils/domains/overview.server.ts'
import { CopyValue, errorMessage, useDomainFetcher } from './domain-ui.tsx'
import { ForwardingPanel } from './forwarding-panel.tsx'
import { RecordsPanel } from './records-panel.tsx'
import { RegisteredPanel } from './registered-panel.tsx'

/**
 * A domain Menuza manages (#283, #183): its nameserver status, its DNS
 * records, its registration if we sold it, and email forwarding. One zone
 * model, so all of it sits under one card per domain.
 */

type ManagedView = DomainOverview['managed'][number]

function download(filename: string, text: string) {
	const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
	const link = document.createElement('a')
	link.href = url
	link.download = filename
	link.click()
	URL.revokeObjectURL(url)
}

function ManagedDomainCard({
	domain,
	canUpdate,
}: {
	domain: ManagedView
	canUpdate: boolean
}) {
	const { _ } = useLingui()
	const checker = useDomainFetcher({ silent: false })
	const leaver = useDomainFetcher({
		success: msg`Menuza no longer manages this domain`,
		onSuccess: (result) =>
			download(
				`${String(result.domain)}.zone.txt`,
				String(result.zoneFile ?? ''),
			),
	})
	const [confirmLeave, setConfirmLeave] = useState(false)
	const registered = domain.source !== 'nameservers'
	const state = checker.result?.ok ? String(checker.result.state) : null
	const nsLive = domain.zoneStatus === 'active' || state === 'verified'
	const fqdn = domain.fqdn
	const siteList = domain.sites.join(', ')
	const currentNameservers = Array.isArray(checker.result?.current)
		? (checker.result.current as string[]).join(', ')
		: ''

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex flex-wrap items-center gap-2">
					{domain.fqdn}
					<Badge variant={registered ? 'default' : 'secondary'}>
						{domain.source === 'registered'
							? _(msg`Bought with Menuza`)
							: domain.source === 'transferred'
								? _(msg`Transferred to Menuza`)
								: _(msg`DNS managed by Menuza`)}
					</Badge>
				</CardTitle>
				<CardDescription>
					{domain.sites.length > 0 ? (
						<Trans>Serves {siteList}.</Trans>
					) : (
						<Trans>Not used by your site.</Trans>
					)}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-6">
				{domain.zoneStatus !== 'none' ? (
					<div className="space-y-3">
						<div className="flex flex-wrap items-center gap-2">
							<p className="text-sm font-medium">
								<Trans>Nameservers</Trans>
							</p>
							<Badge variant={nsLive ? 'success' : 'warning'}>
								{nsLive
									? _(msg`Using Menuza's nameservers`)
									: _(msg`Waiting for your registrar`)}
							</Badge>
						</div>
						{!nsLive ? (
							<>
								<p className="text-muted-foreground text-sm">
									<Trans>
										Set these at your registrar. Your site stays on the old
										setup until we see them. We check every 15 minutes.
									</Trans>
								</p>
								<div className="space-y-1">
									{domain.nameservers.map((ns) => (
										<CopyValue key={ns} value={ns} />
									))}
								</div>
								{state === 'wrong_place' ? (
									<Alert variant="destructive">
										<Icon name="alert-triangle" />
										<AlertTitle>
											<Trans>Nameservers changed at the wrong place</Trans>
										</AlertTitle>
										<AlertDescription>
											<Trans>
												Your registrar still points at {currentNameservers}.
												Change the nameservers where the domain is registered,
												not at your DNS host.
											</Trans>
										</AlertDescription>
									</Alert>
								) : null}
								{canUpdate && domain.zoneStatus !== 'none' ? (
									<checker.Form method="POST">
										<input
											type="hidden"
											name="intent"
											value="check-nameservers"
										/>
										<input
											type="hidden"
											name="managedDomainId"
											value={domain.id}
										/>
										<Button
											type="submit"
											variant="outline"
											size="sm"
											disabled={checker.busy}
										>
											<Icon name="refresh-cw" className="me-1.5 size-3.5" />
											<Trans>Check nameservers</Trans>
										</Button>
									</checker.Form>
								) : null}
							</>
						) : null}
						{checker.result && !checker.result.ok ? (
							<p className="text-destructive text-sm">
								{errorMessage(checker.result.error, _)}
							</p>
						) : null}
					</div>
				) : null}

				{registered ? (
					<RegisteredPanel domain={domain} canUpdate={canUpdate} />
				) : null}
				{domain.zoneStatus !== 'none' ? (
					<RecordsPanel domain={domain} canUpdate={canUpdate} />
				) : null}
				<ForwardingPanel domain={domain} canUpdate={canUpdate} />

				{canUpdate && !registered ? (
					<div className="border-t pt-4">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => setConfirmLeave(true)}
						>
							<Trans>Stop managing this domain</Trans>
						</Button>
						{leaver.result && !leaver.result.ok ? (
							<p className="text-destructive mt-2 text-sm">
								{errorMessage(leaver.result.error, _)}
							</p>
						) : null}
						<AlertDialog open={confirmLeave} onOpenChange={setConfirmLeave}>
							<AlertDialogContent>
								<AlertDialogHeader>
									<AlertDialogTitle>
										<Trans>Stop managing {fqdn}?</Trans>
									</AlertDialogTitle>
									<AlertDialogDescription>
										<Trans>
											We download the zone file for you and switch the domain's
											hosts back to the CNAME method. Point the nameservers back
											at your old DNS host and add the records from the
											checklist, or your site goes offline.
										</Trans>
									</AlertDialogDescription>
								</AlertDialogHeader>
								<AlertDialogFooter>
									<AlertDialogCancel>
										<Trans>Keep managing</Trans>
									</AlertDialogCancel>
									<AlertDialogAction
										variant="destructive"
										onClick={() => {
											setConfirmLeave(false)
											leaver.submit({
												intent: 'leave-zone',
												managedDomainId: domain.id,
											})
										}}
									>
										<Trans>Download zone and stop</Trans>
									</AlertDialogAction>
								</AlertDialogFooter>
							</AlertDialogContent>
						</AlertDialog>
					</div>
				) : null}
			</CardContent>
		</Card>
	)
}

export function ManagedDomainCards({
	managed,
	canUpdate,
}: {
	managed: DomainOverview['managed']
	canUpdate: boolean
}) {
	return (
		<>
			{managed.map((domain) => (
				<ManagedDomainCard
					key={domain.id}
					domain={domain}
					canUpdate={canUpdate}
				/>
			))}
		</>
	)
}

/** Forwarding explained for domains whose DNS is elsewhere. */
export function UnmanagedForwardingNote({ domains }: { domains: string[] }) {
	if (domains.length === 0) return null
	const list = domains.join(', ')
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Email forwarding</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Forwarding mail from addresses like info@yourdomain to your own
						inbox is not available for {list}: their DNS is managed somewhere
						else, and forwarding needs Menuza to run it. Let Menuza manage the
						domain, or get a domain here, to turn it on.
					</Trans>
				</CardDescription>
			</CardHeader>
		</Card>
	)
}
