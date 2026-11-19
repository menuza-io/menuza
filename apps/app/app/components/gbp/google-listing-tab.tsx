import { Trans } from '@lingui/react/macro'
import { GBP_SYNC_FIELDS, type GbpSyncField } from '@repo/common/gbp-listing'
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
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Switch } from '@repo/ui/switch'
import { Textarea } from '@repo/ui/textarea'
import { useEffect, useState } from 'react'
import { Link, useFetcher } from 'react-router'

type GbpTabLoaderData = {
	enabled: boolean
	linked: boolean
	flags: {
		sync: boolean
		write: boolean
		insights: boolean
	}
	sync?: {
		id: string
		googleLocationName: string
		state: string
		syncEnabled: boolean
		fieldsSynced: GbpSyncField[]
		verificationState: string
		verificationMethod: string | null
		verificationDestination: string | null
		verificationRequestedAt: string | null
		verificationCheckedAt: string | null
		verificationOptions: Array<{
			method: string
			destination?: string | null
		}>
		lastPushedAt: string | null
		lastPulledAt: string | null
		lastError: string | null
		lastErrorAt: string | null
		menuSyncEnabled: boolean
		menuPublishedAt: string | null
		menuPublishResult: {
			at: string
			status: string
			dishes: number
			sections: number
			skipped: Array<{ name: string; reason: string }>
			error?: string
		} | null
		orderLinksCheckedAt: string | null
		metricsBackfilledAt: string | null
		metricsFetchedAt: string | null
	}
	issues?: Array<{
		id: string
		field: string
		kind: string
		status: string
		menuzaValue: string | null
		googleValue: string | null
		detectedAt: string
	}>
	events?: Array<{
		id: string
		kind: string
		field: string | null
		summary: string
		result: string
		createdAt: string
	}>
	orderLinks?: Array<{
		id: string
		kind: string
		uri: string
		classification: string
		providerName: string | null
		isPreferred: boolean
	}>
	canUndoPreferred?: boolean
	photoRows?: Array<{
		id: string
		mediaAssetId: string
		category: string
		status: string
		error: string | null
	}>
	autoPhotos?: boolean
	mediaAssets?: Array<{
		id: string
		objectKey: string
		altText: string | null
		width: number | null
		height: number | null
	}>
	profile?: {
		available: boolean
		error: string | null
		description: {
			value: string
			status: string | null
			reason: string | null
		}
		openingDate: string | null
		attributes: Array<{
			name: string
			displayName: string
			group: string
			google: boolean | null
			source: 'hand' | 'derived' | 'none'
			value: boolean | null
			status: string | null
			reason: string | null
		}>
		suggestions: Array<{
			attribute: string
			current: boolean | null
			suggested: boolean
		}>
		descriptionMax: number
	} | null
}

type ActionData = {
	ok?: boolean
	intent?: string
	error?: string
	description?: string
	profile?: GbpTabLoaderData['profile']
}

const FIELD_LABELS: Record<GbpSyncField, string> = {
	hours: 'Hours',
	specialHours: 'Holiday & special hours',
	phone: 'Phone number',
	openState: 'Open / temporarily closed status',
	website: 'Website URL',
	links: 'Menu, ordering & booking links',
	attributes: 'Dining & service attributes',
}

function formatDateTime(value: string | null | undefined) {
	if (!value) return null
	const date = new Date(value)
	if (Number.isNaN(date.getTime())) return null
	return date.toLocaleString()
}

function stateBadgeVariant(
	state: string,
): 'default' | 'secondary' | 'destructive' | 'outline' {
	if (state === 'ok' || state === 'verified') return 'default'
	if (
		state === 'suspended' ||
		state === 'access_lost' ||
		state === 'duplicate'
	) {
		return 'destructive'
	}
	return 'secondary'
}

