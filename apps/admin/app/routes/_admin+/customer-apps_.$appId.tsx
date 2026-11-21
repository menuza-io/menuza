import { type MessageDescriptor } from '@lingui/core'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { formatRating } from '@repo/common/customer-app'
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from '@repo/ui/alert-dialog'
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
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import { Textarea } from '@repo/ui/textarea'
import { useId, useState, type ReactNode } from 'react'
import { Link, useFetcher, useLoaderData } from 'react-router'
import { resultMessage } from './customer-apps.tsx'
import {
	type CustomerAppAdminResult,
	action,
	detailLoader as loader,
} from './customer-apps.server.ts'

export { action, loader }

type Data = ReturnType<typeof useLoaderData<typeof loader>>

const STEP_TEXT: Record<string, MessageDescriptor> = {
	renew_developer_account: msg`Sign in to the developer account that publishes the app and renew the membership.`,
	pay_developer_fee: msg`Pay the annual developer fee with a card that has not expired.`,
	accept_store_terms: msg`Sign in to the store’s developer site and accept the new terms and agreements.`,
	accept_payment_terms: msg`Accept the paid applications and payment terms in the store’s agreements section.`,
	restore_store_access: msg`Invite our access user back to the developer account with the app manager role.`,
}

const CHECK_TITLE: Record<string, MessageDescriptor> = {
	developer_account: msg`Developer account`,
	store_terms: msg`Store terms`,
	payment_terms: msg`Payment terms`,
	store_access: msg`Our access to the store account`,
}

function Field({
	label,
	children,
}: {
	label: string
	children: (id: string) => ReactNode
}) {
	const id = useId()
	return (
		<div className="flex flex-col gap-1">
			<Label htmlFor={id}>{label}</Label>
			{children(id)}
		</div>
	)
}

function Result({ result }: { result: CustomerAppAdminResult | undefined }) {
	const { _ } = useLingui()
	if (!result) return null
	if (!result.ok) {
		return (
			<p className="text-destructive text-sm" role="alert">
				{resultMessage(result, _)}
			</p>
		)
	}
	return (
		<p className="text-muted-foreground text-sm" role="status">
			<Trans>Saved.</Trans>
		</p>
	)
}

