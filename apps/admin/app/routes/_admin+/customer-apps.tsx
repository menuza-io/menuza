import { type MessageDescriptor } from '@lingui/core'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { formatRating } from '@repo/common/customer-app'
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
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useId, useState } from 'react'
import { Link, useFetcher, useLoaderData } from 'react-router'
import {
	type CustomerAppAdminResult,
	action,
	listLoader as loader,
} from './customer-apps.server.ts'

export { action, loader }

export function resultMessage(
	result: CustomerAppAdminResult | undefined,
	_: (descriptor: MessageDescriptor) => string,
): string | null {
	if (!result || result.ok) return null
	switch (result.code) {
		case 'site_not_published':
			return _(msg`Publish the organization’s website first.`)
		case 'bundle_id_taken':
			return _(msg`This iOS bundle id is already used by another app.`)
		case 'package_taken':
			return _(msg`This Android package is already used by another app.`)
		case 'app_exists':
			return _(msg`This organization already has an app.`)
		case 'identifiers_locked':
			return _(msg`Bundle ids cannot change after the app was published.`)
		case 'already_published':
			return _(
				msg`This app was published, so it cannot be deleted. Archive it instead.`,
			)
		case 'archived':
			return _(msg`Archived apps cannot be built.`)
		case 'invalid_store_url':
			return _(msg`That is not a valid store link.`)
		case 'invalid_release':
			return _(msg`Use a release name such as 1.2.0-1.`)
		case 'invalid':
			return _(msg`Check the values and try again.`)
		case 'app_unreachable':
			return _(msg`The App did not answer.`)
		case 'app_not_configured':
			return _(msg`APP_URL or INTERNAL_COMMAND_TOKEN is not set.`)
		default:
			return result.message
	}
}

function StatusBadge({ status }: { status: string }) {
	const { _ } = useLingui()
	const label =
		status === 'succeeded'
			? _(msg`Succeeded`)
			: status === 'failed'
				? _(msg`Failed`)
				: status === 'running'
					? _(msg`Running`)
					: status === 'queued'
						? _(msg`Queued`)
						: _(msg`Cancelled`)
	return (
		<Badge
			variant={
				status === 'succeeded'
					? 'success'
					: status === 'failed'
						? 'destructive'
						: 'outline'
			}
		>
			{label}
		</Badge>
	)
}

function CreateCard({
	candidates,
}: {
	candidates: Array<{ id: string; name: string; slug: string }>
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<CustomerAppAdminResult>()
	const id = useId()
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Create an app</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						The app starts from the organization’s published website: its name,
						icon, colors and site address. You can adjust everything after.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent>
				<fetcher.Form method="post" className="flex flex-wrap items-end gap-3">
					<input type="hidden" name="_action" value="create" />
					<div className="flex flex-col gap-1">
						<Label htmlFor={id}>
							<Trans>Organization</Trans>
						</Label>
						<select
							id={id}
							name="organizationId"
							required
							className="border-input bg-background h-9 min-w-64 rounded-md border px-3 text-sm"
						>
							<option value="">{_(msg`Choose an organization`)}</option>
							{candidates.map((organization) => (
								<option key={organization.id} value={organization.id}>
									{organization.name} ({organization.slug})
								</option>
							))}
						</select>
					</div>
					<Button type="submit" disabled={fetcher.state !== 'idle'}>
						<Trans>Create app</Trans>
					</Button>
				</fetcher.Form>
				{fetcher.data && !fetcher.data.ok ? (
					<p className="text-destructive mt-2 text-sm" role="alert">
						{resultMessage(fetcher.data, _)}
					</p>
				) : null}
				{fetcher.data?.ok && fetcher.data.created ? (
					<p className="mt-2 text-sm">
						<Link
							className="text-primary underline"
							to={`/customer-apps/${fetcher.data.created}`}
						>
							<Trans>Open the new app</Trans>
						</Link>
					</p>
				) : null}
			</CardContent>
		</Card>
	)
}