export function GoogleListingTab({
	orgSlug,
	locationId,
}: {
	orgSlug: string
	locationId: string
}) {
	const endpoint = `/${orgSlug}/settings/locations/${locationId}/google`
	const loaderFetcher = useFetcher<GbpTabLoaderData>()
	const actionFetcher = useFetcher<ActionData>()

	const [pin, setPin] = useState('')
	const [showPinForm, setShowPinForm] = useState(false)
	const [confirmPreferredOpen, setConfirmPreferredOpen] = useState(false)
	const [confirmUnlinkOpen, setConfirmUnlinkOpen] = useState(false)

	// Profile editing state
	const [profileLoaded, setProfileLoaded] =
		useState<GbpTabLoaderData['profile']>(null)
	const [descriptionDraft, setDescriptionDraft] = useState('')
	const [openingDateDraft, setOpeningDateDraft] = useState('')
	const [attributeDrafts, setAttributeDrafts] = useState<
		Record<string, boolean | null>
	>({})

	// Photo selection state
	const [selectedDishIds, setSelectedDishIds] = useState<string[]>([])
	const [selectedCoverId, setSelectedCoverId] = useState<string>('')
	const [selectedLogoId, setSelectedLogoId] = useState<string>('')

	useEffect(() => {
		void loaderFetcher.load(endpoint)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [endpoint])

	const data = loaderFetcher.data
	const sync = data?.sync

	// Hydrate photo selection from loaded rows
	useEffect(() => {
		if (!data?.photoRows) return
		setSelectedDishIds(
			data.photoRows
				.filter((r) => r.category === 'FOOD_AND_DRINK')
				.map((r) => r.mediaAssetId),
		)
		setSelectedCoverId(
			data.photoRows.find((r) => r.category === 'COVER')?.mediaAssetId ?? '',
		)
		setSelectedLogoId(
			data.photoRows.find((r) => r.category === 'PROFILE')?.mediaAssetId ?? '',
		)
	}, [data?.photoRows])

	// React to action responses (reload tab data, hydrate AI draft / loaded profile)
	useEffect(() => {
		const res = actionFetcher.data
		if (!res || actionFetcher.state !== 'idle') return
		if (
			res.intent === 'draft-description' &&
			typeof res.description === 'string'
		) {
			setDescriptionDraft(res.description)
			return
		}
		if (res.intent === 'load-profile' && res.profile) {
			setProfileLoaded(res.profile)
			setDescriptionDraft(res.profile.description.value)
			setOpeningDateDraft(res.profile.openingDate ?? '')
			setAttributeDrafts({})
			return
		}
		if (res.ok) {
			void loaderFetcher.load(endpoint)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [actionFetcher.data, actionFetcher.state])

	const submit = (payload: Record<string, string>) => {
		void actionFetcher.submit(payload, { method: 'POST', action: endpoint })
	}

	const busy = actionFetcher.state !== 'idle'

	if (!data && loaderFetcher.state !== 'idle') {
		return (
			<Card>
				<CardContent className="py-8">
					<p className="text-muted-foreground text-sm">
						<Trans>Loading Google Business Profile…</Trans>
					</p>
				</CardContent>
			</Card>
		)
	}

	if (!data?.enabled) {
		return (
			<Card>
				<CardHeader>
					<CardTitle className="text-base">
						<Trans>Google Business Profile</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Google Business Profile sync is not enabled for this organization.
						</Trans>
					</CardDescription>
				</CardHeader>
			</Card>
		)
	}

	if (!data.linked || !sync) {
		return (
			<Card data-testid="gbp-unlinked-card">
				<CardHeader>
					<CardTitle className="text-base">
						<Trans>Connect Google Business Profile</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Link this location to its Google Business Profile to keep hours,
							order links, menu, and performance metrics in sync.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Button
						render={<Link to={`/${orgSlug}/settings/integrations`} />}
						size="sm"
					>
						<Trans>Connect in Integrations</Trans>
					</Button>
				</CardContent>
			</Card>
		)
	}

	const writeAllowed = data.flags.write
	const verified = sync.verificationState === 'verified'
	const hasPostcardPending =
		sync.verificationState === 'pending' &&
		sync.verificationMethod === 'ADDRESS'

	const toggleField = (field: GbpSyncField, checked: boolean) => {
		const next = checked
			? [...new Set([...sync.fieldsSynced, field])]
			: sync.fieldsSynced.filter((f) => f !== field)
		submit({
			intent: 'save-sync-settings',
			fieldsSyncedJson: JSON.stringify(next),
		})
	}

	return (
		<div className="space-y-6" data-testid="gbp-location-tab">
			{actionFetcher.data?.error ? (
				<div
					role="alert"
					className="bg-destructive/10 border-destructive/20 text-destructive rounded-md border p-3 text-sm"
				>
					{actionFetcher.data.error}
				</div>
			) : null}

			{sync.lastError ? (
				<div
					role="alert"
					className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
				>
					<strong>
						<Trans>Last Google sync notice:</Trans>
					</strong>{' '}
					{sync.lastError}
				</div>
			) : null}

			{/* 1. Status & Verification (#199) */}
			<Card data-testid="gbp-status-card">
				<CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
					<div className="space-y-1">
						<div className="flex flex-wrap items-center gap-2">
							<CardTitle className="text-base">
								<Trans>Google Business Profile Status</Trans>
							</CardTitle>
							<Badge variant={stateBadgeVariant(sync.state)}>
								{sync.state}
							</Badge>
							<Badge variant={stateBadgeVariant(sync.verificationState)}>
								{sync.verificationState}
							</Badge>
						</div>
						<CardDescription>{sync.googleLocationName}</CardDescription>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={busy}
							onClick={() => submit({ intent: 'refresh-all' })}
						>
							<Trans>Refresh from Google</Trans>
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={busy}
							onClick={() => setConfirmUnlinkOpen(true)}
						>
							<Trans>Unlink</Trans>
						</Button>
					</div>
				</CardHeader>
				<CardContent className="space-y-4">
					{hasPostcardPending ? (
						<div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
							<Trans>
								Postcard verification is in progress
								{sync.verificationDestination
									? ` (${sync.verificationDestination})`
									: ''}
								. Automatic edits to Google are paused so your postcard code is
								not invalidated.
							</Trans>
						</div>
					) : null}

					{!verified ? (
						<div className="space-y-3 rounded-md border p-4">
							<div className="text-sm font-medium">
								<Trans>Verify this profile on Google</Trans>
							</div>
							{sync.verificationOptions.length > 0 ? (
								<div className="flex flex-wrap gap-2">
									{sync.verificationOptions.map((option) => (
										<Button
											key={option.method}
											type="button"
											variant="outline"
											size="sm"
											disabled={busy}
											onClick={() =>
												submit({
													intent: 'request-verification',
													method: option.method,
												})
											}
										>
											{option.method}
											{option.destination ? ` (${option.destination})` : ''}
										</Button>
									))}
								</div>
							) : (
								<p className="text-muted-foreground text-xs">
									<Trans>
										Click “Refresh from Google” to check available verification
										methods, or enter a code you already received.
									</Trans>
								</p>
							)}

							<div className="pt-1">
								<Button
									type="button"
									variant="link"
									size="sm"
									className="h-auto px-0"
									onClick={() => setShowPinForm((v) => !v)}
								>
									<Trans>I already have a verification code</Trans>
								</Button>
							</div>

							{showPinForm || sync.verificationState === 'pending' ? (
								<div className="flex flex-wrap items-center gap-2 pt-1">
									<Input
										value={pin}
										onChange={(e) => setPin(e.target.value)}
										placeholder="Enter Google PIN"
										className="w-48"
										aria-label="Verification code"
									/>
									<Button
										type="button"
										size="sm"
										disabled={busy || !pin.trim()}
										onClick={() =>
											submit({
												intent: 'submit-verification-code',
												pin: pin.trim(),
											})
										}
									>
										<Trans>Verify code</Trans>
									</Button>
								</div>
							) : null}
						</div>
					) : null}

					<div className="text-muted-foreground flex flex-wrap gap-x-6 gap-y-1 text-xs">
						{sync.lastPushedAt ? (
							<span>
								<Trans>Last pushed:</Trans> {formatDateTime(sync.lastPushedAt)}
							</span>
						) : null}
						{sync.lastPulledAt ? (
							<span>
								<Trans>Last checked:</Trans> {formatDateTime(sync.lastPulledAt)}
							</span>
						) : null}
					</div>
				</CardContent>
			</Card>

			{/* 2. Listing Sync Settings & Open Differences (#87) */}
			<Card data-testid="gbp-sync-card">
				<CardHeader className="flex flex-row flex-wrap items-center justify-between gap-4">
					<div>
						<CardTitle className="text-base">
							<Trans>Listing Sync</Trans>
						</CardTitle>
						<CardDescription>
							<Trans>
								Choose which fields Menuza pushes to Google when you update this
								location.
							</Trans>
						</CardDescription>
					</div>
					<div className="flex items-center gap-3">
						<div className="flex items-center gap-2">
							<Label htmlFor="gbp-sync-enabled" className="text-sm">
								<Trans>Auto-sync</Trans>
							</Label>
							<Switch
								id="gbp-sync-enabled"
								checked={sync.syncEnabled}
								disabled={busy || !writeAllowed}
								onCheckedChange={(checked) =>
									submit({
										intent: 'save-sync-settings',
										syncEnabled: String(checked),
									})
								}
							/>
						</div>
						<Button
							type="button"
							size="sm"
							disabled={busy || !writeAllowed || !verified}
							onClick={() => submit({ intent: 'push-now' })}
						>
							<Trans>Push now</Trans>
						</Button>
					</div>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="grid gap-2 sm:grid-cols-2">
						{GBP_SYNC_FIELDS.map((field) => {
							const checked = sync.fieldsSynced.includes(field)
							return (
								<div
									key={field}
									className="flex items-center justify-between rounded-md border p-3"
								>
									<Label htmlFor={`gbp-field-${field}`} className="text-sm">
										{FIELD_LABELS[field]}
									</Label>
									<Switch
										id={`gbp-field-${field}`}
										checked={checked}
										disabled={busy || !writeAllowed}
										onCheckedChange={(next) => toggleField(field, next)}
									/>
								</div>
							)
						})}
					</div>

					{data.issues && data.issues.length > 0 ? (
						<div className="space-y-2 pt-2">
							<h4 className="text-sm font-medium">
								<Trans>Differences with Google ({data.issues.length})</Trans>
							</h4>
							{data.issues.map((issue) => (
								<div
									key={issue.id}
									className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
								>
									<div className="space-y-1 text-sm">
										<div className="font-medium capitalize">
											{issue.field} ({issue.kind})
										</div>
										<div className="text-muted-foreground text-xs">
											Menuza: {issue.menuzaValue ?? '—'} · Google:{' '}
											{issue.googleValue ?? '—'}
										</div>
									</div>
									<div className="flex flex-wrap gap-2">
										<Button
											type="button"
											size="sm"
											variant="default"
											disabled={busy || !writeAllowed}
											onClick={() =>
												submit({
													intent: 'resolve-issue',
													issueId: issue.id,
													choice: 'menuza',
												})
											}
										>
											<Trans>Use Menuza</Trans>
										</Button>
										<Button
											type="button"
											size="sm"
											variant="outline"
											disabled={busy}
											onClick={() =>
												submit({
													intent: 'resolve-issue',
													issueId: issue.id,
													choice: 'google',
												})
											}
										>
											<Trans>Use Google</Trans>
										</Button>
										<Button
											type="button"
											size="sm"
											variant="ghost"
											disabled={busy}
											onClick={() =>
												submit({
													intent: 'resolve-issue',
													issueId: issue.id,
													choice: 'ignore',
												})
											}
										>
											<Trans>Ignore</Trans>
										</Button>
									</div>
								</div>
							))}
						</div>
					) : null}
				</CardContent>
			</Card>

			{/* 3. Order & Reserve Links (#284) */}
			<Card data-testid="gbp-order-links-card">
				<CardHeader className="flex flex-row flex-wrap items-center justify-between gap-4">
					<div>
						<CardTitle className="text-base">
							<Trans>Order &amp; Reservation Links</Trans>
						</CardTitle>
						<CardDescription>
							<Trans>
								See who receives orders from your Google profile and make your
								commission-free Menuza ordering link preferred.
							</Trans>
						</CardDescription>
					</div>
					<div className="flex flex-wrap gap-2">
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={busy || !writeAllowed || !verified}
							onClick={() => submit({ intent: 'sync-site-links' })}
						>
							<Trans>Sync links</Trans>
						</Button>
						<Button
							type="button"
							size="sm"
							disabled={busy || !writeAllowed || !verified}
							onClick={() => setConfirmPreferredOpen(true)}
						>
							<Trans>Make Menuza preferred</Trans>
						</Button>
						{data.canUndoPreferred ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={busy}
								onClick={() => submit({ intent: 'undo-preferred' })}
							>
								<Trans>Undo</Trans>
							</Button>
						) : null}
					</div>
				</CardHeader>
				<CardContent>
					{data.orderLinks && data.orderLinks.length > 0 ? (
						<div className="divide-y rounded-md border">
							{data.orderLinks.map((link) => (
								<div
									key={link.id}
									className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm"
								>
									<div className="min-w-0 space-y-0.5">
										<div className="flex items-center gap-2">
											<span className="font-medium capitalize">
												{link.providerName || link.classification}
											</span>
											<Badge variant="outline">{link.kind}</Badge>
											{link.isPreferred ? (
												<Badge variant="default">
													<Trans>Preferred</Trans>
												</Badge>
											) : null}
										</div>
										<div className="text-muted-foreground truncate text-xs">
											{link.uri}
										</div>
									</div>
								</div>
							))}
						</div>
					) : (
						<p className="text-muted-foreground text-sm">
							<Trans>
								No Google order or reservation links detected yet. Click
								“Refresh from Google” or “Sync links”.
							</Trans>
						</p>
					)}
				</CardContent>
			</Card>

			{/* 4. Profile Description, Opening Date & Attributes (#209) */}
			<Card data-testid="gbp-profile-card">
				<CardHeader className="flex flex-row flex-wrap items-center justify-between gap-4">
					<div>
						<CardTitle className="text-base">
							<Trans>Description &amp; Attributes</Trans>
						</CardTitle>
						<CardDescription>
							<Trans>
								Edit your Google business description, opening date, and service
								attributes.
							</Trans>
						</CardDescription>
					</div>
					<div className="flex flex-wrap gap-2">
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={busy}
							onClick={() => submit({ intent: 'load-profile' })}
						>
							{profileLoaded ? (
								<Trans>Reload attributes</Trans>
							) : (
								<Trans>Load profile &amp; attributes</Trans>
							)}
						</Button>
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={busy || !writeAllowed || !verified}
							onClick={() => submit({ intent: 'sync-derived-attributes' })}
						>
							<Trans>Sync Menuza attributes</Trans>
						</Button>
					</div>
				</CardHeader>
				{profileLoaded ? (
					<CardContent className="space-y-4">
						<div className="space-y-2">
							<div className="flex items-center justify-between">
								<Label htmlFor="gbp-description">
									<Trans>Business description</Trans>
								</Label>
								<div className="flex items-center gap-2">
									<span className="text-muted-foreground text-xs">
										{descriptionDraft.length} / {profileLoaded.descriptionMax}
									</span>
									<Button
										type="button"
										variant="outline"
										size="sm"
										disabled={busy}
										onClick={() => submit({ intent: 'draft-description' })}
									>
										<Trans>Draft with AI</Trans>
									</Button>
								</div>
							</div>
							<Textarea
								id="gbp-description"
								rows={3}
								maxLength={profileLoaded.descriptionMax}
								value={descriptionDraft}
								onChange={(e) => setDescriptionDraft(e.target.value)}
							/>
							{profileLoaded.description.reason ? (
								<p className="text-destructive text-xs">
									{profileLoaded.description.reason}
								</p>
							) : null}
						</div>

						<div className="space-y-1">
							<Label htmlFor="gbp-opening-date">
								<Trans>Opening date</Trans>
							</Label>
							<Input
								id="gbp-opening-date"
								type="date"
								value={openingDateDraft}
								onChange={(e) => setOpeningDateDraft(e.target.value)}
								className="w-48"
							/>
						</div>

						{profileLoaded.attributes.length > 0 ? (
							<div className="space-y-2">
								<Label>
									<Trans>Google Attributes</Trans>
								</Label>
								<div className="grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2">
									{profileLoaded.attributes.map((attr) => {
										const currentVal =
											attr.name in attributeDrafts
												? attributeDrafts[attr.name]
												: attr.value
										return (
											<div
												key={attr.name}
												className="flex items-center justify-between gap-2 rounded-md border p-2.5 text-sm"
											>
												<div className="min-w-0">
													<div className="truncate font-medium">
														{attr.displayName}
													</div>
													<div className="text-muted-foreground text-xs">
														{attr.source === 'derived'
															? 'Auto from Menuza'
															: attr.source === 'hand'
																? 'Custom'
																: 'Google'}
													</div>
												</div>
												<Switch
													checked={currentVal === true}
													disabled={busy || !writeAllowed}
													onCheckedChange={(checked) =>
														setAttributeDrafts((prev) => ({
															...prev,
															[attr.name]: checked,
														}))
													}
												/>
											</div>
										)
									})}
								</div>
							</div>
						) : null}

						<Button
							type="button"
							size="sm"
							disabled={busy || !writeAllowed || !verified}
							onClick={() =>
								submit({
									intent: 'save-profile',
									description: descriptionDraft,
									openingDate: openingDateDraft,
									attributesJson: JSON.stringify(attributeDrafts),
								})
							}
						>
							<Trans>Save profile to Google</Trans>
						</Button>
					</CardContent>
				) : null}
			</Card>

			{/* 5. Menu & Photos Sync (#208) */}
			<Card data-testid="gbp-menu-card">
				<CardHeader className="flex flex-row flex-wrap items-center justify-between gap-4">
					<div>
						<CardTitle className="text-base">
							<Trans>Menu &amp; Dish Photos</Trans>
						</CardTitle>
						<CardDescription>
							<Trans>
								Publish your live Menuza menu to Google and automatically upload
								new dish photos (Menuza never deletes existing Google photos).
							</Trans>
						</CardDescription>
					</div>
					<div className="flex flex-wrap items-center gap-3">
						<div className="flex items-center gap-2">
							<Label htmlFor="gbp-menu-sync" className="text-sm">
								<Trans>Publish menu</Trans>
							</Label>
							<Switch
								id="gbp-menu-sync"
								checked={sync.menuSyncEnabled}
								disabled={busy || !writeAllowed || !verified}
								onCheckedChange={(checked) =>
									submit({
										intent: 'set-menu-sync',
										enabled: String(checked),
									})
								}
							/>
						</div>
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={
								busy || !writeAllowed || !verified || !sync.menuSyncEnabled
							}
							onClick={() => submit({ intent: 'publish-menu-now' })}
						>
							<Trans>Publish now</Trans>
						</Button>
					</div>
				</CardHeader>
				<CardContent className="space-y-4">
					{sync.menuPublishResult ? (
						<div className="text-muted-foreground rounded-md border p-3 text-xs">
							<Trans>
								Status: {sync.menuPublishResult.status} ·{' '}
								{sync.menuPublishResult.sections} sections ·{' '}
								{sync.menuPublishResult.dishes} dishes
							</Trans>
							{sync.menuPublishResult.error ? (
								<div className="text-destructive mt-1">
									{sync.menuPublishResult.error}
								</div>
							) : null}
						</div>
					) : null}

					<div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
						<div>
							<Label htmlFor="gbp-auto-photos" className="text-sm">
								<Trans>Automatically add new dish photos</Trans>
							</Label>
							<p className="text-muted-foreground text-xs">
								<Trans>
									Uploads new menu item photos to Google on the hourly sweep.
								</Trans>
							</p>
						</div>
						<div className="flex items-center gap-2">
							<Switch
								id="gbp-auto-photos"
								checked={Boolean(data.autoPhotos)}
								disabled={busy || !writeAllowed}
								onCheckedChange={(checked) =>
									submit({
										intent: 'set-auto-photos',
										enabled: String(checked),
									})
								}
							/>
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={busy || !writeAllowed || !verified}
								onClick={() => submit({ intent: 'sync-photos-now' })}
							>
								<Trans>Sync photos</Trans>
							</Button>
						</div>
					</div>

					{data.mediaAssets && data.mediaAssets.length > 0 ? (
						<div className="space-y-2">
							<div className="flex items-center justify-between">
								<Label className="text-xs">
									<Trans>Selected dish photos ({selectedDishIds.length})</Trans>
								</Label>
								<Button
									type="button"
									size="sm"
									variant="outline"
									disabled={busy || !writeAllowed || !verified}
									onClick={() =>
										submit({
											intent: 'save-photos',
											dishMediaIdsJson: JSON.stringify(selectedDishIds),
											coverMediaId: selectedCoverId,
											logoMediaId: selectedLogoId,
										})
									}
								>
									<Trans>Upload selected photos</Trans>
								</Button>
							</div>
							<div className="grid max-h-48 gap-2 overflow-y-auto sm:grid-cols-2">
								{data.mediaAssets.slice(0, 20).map((asset) => {
									const checked = selectedDishIds.includes(asset.id)
									return (
										<label
											key={asset.id}
											className="flex cursor-pointer items-center gap-2 rounded-md border p-2 text-xs"
										>
											<input
												type="checkbox"
												checked={checked}
												onChange={(e) =>
													setSelectedDishIds((prev) =>
														e.target.checked
															? [...prev, asset.id]
															: prev.filter((id) => id !== asset.id),
													)
												}
											/>
											<span className="truncate">
												{asset.altText || asset.objectKey}
											</span>
										</label>
									)
								})}
							</div>
						</div>
					) : null}
				</CardContent>
			</Card>

			{/* 6. Recent Activity */}
			{data.events && data.events.length > 0 ? (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">
							<Trans>Recent Google Activity</Trans>
						</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="divide-y text-xs">
							{data.events.slice(0, 8).map((ev) => (
								<div
									key={ev.id}
									className="flex flex-wrap items-center justify-between gap-2 py-2"
								>
									<span>{ev.summary}</span>
									<span className="text-muted-foreground">
										{ev.result} · {formatDateTime(ev.createdAt)}
									</span>
								</div>
							))}
						</div>
					</CardContent>
				</Card>
			) : null}

			<AlertDialog
				open={confirmPreferredOpen}
				onOpenChange={setConfirmPreferredOpen}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Make Menuza your preferred order link?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								Google will highlight your direct Menuza ordering page first.
								Existing delivery-app links stay listed and you can undo this
								change at any time.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								setConfirmPreferredOpen(false)
								submit({
									intent: 'make-menuza-preferred',
									kindsJson: JSON.stringify(['order', 'reservation']),
								})
							}}
						>
							<Trans>Make preferred</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<AlertDialog open={confirmUnlinkOpen} onOpenChange={setConfirmUnlinkOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Unlink Google Business Profile?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								Menuza will stop syncing hours, links, and menu updates to this
								Google profile. Your Google listing itself will not be deleted.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								setConfirmUnlinkOpen(false)
								submit({ intent: 'unlink-google' })
							}}
						>
							<Trans>Unlink</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}
