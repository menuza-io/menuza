import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { formatRating } from '@repo/common/customer-app'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import {
	accountCheckTitle,
	accountStepText,
} from '#app/utils/customer-apps/alerts.ts'
import { type CustomerAppView } from '#app/utils/customer-apps/view.server.ts'

/**
 * Settings, Customer app (#156): read-only for the restaurant. Store links,
 * status, version and rating per store with when they were last read (a store
 * that could not be reached shows its last known numbers), whether the app
 * needs a new build after a data region change, and the developer account
 * checks when the restaurant publishes under its own account. Staff manage the
 * app in Admin.
 */
export function CustomerAppCard({ view }: { view: CustomerAppView }) {
	const { _, i18n } = useLingui()
	const storeName = (store: 'app_store' | 'play_store') =>
		store === 'app_store' ? _(msg`App Store`) : _(msg`Google Play`)
	const statusLabel = (status: 'live' | 'removed' | 'unknown') =>
		status === 'live'
			? _(msg`Live`)
			: status === 'removed'
				? _(msg`Removed`)
				: _(msg`Not live yet`)
	const failing = (view.accountChecks ?? []).filter((c) => c.status !== 'pass')

	return (
		<Card data-testid="customer-app-card">
			<CardHeader>
				<CardTitle>
					<Trans>Customer app</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Your branded app for guests. Our team builds and publishes it, so
						this page only shows its status.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div className="flex flex-wrap items-center gap-2">
					<span className="font-medium">{view.displayName}</span>
					<Badge variant="outline">{view.marketingVersion}</Badge>
					{view.status === 'archived' ? (
						<Badge variant="secondary">
							<Trans>Archived</Trans>
						</Badge>
					) : null}
				</div>

				{view.rebuildRequired ? (
					<Alert>
						<AlertTitle>
							<Trans>A new build is needed</Trans>
						</AlertTitle>
						<AlertDescription>
							<Trans>
								Your data region changed, so the app must be built again to
								reach the new region. Our team will take care of it.
							</Trans>
						</AlertDescription>
					</Alert>
				) : null}

				<ul className="flex flex-col gap-3">
					{view.stores.map((store) => (
						<li
							key={store.store}
							className="border-border flex flex-col gap-1 rounded-md border p-3"
						>
							<div className="flex flex-wrap items-center gap-2">
								<span className="font-medium">{storeName(store.store)}</span>
								<Badge
									variant={store.status === 'live' ? 'success' : 'outline'}
								>
									{statusLabel(store.status)}
								</Badge>
							</div>
							<div className="text-muted-foreground text-sm">
								{store.version ? (
									<span>
										<Trans>Version {store.version}</Trans>
									</span>
								) : null}
								{formatRating(store.ratingX100) ? (
									<span className="ms-3">
										<Trans>
											{formatRating(store.ratingX100)} stars from{' '}
											{store.ratingCount} ratings
										</Trans>
									</span>
								) : null}
							</div>
							{store.lastCheckedAt ? (
								<div className="text-muted-foreground text-xs">
									<Trans>
										Last checked{' '}
										{i18n.date(new Date(store.lastCheckedAt), {
											dateStyle: 'medium',
											timeStyle: 'short',
										})}
									</Trans>
									{store.lastError ? (
										<span className="ms-2">
											<Trans>
												The store could not be reached; this is the last known
												state.
											</Trans>
										</span>
									) : null}
								</div>
							) : null}
							{store.url ? (
								<a
									className="text-primary text-sm underline"
									href={store.url}
									target="_blank"
									rel="noreferrer"
								>
									<Trans>Open the store page</Trans>
								</a>
							) : null}
						</li>
					))}
				</ul>

				{view.accountChecks !== null ? (
					<div className="flex flex-col gap-2">
						<h3 className="text-sm font-medium">
							<Trans>Developer account</Trans>
						</h3>
						{view.accountChecks.length === 0 ? (
							<p className="text-muted-foreground text-sm">
								<Trans>Nothing has been checked yet.</Trans>
							</p>
						) : null}
						<ul className="flex flex-col gap-2">
							{view.accountChecks.map((check) => (
								<li key={check.kind} className="flex flex-col gap-1 text-sm">
									<div className="flex items-center gap-2">
										<Badge
											variant={
												check.status === 'pass'
													? 'success'
													: check.status === 'warn'
														? 'warning'
														: 'destructive'
											}
										>
											{check.status === 'pass'
												? _(msg`Pass`)
												: check.status === 'warn'
													? _(msg`Warning`)
													: _(msg`Fail`)}
										</Badge>
										<span>{accountCheckTitle(check.kind, _)}</span>
									</div>
									{check.steps.length > 0 ? (
										<ol className="text-muted-foreground ms-6 list-decimal">
											{check.steps.map((step) => (
												<li key={step}>{accountStepText(step, _)}</li>
											))}
										</ol>
									) : null}
								</li>
							))}
						</ul>
						{failing.length === 0 && view.accountChecks.length > 0 ? (
							<p className="text-muted-foreground text-sm">
								<Trans>Everything looks good.</Trans>
							</p>
						) : null}
					</div>
				) : null}
			</CardContent>
		</Card>
	)
}