function DetailsCard({ app }: { app: Data['app'] }) {
	const { _ } = useLingui()
	const fetcher = useFetcher<CustomerAppAdminResult>()
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Details</Trans>
				</CardTitle>
				<CardDescription>
					{app.locked ? (
						<Trans>
							This app was published, so its bundle ids can no longer change.
						</Trans>
					) : (
						<Trans>Bundle ids are unique across all apps.</Trans>
					)}
				</CardDescription>
			</CardHeader>
			<CardContent>
				<fetcher.Form method="post" className="grid gap-4 md:grid-cols-2">
					<input type="hidden" name="_action" value="update" />
					<input type="hidden" name="appId" value={app.id} />
					<Field label={_(msg`Display name`)}>
						{(id) => (
							<Input
								id={id}
								name="displayName"
								defaultValue={app.displayName}
								maxLength={30}
								required
							/>
						)}
					</Field>
					<Field label={_(msg`Version`)}>
						{(id) => (
							<Input
								id={id}
								name="marketingVersion"
								defaultValue={app.marketingVersion}
							/>
						)}
					</Field>
					<Field label={_(msg`iOS bundle id`)}>
						{(id) => (
							<Input
								id={id}
								name="iosBundleId"
								defaultValue={app.iosBundleId}
								disabled={app.locked}
							/>
						)}
					</Field>
					<Field label={_(msg`Android package`)}>
						{(id) => (
							<Input
								id={id}
								name="androidPackage"
								defaultValue={app.androidPackage}
								disabled={app.locked}
							/>
						)}
					</Field>
					<Field label={_(msg`Icon background`)}>
						{(id) => (
							<Input
								id={id}
								name="iconBackground"
								defaultValue={app.iconBackground}
							/>
						)}
					</Field>
					<Field label={_(msg`Published under`)}>
						{(id) => (
							<select
								id={id}
								name="publisher"
								defaultValue={app.publisher}
								className="border-input bg-background h-9 rounded-md border px-3 text-sm"
							>
								<option value="menuza">{_(msg`Our developer account`)}</option>
								<option value="restaurant">
									{_(msg`The restaurant’s developer account`)}
								</option>
							</select>
						)}
					</Field>
					<Field label={_(msg`Apple team id`)}>
						{(id) => (
							<Input
								id={id}
								name="appleTeamId"
								defaultValue={app.appleTeamId}
								maxLength={10}
							/>
						)}
					</Field>
					<Field label={_(msg`Android signing fingerprints (SHA-256)`)}>
						{(id) => (
							<Input
								id={id}
								name="androidSha256"
								defaultValue={app.androidSha256.join(', ')}
							/>
						)}
					</Field>
					<Field label={_(msg`App Store link`)}>
						{(id) => (
							<Input
								id={id}
								name="appStoreUrl"
								defaultValue={app.storeUrls.app_store ?? ''}
								placeholder="https://apps.apple.com/…"
							/>
						)}
					</Field>
					<Field label={_(msg`Google Play link`)}>
						{(id) => (
							<Input
								id={id}
								name="playStoreUrl"
								defaultValue={app.storeUrls.play_store ?? ''}
								placeholder="https://play.google.com/store/apps/details?id=…"
							/>
						)}
					</Field>
					<Field label={_(msg`Store subtitle`)}>
						{(id) => (
							<Input
								id={id}
								name="subtitle"
								defaultValue={app.listing.subtitle}
								maxLength={80}
							/>
						)}
					</Field>
					<div className="md:col-span-2">
						<Field label={_(msg`Store description`)}>
							{(id) => (
								<Textarea
									id={id}
									name="description"
									rows={4}
									defaultValue={app.listing.description}
									maxLength={4000}
								/>
							)}
						</Field>
					</div>
					<div className="flex items-center gap-3 md:col-span-2">
						<Button type="submit" disabled={fetcher.state !== 'idle'}>
							<Trans>Save</Trans>
						</Button>
						<Result result={fetcher.data} />
					</div>
				</fetcher.Form>
			</CardContent>
		</Card>
	)
}

