import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
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
import { type SiteDomainView } from '#app/utils/domains/site-domains.server.ts'
import { CopyValue, RecordStatus, useDomainFetcher } from './domain-ui.tsx'

/**
 * The hosts the site is served on (#139): the primary, the extra ones that
 * redirect to it, each with the records it needs and whether each was found.
 */

function HostChecklist({ domain }: { domain: SiteDomainView }) {
	const { _ } = useLingui()
	const describeAlternative = (type: string) =>
		_(msg`No ALIAS or CNAME at the root? Use ${type} records:`)
	const describeCurrent = (values: string[]) => {
		const list = values.join(', ')
		return _(msg`Now: ${list}`)
	}
	return (
		<div className="overflow-x-auto rounded-lg border">
			<table className="w-full text-sm">
				<thead className="bg-muted text-muted-foreground text-xs">
					<tr>
						<th className="px-3 py-2 text-start font-medium">
							<Trans>Type</Trans>
						</th>
						<th className="px-3 py-2 text-start font-medium">
							<Trans>Name</Trans>
						</th>
						<th className="px-3 py-2 text-start font-medium">
							<Trans>Value</Trans>
						</th>
						<th className="px-3 py-2 text-start font-medium">
							<Trans>Status</Trans>
						</th>
					</tr>
				</thead>
				<tbody>
					{domain.records.map((record) => {
						const result = domain.results.find(
							(entry) => entry.id === record.id,
						)
						return (
							<tr key={record.id} className="border-t align-top">
								<td className="px-3 py-2 font-mono text-xs">
									{record.type}
									{record.optional ? (
										<span className="text-muted-foreground block font-sans">
											<Trans>optional</Trans>
										</span>
									) : null}
								</td>
								<td className="px-3 py-2">
									<CopyValue value={record.name} />
								</td>
								<td className="space-y-1 px-3 py-2">
									<CopyValue value={record.value} />
									{record.alternatives?.map((alt) => (
										<p key={alt.type} className="text-muted-foreground text-xs">
											{describeAlternative(alt.type)} {alt.values.join(', ')}
										</p>
									))}
									{result?.current?.length ? (
										<p className="text-muted-foreground text-xs">
											{describeCurrent(result.current)}
										</p>
									) : null}
								</td>
								<td className="px-3 py-2">
									<RecordStatus check={result?.check} />
								</td>
							</tr>
						)
					})}
				</tbody>
			</table>
		</div>
	)
}