function ReleaseCard() {
	const { _ } = useLingui()
	const fetcher = useFetcher<CustomerAppAdminResult>()
	const id = useId()
	const result = fetcher.data?.ok ? fetcher.data : null
	const [releaseName, setReleaseName] = useState('')
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Release</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Build every app for a release. Each app is built on its own: one
						failure does not stop the others, and a failed app is retried by
						itself.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				<fetcher.Form method="post" className="flex flex-wrap items-end gap-3">
					<input type="hidden" name="_action" value="release" />
					<div className="flex flex-col gap-1">
						<Label htmlFor={id}>
							<Trans>Release name</Trans>
						</Label>
						<Input
							id={id}
							name="release"
							required
							maxLength={40}
							placeholder="1.2.0-1"
							value={releaseName}
							onChange={(event) => setReleaseName(event.target.value)}
						/>
					</div>
					<Button type="submit" disabled={fetcher.state !== 'idle'}>
						<Trans>Build all apps</Trans>
					</Button>
				</fetcher.Form>
				{fetcher.data && !fetcher.data.ok ? (
					<p className="text-destructive text-sm" role="alert">
						{resultMessage(fetcher.data, _)}
					</p>
				) : null}
				{result?.summary ? (
					<Alert data-testid="release-result">
						<AlertTitle>
							{_(
								msg`${result.summary.succeeded} of ${result.summary.total} apps started`,
							)}
						</AlertTitle>
						<AlertDescription>
							{result.summary.failed > 0 ? (
								<div className="flex flex-col gap-2">
									<ul className="list-disc ps-5">
										{(result.outcomes ?? [])
											.filter((outcome) => !outcome.ok)
											.map((outcome) => (
												<li key={outcome.appId}>
													{outcome.appId}: {outcome.ok ? '' : outcome.message}
												</li>
											))}
									</ul>
									<fetcher.Form method="post">
										<input type="hidden" name="_action" value="retry" />
										<input type="hidden" name="release" value={releaseName} />
										<Button type="submit" size="sm" variant="outline">
											<Trans>Retry the failed apps</Trans>
										</Button>
									</fetcher.Form>
								</div>
							) : (
								<Trans>Every app was started.</Trans>
							)}
						</AlertDescription>
					</Alert>
				) : null}
			</CardContent>
		</Card>
	)
}

export default function CustomerAppsRoute() {
	const { _, i18n } = useLingui()
	const { apps, candidates } = useLoaderData<typeof loader>()
	const storeName = (store: string) =>
		store === 'app_store' ? _(msg`App Store`) : _(msg`Google Play`)
	return (
		<div className="space-y-6">
			<PageHeader
				title={_(msg`Customer apps`)}
				description={_(
					msg`The branded app of each restaurant: bundle ids, builds and store health.`,
				)}
			/>
			<CreateCard candidates={candidates} />
			<ReleaseCard />
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Apps</Trans>
					</CardTitle>
				</CardHeader>
				<CardContent>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{_(msg`Organization`)}</TableHead>
								<TableHead>{_(msg`Bundle ids`)}</TableHead>
								<TableHead>{_(msg`Version`)}</TableHead>
								<TableHead>{_(msg`Latest build`)}</TableHead>
								<TableHead>{_(msg`Stores`)}</TableHead>
								<TableHead />
							</TableRow>
						</TableHeader>
						<TableBody>
							{apps.length === 0 ? (
								<TableRow>
									<TableCell colSpan={6} className="text-muted-foreground">
										<Trans>No apps yet.</Trans>
									</TableCell>
								</TableRow>
							) : null}
							{apps.map((app) => (
								<TableRow key={app.id}>
									<TableCell>
										<div className="font-medium">{app.organization}</div>
										<div className="text-muted-foreground text-xs">
											{app.displayName}
											{app.status === 'archived' ? (
												<Badge variant="secondary" className="ms-2">
													{_(msg`Archived`)}
												</Badge>
											) : null}
										</div>
									</TableCell>
									<TableCell className="text-xs">
										<div>{app.iosBundleId}</div>
										<div className="text-muted-foreground">
											{app.androidPackage}
										</div>
									</TableCell>
									<TableCell>{app.marketingVersion}</TableCell>
									<TableCell>
										{app.latestRelease ? (
											<div className="flex flex-col gap-1">
												<span className="text-xs">{app.latestRelease}</span>
												<div className="flex flex-wrap gap-1">
													{app.latestBuilds.map((build) => (
														<span
															key={build.platform}
															className="flex items-center gap-1"
														>
															<span className="text-muted-foreground text-xs">
																{build.platform === 'ios' ? 'iOS' : 'Android'}
															</span>
															<StatusBadge status={build.status} />
														</span>
													))}
												</div>
											</div>
										) : (
											<span className="text-muted-foreground">—</span>
										)}
										{app.rebuildRequired ? (
											<Badge variant="warning" className="mt-1">
												{_(msg`Rebuild needed`)}
											</Badge>
										) : null}
									</TableCell>
									<TableCell>
										<div className="flex flex-col gap-1">
											{app.stores.map((store) => (
												<div key={store.store} className="text-xs">
													<span className="font-medium">
														{storeName(store.store)}
													</span>{' '}
													<Badge
														variant={
															store.status === 'live' ? 'success' : 'outline'
														}
													>
														{store.status === 'live'
															? _(msg`Live`)
															: store.status === 'removed'
																? _(msg`Removed`)
																: _(msg`Not live`)}
													</Badge>
													{store.version ? ` ${store.version}` : ''}
													{formatRating(store.ratingX100)
														? ` · ${formatRating(store.ratingX100)}★ (${i18n.number(store.ratingCount)})`
														: ''}
												</div>
											))}
											{app.accountProblems > 0 ? (
												<Badge variant="destructive">
													{_(msg`Account needs attention`)}
												</Badge>
											) : null}
										</div>
									</TableCell>
									<TableCell>
										<Button
											size="sm"
											variant="outline"
											render={<Link to={`/customer-apps/${app.id}`} />}
										>
											<Trans>Open</Trans>
										</Button>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</CardContent>
			</Card>
		</div>
	)
}