function CredentialsCard({
	app,
	credentials,
}: {
	app: Data['app']
	credentials: Data['credentials']
}) {
	const { i18n, _ } = useLingui()
	const apns = useFetcher<CustomerAppAdminResult>()
	const fcm = useFetcher<CustomerAppAdminResult>()
	const other = useFetcher<CustomerAppAdminResult>()
	const status = (kind: 'apns' | 'fcm') =>
		credentials.find((c) => c.kind === kind)!
	const label = (kind: 'apns' | 'fcm') =>
		kind === 'apns'
			? _(msg`APNs key (iOS)`)
			: _(msg`Firebase service account (Android)`)
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Push credentials</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Write-only. Once uploaded a credential is stored encrypted and can
						never be read again, only replaced or removed.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-6">
				{(['apns', 'fcm'] as const).map((kind) => {
					const current = status(kind)
					return (
						<div
							key={kind}
							className="flex flex-col gap-2"
							data-testid={`credential-${kind}`}
						>
							<div className="flex flex-wrap items-center gap-2">
								<span className="font-medium">{label(kind)}</span>
								{current.set ? (
									<Badge variant="success">
										{current.uploadedAt
											? _(
													msg`Set on ${i18n.date(new Date(current.uploadedAt), { dateStyle: 'medium' })}`,
												)
											: _(msg`Set`)}
									</Badge>
								) : (
									<Badge variant="outline">{_(msg`Not set`)}</Badge>
								)}
								{current.set ? (
									<>
										<other.Form method="post">
											<input
												type="hidden"
												name="_action"
												value="credential-check"
											/>
											<input type="hidden" name="appId" value={app.id} />
											<input type="hidden" name="kind" value={kind} />
											<Button type="submit" size="sm" variant="ghost">
												<Trans>Check it still works</Trans>
											</Button>
										</other.Form>
										<other.Form method="post">
											<input
												type="hidden"
												name="_action"
												value="credential-remove"
											/>
											<input type="hidden" name="appId" value={app.id} />
											<input type="hidden" name="kind" value={kind} />
											<Button type="submit" size="sm" variant="ghost">
												<Trans>Remove</Trans>
											</Button>
										</other.Form>
									</>
								) : null}
							</div>
							{kind === 'apns' ? (
								<apns.Form method="post" className="grid gap-3 md:grid-cols-2">
									<input type="hidden" name="_action" value="credential-apns" />
									<input type="hidden" name="appId" value={app.id} />
									<Field label={_(msg`Key id`)}>
										{(id) => (
											<Input
												id={id}
												name="keyId"
												autoComplete="off"
												required
												maxLength={20}
											/>
										)}
									</Field>
									<Field label={_(msg`Team id`)}>
										{(id) => (
											<Input
												id={id}
												name="teamId"
												autoComplete="off"
												required
												maxLength={20}
											/>
										)}
									</Field>
									<div className="md:col-span-2">
										<Field label={_(msg`Key file (.p8)`)}>
											{(id) => (
												<Textarea
													id={id}
													name="key"
													rows={4}
													autoComplete="off"
													required
													placeholder="-----BEGIN PRIVATE KEY-----"
												/>
											)}
										</Field>
									</div>
									<div className="flex items-center gap-3 md:col-span-2">
										<Button type="submit" disabled={apns.state !== 'idle'}>
											{current.set ? (
												<Trans>Replace the key</Trans>
											) : (
												<Trans>Upload the key</Trans>
											)}
										</Button>
										<Result result={apns.data} />
									</div>
								</apns.Form>
							) : (
								<fcm.Form method="post" className="flex flex-col gap-3">
									<input type="hidden" name="_action" value="credential-fcm" />
									<input type="hidden" name="appId" value={app.id} />
									<Field label={_(msg`Service account file (JSON)`)}>
										{(id) => (
											<Textarea
												id={id}
												name="serviceAccount"
												rows={4}
												autoComplete="off"
												required
											/>
										)}
									</Field>
									<div className="flex items-center gap-3">
										<Button type="submit" disabled={fcm.state !== 'idle'}>
											{current.set ? (
												<Trans>Replace the file</Trans>
											) : (
												<Trans>Upload the file</Trans>
											)}
										</Button>
										<Result result={fcm.data} />
									</div>
								</fcm.Form>
							)}
						</div>
					)
				})}
				{other.data?.ok && other.data.valid !== undefined ? (
					<p className="text-sm" role="status">
						{other.data.valid ? (
							<Trans>
								The stored credential decrypts and has the right shape.
							</Trans>
						) : (
							<Trans>
								The stored credential is missing or damaged. Upload it again.
							</Trans>
						)}
					</p>
				) : null}
			</CardContent>
		</Card>
	)
}