function HostRow({
	domain,
	primary,
	canUpdate,
}: {
	domain: SiteDomainView
	primary: string | null
	canUpdate: boolean
}) {
	const { _ } = useLingui()
	const hostname = domain.hostname
	const daysLeft = domain.expiresInDays ?? 0
	const certificate = domain.sslStatus ?? _(msg`not started`)
	const ownership =
		domain.ownershipStatus === 'verified' ? _(msg`confirmed`) : _(msg`pending`)
	const lastChecked = domain.lastCheckedAt
		? new Date(domain.lastCheckedAt).toLocaleString()
		: ''
	const [open, setOpen] = useState(!domain.live)
	const [confirmRemove, setConfirmRemove] = useState(false)
	const checker = useDomainFetcher({ success: msg`Checked`, silent: false })
	const mutator = useDomainFetcher({})
	const busy = checker.busy || mutator.busy
	const pendingText =
		domain.status === 'expired'
			? _(msg`Expired`)
			: domain.live
				? _(msg`Live`)
				: domain.status === 'active'
					? _(msg`Certificate pending`)
					: _(msg`Waiting for DNS`)

	return (
		<div className="space-y-3 rounded-xl border p-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<a
						href={`https://${domain.hostname}`}
						target="_blank"
						rel="noreferrer"
						className="text-primary text-sm font-medium break-all underline-offset-2 hover:underline"
					>
						{domain.hostname}
					</a>
					{domain.isPrimary ? (
						<Badge variant="default">
							<Trans>Primary</Trans>
						</Badge>
					) : (
						<Badge variant="secondary">
							<Trans>Redirects to {primary}</Trans>
						</Badge>
					)}
					<Badge
						variant={
							domain.live
								? 'success'
								: domain.status === 'expired'
									? 'destructive'
									: 'warning'
						}
					>
						{pendingText}
					</Badge>
				</div>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() => setOpen((value) => !value)}
				>
					{open ? <Trans>Hide records</Trans> : <Trans>Show records</Trans>}
				</Button>
			</div>

			<div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
				<span>
					<Trans>Ownership: {ownership}</Trans>
				</span>
				<span>
					<Trans>Certificate: {certificate}</Trans>
				</span>
				{domain.lastCheckedAt ? (
					<span>
						<Trans>Last checked {lastChecked}</Trans>
					</span>
				) : null}
			</div>

			{domain.expiresInDays !== null && domain.expiresInDays <= 23 ? (
				<p className="text-warning text-sm">
					<Trans>
						Still not connected. We release it in {daysLeft} days if the records
						stay missing.
					</Trans>
				</p>
			) : null}
			{domain.lastError ? (
				<p className="text-destructive text-xs">{domain.lastError}</p>
			) : null}

			{open && domain.status !== 'expired' ? (
				<HostChecklist domain={domain} />
			) : null}

			{canUpdate ? (
				<div className="flex flex-wrap gap-2">
					{domain.status === 'expired' ? (
						<mutator.Form method="POST">
							<input type="hidden" name="intent" value="retry-domain" />
							<input type="hidden" name="hostname" value={domain.hostname} />
							<Button type="submit" size="sm" disabled={busy}>
								<Trans>Try again</Trans>
							</Button>
						</mutator.Form>
					) : (
						<>
							<checker.Form method="POST">
								<input type="hidden" name="intent" value="check-domain" />
								<input type="hidden" name="hostname" value={domain.hostname} />
								<Button
									type="submit"
									variant="outline"
									size="sm"
									disabled={busy}
								>
									<Icon name="refresh-cw" className="me-1.5 size-3.5" />
									<Trans>Check now</Trans>
								</Button>
							</checker.Form>
							{!domain.live ? (
								<checker.Form method="POST">
									<input
										type="hidden"
										name="intent"
										value="check-certificate"
									/>
									<input
										type="hidden"
										name="hostname"
										value={domain.hostname}
									/>
									<Button
										type="submit"
										variant="outline"
										size="sm"
										disabled={busy}
									>
										<Icon name="shield-check" className="me-1.5 size-3.5" />
										<Trans>Check certificate again</Trans>
									</Button>
								</checker.Form>
							) : null}
						</>
					)}
					{!domain.isPrimary && domain.status !== 'expired' ? (
						<mutator.Form method="POST">
							<input type="hidden" name="intent" value="set-primary" />
							<input type="hidden" name="hostname" value={domain.hostname} />
							<Button type="submit" variant="outline" size="sm" disabled={busy}>
								<Trans>Make primary</Trans>
							</Button>
						</mutator.Form>
					) : null}
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={busy}
						onClick={() => setConfirmRemove(true)}
					>
						<Icon name="trash-2" className="me-1.5 size-3.5" />
						<Trans>Remove</Trans>
					</Button>
				</div>
			) : null}

			<AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Remove {hostname}?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								It stops serving your site at once and becomes free for others
								to connect.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Keep it</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								setConfirmRemove(false)
								mutator.submit({
									intent: 'remove-domain',
									hostname: domain.hostname,
								})
							}}
						>
							<Trans>Remove domain</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}

export function SiteDomainsCard({
	siteDomains,
	canUpdate,
	justConnected,
}: {
	siteDomains: SiteDomainView[]
	canUpdate: boolean
	justConnected: boolean
}) {
	const all = useDomainFetcher({ success: msg`Checked` })
	const disconnect = useDomainFetcher({})
	const [confirmAll, setConfirmAll] = useState(false)
	const primary =
		siteDomains.find((domain) => domain.isPrimary)?.hostname ?? null
	if (siteDomains.length === 0) return null
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Your domains</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Visitors reach your site on the primary domain. The other forms and
						extra domains redirect to it, keeping the page they asked for.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				{justConnected ? (
					<p className="text-sm">
						<Trans>
							Your registrar sent you back. We are checking the records now.
						</Trans>
					</p>
				) : null}
				{siteDomains.map((domain) => (
					<HostRow
						key={domain.id}
						domain={domain}
						primary={primary}
						canUpdate={canUpdate}
					/>
				))}
				{canUpdate ? (
					<div className="flex flex-wrap gap-2">
						<all.Form method="POST">
							<input type="hidden" name="intent" value="check-domain" />
							<Button
								type="submit"
								variant="outline"
								size="sm"
								disabled={all.busy}
							>
								<Icon name="refresh-cw" className="me-1.5 size-3.5" />
								<Trans>Check all</Trans>
							</Button>
						</all.Form>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => setConfirmAll(true)}
						>
							<Trans>Disconnect all domains</Trans>
						</Button>
					</div>
				) : null}
				<p className="text-muted-foreground text-xs">
					<Trans>
						We check pending domains every 15 minutes and email you when one
						goes live.
					</Trans>
				</p>
				<AlertDialog open={confirmAll} onOpenChange={setConfirmAll}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>
								<Trans>Disconnect every domain?</Trans>
							</AlertDialogTitle>
							<AlertDialogDescription>
								<Trans>Your site goes back to its Menuza address.</Trans>
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>
								<Trans>Keep them</Trans>
							</AlertDialogCancel>
							<AlertDialogAction
								variant="destructive"
								onClick={() => {
									setConfirmAll(false)
									disconnect.submit({ intent: 'disconnect-all' })
								}}
							>
								<Trans>Disconnect all</Trans>
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</CardContent>
		</Card>
	)
}