function BuildsCard({
	app,
	builds,
	rebuildRequired,
}: {
	app: Data['app']
	builds: Data['builds']
	rebuildRequired: boolean
}) {
	const { _, i18n } = useLingui()
	const start = useFetcher<CustomerAppAdminResult>()
	const retry = useFetcher<CustomerAppAdminResult>()
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Builds</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						A build is a recorded job. The pipeline reports its progress back
						here, and nothing is submitted to a store from this page.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{rebuildRequired ? (
					<Alert>
						<AlertTitle>
							<Trans>A new build is required</Trans>
						</AlertTitle>
						<AlertDescription>
							<Trans>
								The organization moved to another data region after the last
								build.
							</Trans>
						</AlertDescription>
					</Alert>
				) : null}
				<start.Form method="post" className="flex flex-wrap items-end gap-3">
					<input type="hidden" name="_action" value="build" />
					<input type="hidden" name="appId" value={app.id} />
					<Field label={_(msg`Release name`)}>
						{(id) => (
							<Input
								id={id}
								name="release"
								required
								maxLength={40}
								placeholder="1.2.0-1"
							/>
						)}
					</Field>
					<Field label={_(msg`Platform`)}>
						{(id) => (
							<select
								id={id}
								name="platform"
								className="border-input bg-background h-9 rounded-md border px-3 text-sm"
							>
								<option value="both">{_(msg`iOS and Android`)}</option>
								<option value="ios">iOS</option>
								<option value="android">Android</option>
							</select>
						)}
					</Field>
					<Button type="submit" disabled={start.state !== 'idle'}>
						<Trans>Start a build</Trans>
					</Button>
				</start.Form>
				<Result result={start.data} />
				<ul className="flex flex-col gap-2">
					{builds.map((build) => (
						<li
							key={build.id}
							className="border-border flex flex-wrap items-center gap-3 rounded-md border p-2 text-sm"
						>
							<span className="font-medium">{build.release}</span>
							<span>{build.platform === 'ios' ? 'iOS' : 'Android'}</span>
							<Badge
								variant={
									build.status === 'succeeded'
										? 'success'
										: build.status === 'failed'
											? 'destructive'
											: 'outline'
								}
							>
								{build.status === 'succeeded'
									? _(msg`Succeeded`)
									: build.status === 'failed'
										? _(msg`Failed`)
										: build.status === 'running'
											? _(msg`Running`)
											: build.status === 'queued'
												? _(msg`Queued`)
												: _(msg`Cancelled`)}
							</Badge>
							<span className="text-muted-foreground text-xs">
								{i18n.date(new Date(build.createdAt), {
									dateStyle: 'medium',
									timeStyle: 'short',
								})}
								{build.attempts > 1
									? ` · ${_(msg`attempt ${build.attempts}`)}`
									: ''}
							</span>
							{build.logUrl ? (
								<a
									className="text-primary underline"
									href={build.logUrl}
									target="_blank"
									rel="noopener noreferrer"
								>
									<Trans>Build log</Trans>
								</a>
							) : null}
							{build.status === 'failed' || build.status === 'cancelled' ? (
								<retry.Form method="post">
									<input type="hidden" name="_action" value="retry" />
									<input type="hidden" name="appId" value={app.id} />
									<input type="hidden" name="release" value={build.release} />
									<Button type="submit" size="sm" variant="outline">
										<Trans>Retry</Trans>
									</Button>
								</retry.Form>
							) : null}
						</li>
					))}
				</ul>
			</CardContent>
		</Card>
	)
}

function StoreHealthCard({ data }: { data: Data }) {
	const { _, i18n } = useLingui()
	const refresh = useFetcher<CustomerAppAdminResult>()
	const [open, setOpen] = useState<Data['reviews'][number] | null>(null)
	const storeName = (store: string) =>
		store === 'app_store' ? _(msg`App Store`) : _(msg`Google Play`)
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Store health</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Read from the stores once a day. A store that cannot be reached
						keeps its last known state.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<ul className="grid gap-3 md:grid-cols-2">
					{data.stores.map((store) => (
						<li
							key={store.store}
							className="border-border rounded-md border p-3 text-sm"
							data-testid={`store-${store.store}`}
						>
							<div className="flex items-center gap-2">
								<span className="font-medium">{storeName(store.store)}</span>
								<Badge
									variant={store.status === 'live' ? 'success' : 'outline'}
								>
									{store.status === 'live'
										? _(msg`Live`)
										: store.status === 'removed'
											? _(msg`Removed`)
											: _(msg`Not live yet`)}
								</Badge>
							</div>
							<div className="text-muted-foreground">
								{store.version ? (
									<Trans>Version {store.version}</Trans>
								) : (
									<Trans>No version yet</Trans>
								)}
								{formatRating(store.ratingX100) ? (
									<span className="ms-3">
										{formatRating(store.ratingX100)}★ (
										{i18n.number(store.ratingCount)})
									</span>
								) : null}
							</div>
							<div className="text-muted-foreground text-xs">
								{store.lastCheckedAt
									? _(
											msg`Last checked ${i18n.date(new Date(store.lastCheckedAt), { dateStyle: 'medium', timeStyle: 'short' })}`,
										)
									: _(msg`Not checked yet`)}
								{store.lastError
									? ` · ${_(msg`could not be reached, showing the last known state`)}`
									: ''}
							</div>
						</li>
					))}
				</ul>
				<refresh.Form method="post">
					<input type="hidden" name="_action" value="refresh-health" />
					<input type="hidden" name="appId" value={data.app.id} />
					<Button
						type="submit"
						variant="outline"
						size="sm"
						disabled={refresh.state !== 'idle'}
					>
						<Trans>Check the stores now</Trans>
					</Button>
				</refresh.Form>

				<div className="flex flex-wrap items-center gap-2">
					<span className="text-sm font-medium">
						<Trans>Latest reviews</Trans>
					</span>
					{[null, 5, 4, 3, 2, 1].map((stars) => (
						<Button
							key={stars ?? 'all'}
							size="sm"
							variant={data.starFilter === stars ? 'default' : 'outline'}
							render={
								<Link to={stars ? `?stars=${stars}` : '?'} preventScrollReset />
							}
						>
							{stars ? `${stars}★` : _(msg`All`)}
						</Button>
					))}
				</div>
				{data.reviews.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>No reviews to show.</Trans>
					</p>
				) : (
					<ul className="flex flex-col gap-2">
						{data.reviews.map((review) => (
							<li key={review.id}>
								<button
									type="button"
									className="border-border hover:bg-muted w-full rounded-md border p-2 text-start text-sm"
									onClick={() => setOpen(review)}
								>
									<span className="font-medium">{review.rating}★</span>{' '}
									<span>{review.title ?? review.body.slice(0, 80)}</span>
									<span className="text-muted-foreground ms-2 text-xs">
										{storeName(review.store)}
									</span>
								</button>
							</li>
						))}
					</ul>
				)}
				<Dialog
					open={open !== null}
					onOpenChange={(next) => !next && setOpen(null)}
				>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>
								{open ? `${open.rating}★ ${open.title ?? ''}` : ''}
							</DialogTitle>
							<DialogDescription>
								{open
									? `${storeName(open.store)} · ${i18n.date(new Date(open.reviewedAt), { dateStyle: 'medium' })}${open.appVersion ? ` · ${open.appVersion}` : ''}`
									: ''}
							</DialogDescription>
						</DialogHeader>
						<p className="text-sm whitespace-pre-wrap">{open?.body}</p>
					</DialogContent>
				</Dialog>
			</CardContent>
		</Card>
	)
}

function AccountCard({ data }: { data: Data }) {
	const { _ } = useLingui()
	const fetcher = useFetcher<CustomerAppAdminResult>()
	const snap = data.snapshot
	const tri = (value: boolean | null | undefined) =>
		value === null || value === undefined ? 'unknown' : value ? 'yes' : 'no'
	const expires = snap?.developerAccountExpiresAt
		? new Date(snap.developerAccountExpiresAt).toISOString().slice(0, 10)
		: ''
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Store account checks</Trans>
				</CardTitle>
				<CardDescription>
					{data.accountChecksVisibleToRestaurant ? (
						<Trans>
							The restaurant publishes under its own account, so it sees these
							checks too.
						</Trans>
					) : (
						<Trans>
							Published under our account: the restaurant does not see these
							checks.
						</Trans>
					)}
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{data.checks.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>Nothing has been recorded yet.</Trans>
					</p>
				) : null}
				<ul className="flex flex-col gap-3">
					{data.checks.map((check) => (
						<li
							key={check.kind}
							className="text-sm"
							data-testid={`check-${check.kind}`}
						>
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
								<span className="font-medium">
									{_(CHECK_TITLE[check.kind]!)}
								</span>
								{check.daysLeft !== null ? (
									<span className="text-muted-foreground">
										{check.daysLeft < 0
											? _(msg`expired`)
											: _(msg`${check.daysLeft} days left`)}
									</span>
								) : null}
							</div>
							{check.steps.length > 0 ? (
								<ol className="text-muted-foreground ms-6 list-decimal">
									{check.steps.map((step) => (
										<li key={step}>{_(STEP_TEXT[step]!)}</li>
									))}
								</ol>
							) : null}
						</li>
					))}
				</ul>
				<fetcher.Form method="post" className="grid gap-3 md:grid-cols-4">
					<input type="hidden" name="_action" value="account" />
					<input type="hidden" name="appId" value={data.app.id} />
					<Field label={_(msg`Developer account expires on`)}>
						{(id) => (
							<Input
								id={id}
								type="date"
								name="expiresOn"
								defaultValue={expires}
							/>
						)}
					</Field>
					{(
						[
							[
								'termsAccepted',
								_(msg`Store terms accepted`),
								snap?.termsAccepted,
							],
							[
								'paymentTermsAccepted',
								_(msg`Payment terms accepted`),
								snap?.paymentTermsAccepted,
							],
							['accessOk', _(msg`Our access works`), snap?.accessOk],
						] as const
					).map(([name, label, value]) => (
						<Field key={name} label={label}>
							{(id) => (
								<select
									id={id}
									name={name}
									defaultValue={tri(value)}
									className="border-input bg-background h-9 rounded-md border px-3 text-sm"
								>
									<option value="unknown">{_(msg`Not checked`)}</option>
									<option value="yes">{_(msg`Yes`)}</option>
									<option value="no">{_(msg`No`)}</option>
								</select>
							)}
						</Field>
					))}
					<div className="flex items-center gap-3 md:col-span-4">
						<Button type="submit" disabled={fetcher.state !== 'idle'}>
							<Trans>Record the account facts</Trans>
						</Button>
						<Result result={fetcher.data} />
					</div>
				</fetcher.Form>
			</CardContent>
		</Card>
	)
}

function DangerCard({ app }: { app: Data['app'] }) {
	const { _ } = useLingui()
	const fetcher = useFetcher<CustomerAppAdminResult>()
	const archived = app.status === 'archived'
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Archive or delete</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						An app can be deleted only before it was first published. After that
						it can be archived: it stops building and disappears from the
						website.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-wrap items-center gap-3">
				<fetcher.Form method="post">
					<input type="hidden" name="_action" value="archive" />
					<input type="hidden" name="appId" value={app.id} />
					<input
						type="hidden"
						name="archived"
						value={archived ? 'false' : 'true'}
					/>
					<Button type="submit" variant="outline">
						{archived ? (
							<Trans>Restore the app</Trans>
						) : (
							<Trans>Archive the app</Trans>
						)}
					</Button>
				</fetcher.Form>
				<AlertDialog>
					<AlertDialogTrigger
						render={<Button variant="destructive" disabled={app.locked} />}
					>
						<Trans>Delete the app</Trans>
					</AlertDialogTrigger>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>
								<Trans>Delete this app?</Trans>
							</AlertDialogTitle>
							<AlertDialogDescription>
								<Trans>
									Its builds and credentials are deleted with it. This cannot be
									undone.
								</Trans>
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>{_(msg`Cancel`)}</AlertDialogCancel>
							<fetcher.Form method="post">
								<input type="hidden" name="_action" value="delete" />
								<input type="hidden" name="appId" value={app.id} />
								<Button type="submit" variant="destructive">
									<Trans>Delete</Trans>
								</Button>
							</fetcher.Form>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
				<Result result={fetcher.data} />
			</CardContent>
		</Card>
	)
}

export default function CustomerAppDetailRoute() {
	const { _ } = useLingui()
	const data = useLoaderData<typeof loader>()
	return (
		<div className="space-y-6">
			<PageHeader
				title={data.app.displayName}
				description={_(
					msg`${data.organization?.name ?? ''} · ${data.app.iosBundleId}`,
				)}
			/>
			<p>
				<Link className="text-primary text-sm underline" to="/customer-apps">
					<Trans>All apps</Trans>
				</Link>
			</p>
			<DetailsCard app={data.app} />
			<CredentialsCard app={data.app} credentials={data.credentials} />
			<BuildsCard
				app={data.app}
				builds={data.builds}
				rebuildRequired={data.rebuildRequired}
			/>
			<StoreHealthCard data={data} />
			<AccountCard data={data} />
			<DangerCard app={data.app} />
		</div>
	)
}
