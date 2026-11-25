import { Plural, Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { getCrossAppUrl } from '@repo/common/url'
import { type MenuDiff } from '@repo/integrations'
import {
	posOwnershipFields,
	type FieldOwner,
	type PosFieldOwnership,
	type PosOwnershipField,
} from '@repo/integrations/pos/ownership'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardFooter, CardHeader } from '@repo/ui/card'
import { Checkbox } from '@repo/ui/checkbox'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from '@repo/ui/sheet'
import { StatusButton } from '@repo/ui/status-button'
import { Switch } from '@repo/ui/switch'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useFetcher, useParams } from 'react-router'

export const connectPosActionIntent = 'connect-pos'
export const disconnectPosActionIntent = 'disconnect-pos'
export const importPosMenuActionIntent = 'import-pos-menu'
export const syncPosMenuActionIntent = 'sync-pos-menu'
export const savePosOwnershipActionIntent = 'save-pos-ownership'
export const retryDeliveryPauseActionIntent = 'retry-delivery-pause'
export const saveStoreSettingsActionIntent = 'save-store-settings'
export const goLiveStoreActionIntent = 'go-live-store'
export const checkDeliveryMenuActionIntent = 'check-delivery-menu'
export const fixDeliveryMenuActionIntent = 'fix-delivery-menu'

export interface PosMenuCheckSummary {
	lastCheckedAt: string | null
	lastAttemptAt: string | null
	lastStatus: 'match' | 'diff' | 'error' | null
	diffCount: number
	posChangedCount: number
	lastError: string | null
	manualChecksToday: number
	manualChecksLimit: number
	diffs: MenuDiff[]
}

export interface PosStoreReadinessReason {
	code: string
	message: string
	href?: string
}

export interface PosStoreReadiness {
	ready: boolean
	managedByPos: boolean
	reasons: PosStoreReadinessReason[]
	stats?: {
		selectedMenuCount: number
		publishedDishCount: number
		zeroPriceCount: number
		missingPhotoCount: number
		missingPhotoRatio: number
		hasAddress: boolean
		hasPhone: boolean
		hasEmail: boolean
	}
}

export interface PosStoreSettings {
	menuIds: string[]
	holidaySync: boolean
	live: boolean
	lastHolidaySyncAt?: string | null
	menuLimit?: number
}

export interface PosIntegration {
	id: string
	providerName: string
	isActive: boolean
	lastSyncAt: string | null
	environment: 'sandbox' | 'live'
	syncFailing?: boolean
	lastSyncError?: string | null
	pausedUntil?: string | null
	pauseOpenEnded?: boolean
	lastPauseError?: string | null
	fieldOwnership?: PosFieldOwnership
	supportedOwnershipFields?: PosOwnershipField[]
	storeSettings?: PosStoreSettings
	readiness?: PosStoreReadiness
	managedByPos?: boolean
	menuCheck?: PosMenuCheckSummary
}

export interface PosProviderOption {
	name: string
	kind: string
	displayName: string
	description: string
	icon: string
	writeMode: string
}

export interface PosMenuOption {
	id: string
	name: string
}

interface SyncHistoryItemCounts {
	created?: number
	updated?: number
	skipped?: number
	pushed?: number
	total?: number
	menuId?: string
	menuName?: string
	entityType?: 'item' | 'modifier_option'
	entityId?: string
	available?: boolean
}

interface SyncHistoryEntry {
	id: string
	action: string
	kind: 'import' | 'push' | 'availability' | 'other'
	status: 'success' | 'error' | 'pending'
	itemCounts: SyncHistoryItemCounts | null
	errorMessage: string | null
	createdAt: string
	retryable: boolean
}

interface SyncHistoryResponse {
	entries: SyncHistoryEntry[]
	page: number
	pageSize: number
	hasMore: boolean
}

interface RetrySyncResponse {
	ok: boolean
	mode?: 'queued' | 'direct'
	error?: string
}

const providerDomains: Record<string, string> = {
	clover: 'clover.com',
	square: 'squareup.com',
	toast: 'toasttab.com',
	ubereats: 'ubereats.com',
	doordash: 'doordash.com',
}

function formatMinorUnits(cents: number | undefined): string {
	if (typeof cents !== 'number' || !Number.isFinite(cents)) return '—'
	return (cents / 100).toFixed(2)
}

function relativeTime(value: string | null) {
	if (!value) return null
	const minutes = Math.max(
		0,
		Math.floor((Date.now() - new Date(value).getTime()) / 60000),
	)
	if (minutes < 1) return t`Just now`
	if (minutes < 60) return `${minutes}m ago`
	return `${Math.floor(minutes / 60)}h ago`
}

function formatPauseTime(iso: string, timeZone: string, locale: string) {
	try {
		return new Intl.DateTimeFormat(locale, {
			timeZone,
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
		}).format(new Date(iso))
	} catch {
		return new Date(iso).toISOString().slice(11, 16)
	}
}

export function PosIntegrationCard({
	provider,
	integration,
	selectedLocationId,
	menus,
	doorDashLiveConfigured,
	posOwnershipEnabled = false,
	deliveryPauseEnabled = false,
	storeSettingsEnabled = false,
	menuCheckEnabled = false,
	locationTimezone = 'UTC',
	canManageIntegrations = true,
	orgSlug = '',
}: {
	provider: PosProviderOption
	integration: PosIntegration | null
	selectedLocationId: string
	menus: PosMenuOption[]
	doorDashLiveConfigured: boolean
	posOwnershipEnabled?: boolean
	deliveryPauseEnabled?: boolean
	storeSettingsEnabled?: boolean
	menuCheckEnabled?: boolean
	locationTimezone?: string
	canManageIntegrations?: boolean
	orgSlug?: string
}) {
	const { _, i18n } = useLingui()
	const params = useParams()
	const fetcher = useFetcher()
	const ownershipFetcher = useFetcher()
	const storeFetcher = useFetcher<{
		ok: boolean
		error?: string
		store?: PosStoreSettings
		readiness?: PosStoreReadiness
	}>()
	const goLiveFetcher = useFetcher<{
		ok: boolean
		error?: string
		reasons?: PosStoreReadinessReason[]
		readiness?: PosStoreReadiness
	}>()
	const historyFetcher = useFetcher<SyncHistoryResponse>()
	const retryFetcher = useFetcher<RetrySyncResponse>()
	const checkFetcher = useFetcher<{
		ok: boolean
		error?: string
		message?: string
	}>()
	const fixFetcher = useFetcher<{
		ok: boolean
		error?: string
	}>()
	const [doorDashStoreId, setDoorDashStoreId] = useState('')
	const [draftOwnership, setDraftOwnership] =
		useState<PosFieldOwnership | null>(integration?.fieldOwnership ?? null)
	const [storeSheetOpen, setStoreSheetOpen] = useState(false)
	const [diffsSheetOpen, setDiffsSheetOpen] = useState(false)
	const [draftMenuIds, setDraftMenuIds] = useState<string[]>(
		integration?.storeSettings?.menuIds ?? [],
	)
	const [draftHolidaySync, setDraftHolidaySync] = useState<boolean>(
		integration?.storeSettings?.holidaySync ?? false,
	)
	const [historyOpen, setHistoryOpen] = useState(false)
	const [failuresOnly, setFailuresOnly] = useState(false)
	const [historyPage, setHistoryPage] = useState(1)
	const lastHandledRetryRef = useRef<RetrySyncResponse | undefined>(undefined)
	const lastHandledFixRef = useRef<{ ok: boolean; error?: string } | undefined>(
		undefined,
	)
	const historyLoadRef = useRef(historyFetcher.load)
	historyLoadRef.current = historyFetcher.load

	const resolvedOrgSlug = orgSlug || params.orgSlug || ''
	const historyEndpoint = integration
		? resolvedOrgSlug
			? `/${resolvedOrgSlug}/settings/integrations/${integration.id}/history`
			: `/settings/integrations/${integration.id}/history`
		: ''

	const loadHistory = useCallback(
		(targetPage: number, targetFailuresOnly: boolean) => {
			if (!historyEndpoint) return
			const query = new URLSearchParams()
			query.set('page', String(targetPage))
			if (targetFailuresOnly) {
				query.set('status', 'error')
			}
			void historyLoadRef.current(`${historyEndpoint}?${query.toString()}`)
		},
		[historyEndpoint],
	)

	useEffect(() => {
		setDraftOwnership(integration?.fieldOwnership ?? null)
	}, [integration?.fieldOwnership])

	useEffect(() => {
		setDraftMenuIds(integration?.storeSettings?.menuIds ?? [])
		setDraftHolidaySync(integration?.storeSettings?.holidaySync ?? false)
	}, [
		integration?.storeSettings?.holidaySync,
		integration?.storeSettings?.menuIds,
	])

	useEffect(() => {
		if (
			retryFetcher.state === 'idle' &&
			retryFetcher.data &&
			retryFetcher.data !== lastHandledRetryRef.current
		) {
			lastHandledRetryRef.current = retryFetcher.data
			if (retryFetcher.data.ok && historyOpen) {
				setHistoryPage(1)
				loadHistory(1, failuresOnly)
			}
		}
	}, [
		failuresOnly,
		historyOpen,
		loadHistory,
		retryFetcher.data,
		retryFetcher.state,
	])

	useEffect(() => {
		if (
			fixFetcher.state === 'idle' &&
			fixFetcher.data &&
			fixFetcher.data !== lastHandledFixRef.current
		) {
			lastHandledFixRef.current = fixFetcher.data
			if (fixFetcher.data.ok) {
				setDiffsSheetOpen(false)
			}
		}
	}, [fixFetcher.data, fixFetcher.state])

	const handleOpenHistory = () => {
		setHistoryOpen(true)
		setHistoryPage(1)
		loadHistory(1, failuresOnly)
	}

	const handleToggleFailuresOnly = () => {
		const next = !failuresOnly
		setFailuresOnly(next)
		setHistoryPage(1)
		loadHistory(1, next)
	}

	const handlePageChange = (nextPage: number) => {
		setHistoryPage(nextPage)
		loadHistory(nextPage, failuresOnly)
	}

	const handleRetryEntry = (logId: string) => {
		if (!historyEndpoint) return
		void retryFetcher.submit(
			{ intent: 'retry', logId },
			{ method: 'POST', action: historyEndpoint },
		)
	}

	const retryingLogId =
		retryFetcher.state !== 'idle'
			? String(retryFetcher.formData?.get('logId') ?? '')
			: null
	const historyData = historyFetcher.data
	const historyEntries = historyData?.entries ?? []
	const isHistoryLoading = historyFetcher.state === 'loading'
	const providerDisplayName = provider.displayName

	const fieldLabel = (field: PosOwnershipField) => {
		switch (field) {
			case 'name':
				return _(t`Name`)
			case 'description':
				return _(t`Description`)
			case 'price':
				return _(t`Price`)
			case 'available':
				return _(t`Availability`)
			case 'category':
				return _(t`Category`)
			case 'modifiers':
				return _(t`Modifiers`)
			case 'photo':
				return _(t`Photo`)
			case 'tax':
				return _(t`Tax`)
		}
	}

	const handleSetOwner = (field: PosOwnershipField, nextOwner: FieldOwner) => {
		if (!integration || !draftOwnership) return
		if (draftOwnership[field] === nextOwner) return
		const next: PosFieldOwnership = { ...draftOwnership, [field]: nextOwner }
		setDraftOwnership(next)
		void ownershipFetcher.submit(
			{
				intent: savePosOwnershipActionIntent,
				integrationId: integration.id,
				organizationLocationId: selectedLocationId,
				fieldOwnership: JSON.stringify(next),
			},
			{ method: 'POST' },
		)
	}
	const needsDoorDashStoreLink =
		provider.name === 'doordash' && doorDashLiveConfigured
	const isConnected = !!integration
	const isProcessing =
		fetcher.state !== 'idle' &&
		(fetcher.formData?.get('integrationId') === integration?.id ||
			fetcher.formData?.get('providerName') === provider.name)
	const isImportOnly = provider.writeMode === 'none'
	const lastSync = integration ? relativeTime(integration.lastSyncAt) : null
	const pauseTime = integration?.pausedUntil
		? formatPauseTime(integration.pausedUntil, locationTimezone, i18n.locale)
		: null
	const documentUrl = getCrossAppUrl('docs', `/integrations/${provider.name}`)

	return (
		<Card
			className="flex h-full flex-col"
			role="group"
			aria-label={provider.displayName}
		>
			<CardHeader className="flex w-full items-start gap-3">
				<div className="relative grid h-10 w-10 shrink-0 place-items-center rounded-md after:absolute after:inset-0 after:h-full after:w-full after:rounded-[inherit] after:ring-1 after:ring-black/8 after:ring-inset dark:after:ring-white/8">
					<Icon name={provider.icon as never} className="h-6 w-6" />
				</div>
				<div className="flex min-w-0 flex-1 flex-col">
					<div className="flex flex-wrap items-center gap-2">
						<h4 className="truncate text-sm font-medium">
							{provider.displayName}
						</h4>
						{isConnected ? (
							<Badge variant="secondary">
								<Trans>Connected</Trans>
							</Badge>
						) : null}
						{isConnected && integration?.syncFailing ? (
							<Badge variant="destructive">
								<Trans>Sync failing</Trans>
							</Badge>
						) : null}
						{deliveryPauseEnabled &&
						isConnected &&
						provider.kind === 'delivery' &&
						(integration?.pauseOpenEnded || integration?.pausedUntil) ? (
							<Badge variant="warning">
								{pauseTime ? (
									<Trans>Paused until {pauseTime}</Trans>
								) : (
									<Trans>Paused until resumed</Trans>
								)}
							</Badge>
						) : null}
						{storeSettingsEnabled &&
						isConnected &&
						provider.kind === 'delivery' &&
						integration?.managedByPos ? (
							<Badge variant="secondary">
								<Trans>Managed by POS</Trans>
							</Badge>
						) : null}
						{storeSettingsEnabled &&
						isConnected &&
						provider.kind === 'delivery' &&
						integration?.storeSettings?.live ? (
							<Badge variant="secondary">
								<Trans>Store live</Trans>
							</Badge>
						) : null}
						{menuCheckEnabled &&
						isConnected &&
						provider.kind === 'delivery' &&
						integration?.menuCheck ? (
							integration.menuCheck.lastError ? (
								<Badge variant="destructive">
									<Trans>Could not check</Trans>
								</Badge>
							) : integration.menuCheck.lastCheckedAt ? (
								integration.menuCheck.diffCount > 0 ? (
									<Badge variant="warning">
										<Plural
											value={integration.menuCheck.diffCount}
											one="# difference"
											other="# differences"
										/>
									</Badge>
								) : integration.menuCheck.posChangedCount > 0 ? (
									<Badge variant="secondary">
										<Trans>Changed in POS</Trans>
									</Badge>
								) : (
									<Badge variant="secondary">
										<Trans>In sync</Trans>
									</Badge>
								)
							) : null
						) : null}
					</div>
					<span className="text-muted-foreground text-xs">
						{providerDomains[provider.name] ?? `${provider.name}.com`}
					</span>
				</div>
			</CardHeader>

			<CardContent className="flex flex-1 flex-col gap-3">
				<p className="text-muted-foreground text-sm leading-5">
					{provider.description}
				</p>

				<div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
					<Badge
						variant={
							integration?.environment === 'live' ? 'secondary' : 'outline'
						}
					>
						{integration?.environment === 'live' ? (
							<Trans>Live</Trans>
						) : (
							<Trans>Sandbox</Trans>
						)}
					</Badge>
					<span>
						{provider.kind === 'delivery' ? (
							<Trans>Delivery</Trans>
						) : (
							<Trans>Point of sale</Trans>
						)}
					</span>
					{isConnected && lastSync ? (
						<span>
							<Trans>Synced {lastSync}</Trans>
						</span>
					) : null}
				</div>

				{isConnected && integration?.syncFailing ? (
					<div
						role="alert"
						className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border px-2.5 py-2 text-xs"
					>
						<p className="font-medium">
							<Trans>Menu updates have been failing for over 24 hours.</Trans>
						</p>
						{integration.lastSyncError ? (
							<p className="text-destructive/80 mt-0.5 wrap-anywhere">
								{integration.lastSyncError}
							</p>
						) : null}
					</div>
				) : null}

				{deliveryPauseEnabled &&
				isConnected &&
				provider.kind === 'delivery' &&
				integration?.lastPauseError ? (
					<div
						role="alert"
						data-error-code="platform_pause_failed"
						className="border-destructive/30 bg-destructive/5 text-destructive space-y-2 rounded-md border px-2.5 py-2 text-xs"
					>
						<p className="font-medium">
							<Trans>Delivery pause update failed</Trans>
						</p>
						<p className="text-destructive/80 wrap-anywhere">
							{integration.lastPauseError}
						</p>
						<fetcher.Form method="POST">
							<input
								type="hidden"
								name="intent"
								value={retryDeliveryPauseActionIntent}
							/>
							<input
								type="hidden"
								name="organizationLocationId"
								value={selectedLocationId}
							/>
							<input
								type="hidden"
								name="integrationId"
								value={integration.id}
							/>
							<Button
								type="submit"
								variant="outline"
								size="sm"
								disabled={isProcessing}
							>
								<Trans>Retry</Trans>
							</Button>
						</fetcher.Form>
					</div>
				) : null}

				<div className="mt-auto pt-2">
					{isConnected && integration ? (
						<div className="flex flex-col gap-3">
							{posOwnershipEnabled &&
							provider.kind === 'pos' &&
							draftOwnership ? (
								<div className="border-border bg-muted/30 space-y-2 rounded-md border p-3">
									<div className="space-y-0.5">
										<h5 className="text-xs font-semibold">
											<Trans>Who owns what</Trans>
										</h5>
										<p className="text-muted-foreground text-[11px]">
											<Trans>
												POS-owned fields are locked in Menuza and updated on
												re-import.
											</Trans>
										</p>
									</div>
									<div className="divide-border/60 divide-y">
										{posOwnershipFields.map((field) => {
											const canOwn =
												integration.supportedOwnershipFields?.includes(field) ??
												false
											const owner = draftOwnership[field]
											const label = fieldLabel(field)
											return (
												<div
													key={field}
													className="flex items-center justify-between gap-2 py-1.5 first:pt-0 last:pb-0"
												>
													<span className="text-xs">{label}</span>
													<div
														role="group"
														aria-label={label}
														className="border-border bg-background inline-flex rounded-md border p-0.5"
													>
														<button
															type="button"
															disabled={
																!canOwn || ownershipFetcher.state !== 'idle'
															}
															aria-pressed={owner === 'pos'}
															onClick={() => handleSetOwner(field, 'pos')}
															className={cn(
																'rounded px-2 py-0.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
																owner === 'pos'
																	? 'bg-primary text-primary-foreground'
																	: 'text-muted-foreground hover:text-foreground',
															)}
														>
															<Trans>POS</Trans>
														</button>
														<button
															type="button"
															disabled={ownershipFetcher.state !== 'idle'}
															aria-pressed={owner === 'menuza'}
															onClick={() => handleSetOwner(field, 'menuza')}
															className={cn(
																'rounded px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-40',
																owner === 'menuza'
																	? 'bg-primary text-primary-foreground'
																	: 'text-muted-foreground hover:text-foreground',
															)}
														>
															<Trans>Menuza</Trans>
														</button>
													</div>
												</div>
											)
										})}
									</div>
								</div>
							) : null}

							<fetcher.Form method="POST">
								<input
									type="hidden"
									name="intent"
									value={importPosMenuActionIntent}
								/>
								<input
									type="hidden"
									name="organizationLocationId"
									value={selectedLocationId}
								/>
								<input
									type="hidden"
									name="integrationId"
									value={integration.id}
								/>
								<Button
									type="submit"
									variant="outline"
									size="sm"
									className="w-full"
									disabled={isProcessing}
								>
									<Trans>Import menu</Trans>
								</Button>
							</fetcher.Form>

							{isImportOnly ? (
								<p className="text-muted-foreground text-xs">
									<Trans>
										This platform is import-only. Menu changes stay here.
									</Trans>
								</p>
							) : menus.length === 0 ? (
								<p className="text-muted-foreground text-xs">
									<Trans>Create a menu to sync it to this platform.</Trans>
								</p>
							) : (
								<div className="flex flex-col gap-1">
									{menus.map((menu) => (
										<fetcher.Form method="POST" key={menu.id}>
											<input
												type="hidden"
												name="intent"
												value={syncPosMenuActionIntent}
											/>
											<input
												type="hidden"
												name="organizationLocationId"
												value={selectedLocationId}
											/>
											<input
												type="hidden"
												name="integrationId"
												value={integration.id}
											/>
											<input type="hidden" name="menuId" value={menu.id} />
											<Button
												type="submit"
												variant="outline"
												size="sm"
												className="w-full justify-between"
												disabled={isProcessing}
											>
												<span className="truncate">
													<Trans>Sync</Trans> {menu.name}
												</span>
												<Icon name="refresh-cw" className="size-3.5" />
											</Button>
										</fetcher.Form>
									))}
								</div>
							)}

							<fetcher.Form method="POST">
								<input
									type="hidden"
									name="intent"
									value={disconnectPosActionIntent}
								/>
								<input
									type="hidden"
									name="organizationLocationId"
									value={selectedLocationId}
								/>
								<input
									type="hidden"
									name="integrationId"
									value={integration.id}
								/>
								<StatusButton
									type="submit"
									variant="ghost"
									size="sm"
									status={isProcessing ? 'pending' : 'idle'}
									className="w-full"
								>
									<Trans>Disconnect</Trans>
								</StatusButton>
							</fetcher.Form>

							{storeSettingsEnabled &&
							provider.kind === 'delivery' &&
							canManageIntegrations ? (
								<Button
									type="button"
									variant="outline"
									size="sm"
									className="w-full"
									onClick={() => setStoreSheetOpen(true)}
								>
									<Icon name="sliders-horizontal" className="size-3.5" />
									<Trans>Store settings</Trans>
								</Button>
							) : null}

							{menuCheckEnabled &&
							provider.kind === 'delivery' &&
							canManageIntegrations ? (
								<div className="flex flex-col gap-2">
									{checkFetcher.data && !checkFetcher.data.ok ? (
										<p
											role="alert"
											className="text-destructive text-xs wrap-anywhere"
										>
											{checkFetcher.data.message ?? checkFetcher.data.error}
										</p>
									) : null}
									<checkFetcher.Form method="POST">
										<input
											type="hidden"
											name="intent"
											value={checkDeliveryMenuActionIntent}
										/>
										<input
											type="hidden"
											name="organizationLocationId"
											value={selectedLocationId}
										/>
										<input
											type="hidden"
											name="integrationId"
											value={integration.id}
										/>
										<Button
											type="submit"
											variant="outline"
											size="sm"
											className="w-full"
											disabled={checkFetcher.state !== 'idle'}
										>
											<Icon name="circle-check" className="size-3.5" />
											<Trans>Check now</Trans>
										</Button>
									</checkFetcher.Form>
									{(integration.menuCheck?.diffs.length ?? 0) > 0 ||
									(integration.menuCheck?.diffCount ?? 0) > 0 ||
									(integration.menuCheck?.posChangedCount ?? 0) > 0 ? (
										<Button
											type="button"
											variant="outline"
											size="sm"
											className="w-full"
											onClick={() => setDiffsSheetOpen(true)}
										>
											<Trans>View differences</Trans>
										</Button>
									) : null}
								</div>
							) : null}

							{canManageIntegrations ? (
								<Button
									type="button"
									variant="outline"
									size="sm"
									className="w-full"
									onClick={handleOpenHistory}
								>
									<Icon name="history" className="size-3.5" />
									<Trans>Sync history</Trans>
								</Button>
							) : null}
						</div>
					) : needsDoorDashStoreLink ? (
						<fetcher.Form method="POST" className="flex flex-col gap-3">
							<input
								type="hidden"
								name="intent"
								value={connectPosActionIntent}
							/>
							<input type="hidden" name="providerName" value={provider.name} />
							<input
								type="hidden"
								name="organizationLocationId"
								value={selectedLocationId}
							/>
							<div className="space-y-1.5">
								<Label htmlFor={`${provider.name}-store-id`}>
									<Trans>DoorDash store ID</Trans>
								</Label>
								<Input
									id={`${provider.name}-store-id`}
									name="doorDashStoreId"
									value={doorDashStoreId}
									onChange={(event) => setDoorDashStoreId(event.target.value)}
									placeholder={t`From DoorDash Portal or onboarding`}
									autoComplete="off"
								/>
								<p className="text-muted-foreground text-xs">
									<Trans>
										One DoorDash store per connection. Use the store id DoorDash
										assigns after onboarding (SSIO or Store Onboarding).
									</Trans>
								</p>
							</div>
							<StatusButton
								type="submit"
								variant="outline"
								size="sm"
								status={isProcessing ? 'pending' : 'idle'}
								className="w-full"
								disabled={!selectedLocationId || !doorDashStoreId.trim()}
							>
								<Trans>Connect</Trans>
							</StatusButton>
						</fetcher.Form>
					) : (
						<fetcher.Form method="POST">
							<input
								type="hidden"
								name="intent"
								value={connectPosActionIntent}
							/>
							<input type="hidden" name="providerName" value={provider.name} />
							<input
								type="hidden"
								name="organizationLocationId"
								value={selectedLocationId}
							/>
							<StatusButton
								type="submit"
								variant="outline"
								size="sm"
								status={isProcessing ? 'pending' : 'idle'}
								className="w-full"
							>
								<Trans>Connect</Trans>
							</StatusButton>
						</fetcher.Form>
					)}
				</div>
			</CardContent>

			<CardFooter className="py-2">
				<a
					href={documentUrl}
					target="_blank"
					rel="noreferrer"
					className="text-muted-foreground hover:text-foreground flex w-full items-center justify-between text-xs transition-colors"
				>
					<span className="flex items-center gap-1.5">
						<Icon name="book-open" className="h-4 w-4" />
						<Trans>Read documentation</Trans>
					</span>
					<Icon name="chevron-right" />
				</a>
			</CardFooter>

			{storeSettingsEnabled &&
			isConnected &&
			integration &&
			provider.kind === 'delivery' &&
			canManageIntegrations ? (
				<Sheet open={storeSheetOpen} onOpenChange={setStoreSheetOpen}>
					<SheetContent
						side="right"
						className="flex w-full flex-col sm:max-w-lg"
					>
						<SheetHeader>
							<SheetTitle>
								<Trans>{providerDisplayName} store settings</Trans>
							</SheetTitle>
							<SheetDescription>
								<Trans>
									Choose which menus this store serves, configure holiday hours
									sync, and review readiness before going live.
								</Trans>
							</SheetDescription>
						</SheetHeader>

						<div className="flex-1 space-y-5 overflow-y-auto px-4 py-3">
							{integration.managedByPos ? (
								<div
									role="status"
									className="border-border bg-muted/40 rounded-md border px-3 py-2 text-xs"
								>
									<p className="font-medium">
										<Trans>Managed by POS</Trans>
									</p>
									<p className="text-muted-foreground mt-0.5">
										<Trans>
											Your connected POS manages menus for this delivery store.
										</Trans>
									</p>
								</div>
							) : null}

							<storeFetcher.Form
								method="POST"
								className="space-y-4"
								onSubmit={(event) => {
									event.preventDefault()
									const formData = new FormData()
									formData.set('intent', saveStoreSettingsActionIntent)
									formData.set('integrationId', integration.id)
									formData.set('organizationLocationId', selectedLocationId)
									for (const menuId of draftMenuIds) {
										formData.append('menuIds', menuId)
									}
									formData.set(
										'holidaySync',
										draftHolidaySync ? 'true' : 'false',
									)
									void storeFetcher.submit(formData, { method: 'POST' })
								}}
							>
								<div className="space-y-2">
									<div className="flex items-center justify-between">
										<Label className="text-xs font-semibold">
											<Trans>Menus to publish</Trans>
										</Label>
										<span className="text-muted-foreground text-[11px]">
											<Trans>
												Max {integration.storeSettings?.menuLimit ?? 5}
											</Trans>
										</span>
									</div>
									{menus.length === 0 ? (
										<p className="text-muted-foreground text-xs">
											<Trans>Create a menu to publish to this store.</Trans>
										</p>
									) : (
										<div className="border-border divide-border/60 divide-y rounded-md border">
											{menus.map((menu) => {
												const checked = draftMenuIds.includes(menu.id)
												const menuLimit =
													integration.storeSettings?.menuLimit ?? 5
												const atLimit =
													!checked && draftMenuIds.length >= menuLimit
												const disabled =
													Boolean(integration.managedByPos) || atLimit
												const checkboxId = `${integration.id}-menu-${menu.id}`
												return (
													<label
														key={menu.id}
														htmlFor={checkboxId}
														className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-xs"
													>
														<span>{menu.name}</span>
														<Checkbox
															id={checkboxId}
															checked={checked}
															disabled={disabled}
															onCheckedChange={(nextChecked) => {
																setDraftMenuIds((prev) =>
																	nextChecked
																		? [...prev, menu.id]
																		: prev.filter((id) => id !== menu.id),
																)
															}}
														/>
													</label>
												)
											})}
										</div>
									)}
								</div>

								<div className="border-border flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
									<div className="space-y-0.5">
										<Label
											htmlFor={`${integration.id}-holiday-sync`}
											className="text-xs font-semibold"
										>
											<Trans>Holiday hours sync</Trans>
										</Label>
										<p className="text-muted-foreground text-[11px]">
											<Trans>
												Push upcoming special hours for this location
												automatically.
											</Trans>
										</p>
									</div>
									<Switch
										id={`${integration.id}-holiday-sync`}
										checked={draftHolidaySync}
										disabled={Boolean(integration.managedByPos)}
										onCheckedChange={setDraftHolidaySync}
									/>
								</div>

								{storeFetcher.data &&
								!storeFetcher.data.ok &&
								storeFetcher.data.error ? (
									<div
										role="alert"
										className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-xs"
									>
										{storeFetcher.data.error}
									</div>
								) : null}

								<Button
									type="submit"
									variant="outline"
									size="sm"
									className="w-full"
									disabled={
										Boolean(integration.managedByPos) ||
										draftMenuIds.length === 0 ||
										storeFetcher.state !== 'idle'
									}
								>
									<Trans>Save store settings</Trans>
								</Button>
							</storeFetcher.Form>

							{(() => {
								const effectiveReadiness =
									goLiveFetcher.data?.readiness ??
									storeFetcher.data?.readiness ??
									integration.readiness
								if (!effectiveReadiness) return null
								return (
									<div className="border-border space-y-2.5 rounded-md border p-3">
										<div className="flex items-center justify-between gap-2">
											<h5 className="text-xs font-semibold">
												<Trans>Readiness</Trans>
											</h5>
											<Badge
												variant={
													effectiveReadiness.ready ? 'secondary' : 'outline'
												}
											>
												{effectiveReadiness.ready ? (
													<Trans>Ready</Trans>
												) : (
													<Trans>Needs attention</Trans>
												)}
											</Badge>
										</div>
										{effectiveReadiness.ready ? (
											<p className="text-muted-foreground text-xs">
												<Trans>
													This store passes all menu and location checks.
												</Trans>
											</p>
										) : (
											<ul className="space-y-1.5 text-xs">
												{effectiveReadiness.reasons.map((reason) => (
													<li
														key={reason.code}
														className="flex items-start justify-between gap-2"
													>
														<span className="text-destructive">
															{reason.message}
														</span>
														{reason.href ? (
															<a
																href={reason.href}
																className="text-primary shrink-0 font-medium underline"
															>
																<Trans>Fix</Trans>
															</a>
														) : null}
													</li>
												))}
											</ul>
										)}

										{goLiveFetcher.data &&
										!goLiveFetcher.data.ok &&
										goLiveFetcher.data.error ? (
											<p className="text-destructive text-xs">
												{goLiveFetcher.data.error}
											</p>
										) : null}

										<goLiveFetcher.Form method="POST">
											<input
												type="hidden"
												name="intent"
												value={goLiveStoreActionIntent}
											/>
											<input
												type="hidden"
												name="integrationId"
												value={integration.id}
											/>
											<input
												type="hidden"
												name="organizationLocationId"
												value={selectedLocationId}
											/>
											<Button
												type="submit"
												size="sm"
												className="w-full"
												disabled={
													!effectiveReadiness.ready ||
													Boolean(integration.managedByPos) ||
													goLiveFetcher.state !== 'idle'
												}
											>
												<Trans>Go live</Trans>
											</Button>
										</goLiveFetcher.Form>
									</div>
								)
							})()}
						</div>
					</SheetContent>
				</Sheet>
			) : null}

			{isConnected && integration && canManageIntegrations ? (
				<Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
					<SheetContent
						side="right"
						className="flex w-full flex-col sm:max-w-lg"
					>
						<SheetHeader>
							<SheetTitle>
								<Trans>{providerDisplayName} sync history</Trans>
							</SheetTitle>
							<SheetDescription>
								<Trans>
									Recent imports, menu pushes, and availability updates.
								</Trans>
							</SheetDescription>
						</SheetHeader>

						<div className="border-border flex items-center justify-between border-y px-4 py-2">
							<Button
								type="button"
								variant={failuresOnly ? 'secondary' : 'outline'}
								size="sm"
								aria-pressed={failuresOnly}
								onClick={handleToggleFailuresOnly}
							>
								<Trans>Failures only</Trans>
							</Button>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={isHistoryLoading}
								onClick={() => loadHistory(historyPage, failuresOnly)}
							>
								<Icon name="refresh-cw" className="size-3.5" />
								<Trans>Refresh</Trans>
							</Button>
						</div>

						<div className="flex-1 space-y-2.5 overflow-y-auto px-4 py-3">
							{retryFetcher.data &&
							!retryFetcher.data.ok &&
							retryFetcher.data.error ? (
								<div
									role="alert"
									className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-xs"
								>
									{retryFetcher.data.error}
								</div>
							) : null}

							{isHistoryLoading && !historyData ? (
								<p className="text-muted-foreground py-6 text-center text-sm">
									<Trans>Loading sync history…</Trans>
								</p>
							) : historyEntries.length === 0 ? (
								<p className="text-muted-foreground py-6 text-center text-sm">
									{failuresOnly ? (
										<Trans>No failed syncs recorded.</Trans>
									) : (
										<Trans>No sync history yet.</Trans>
									)}
								</p>
							) : (
								historyEntries.map((entry) => {
									const counts = entry.itemCounts
									const createdCount = counts?.created
									const updatedCount = counts?.updated
									const skippedCount = counts?.skipped
									const pushedCount = counts?.pushed
									return (
										<div
											key={entry.id}
											className="border-border space-y-1.5 rounded-md border p-3"
										>
											<div className="flex items-center justify-between gap-2">
												<div className="flex items-center gap-2">
													<span className="text-xs font-medium">
														{entry.kind === 'import' ? (
															<Trans>Import</Trans>
														) : entry.kind === 'push' ? (
															<Trans>Push</Trans>
														) : entry.kind === 'availability' ? (
															<Trans>Availability</Trans>
														) : (
															<Trans>Connection</Trans>
														)}
													</span>
													<Badge
														variant={
															entry.status === 'success'
																? 'secondary'
																: entry.status === 'error'
																	? 'destructive'
																	: 'outline'
														}
													>
														{entry.status === 'success' ? (
															<Trans>Success</Trans>
														) : entry.status === 'error' ? (
															<Trans>Failed</Trans>
														) : (
															<Trans>Pending</Trans>
														)}
													</Badge>
												</div>
												<time
													dateTime={entry.createdAt}
													className="text-muted-foreground text-[11px]"
												>
													{new Date(entry.createdAt).toLocaleString()}
												</time>
											</div>

											{counts ? (
												<div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
													{counts.menuName ? (
														<span className="text-foreground font-medium">
															{counts.menuName}
														</span>
													) : null}
													{typeof createdCount === 'number' ? (
														<span>
															<Trans>{createdCount} created</Trans>
														</span>
													) : null}
													{typeof updatedCount === 'number' ? (
														<span>
															<Trans>{updatedCount} updated</Trans>
														</span>
													) : null}
													{typeof skippedCount === 'number' ? (
														<span>
															<Trans>{skippedCount} unchanged</Trans>
														</span>
													) : null}
													{typeof pushedCount === 'number' &&
													entry.kind !== 'import' ? (
														<span>
															<Trans>{pushedCount} pushed</Trans>
														</span>
													) : null}
													{typeof counts.available === 'boolean' ? (
														<span>
															{counts.available ? (
																<Trans>Marked available</Trans>
															) : (
																<Trans>Marked unavailable</Trans>
															)}
														</span>
													) : null}
												</div>
											) : null}

											{entry.errorMessage ? (
												<p className="text-destructive text-xs wrap-anywhere">
													{entry.errorMessage}
												</p>
											) : null}

											{entry.status === 'error' && entry.retryable ? (
												<div className="pt-1">
													<Button
														type="button"
														variant="outline"
														size="sm"
														disabled={retryingLogId === entry.id}
														onClick={() => handleRetryEntry(entry.id)}
													>
														<Trans>Retry</Trans>
													</Button>
												</div>
											) : null}
										</div>
									)
								})
							)}
						</div>

						{historyPage > 1 || historyData?.hasMore ? (
							<SheetFooter className="border-border flex-row items-center justify-between border-t">
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={historyPage <= 1 || isHistoryLoading}
									onClick={() => handlePageChange(historyPage - 1)}
								>
									<Trans>Previous</Trans>
								</Button>
								<span className="text-muted-foreground text-xs">
									<Trans>Page {historyPage}</Trans>
								</span>
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={!historyData?.hasMore || isHistoryLoading}
									onClick={() => handlePageChange(historyPage + 1)}
								>
									<Trans>Next</Trans>
								</Button>
							</SheetFooter>
						) : null}
					</SheetContent>
				</Sheet>
			) : null}

			{menuCheckEnabled &&
			isConnected &&
			integration &&
			provider.kind === 'delivery' &&
			canManageIntegrations ? (
				<Sheet open={diffsSheetOpen} onOpenChange={setDiffsSheetOpen}>
					<SheetContent
						side="right"
						className="flex w-full flex-col sm:max-w-lg"
					>
						<SheetHeader>
							<SheetTitle>
								<Trans>{providerDisplayName} menu differences</Trans>
							</SheetTitle>
							<SheetDescription>
								<Trans>
									Differences between your Menuza menu and what guests see on{' '}
									{providerDisplayName}.
								</Trans>
							</SheetDescription>
						</SheetHeader>

						<div className="flex-1 space-y-2.5 overflow-y-auto px-4 py-3">
							{fixFetcher.data &&
							!fixFetcher.data.ok &&
							fixFetcher.data.error ? (
								<div
									role="alert"
									className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-xs"
								>
									{fixFetcher.data.error}
								</div>
							) : null}

							{(integration.menuCheck?.diffs ?? []).length === 0 ? (
								<p className="text-muted-foreground py-6 text-center text-sm">
									<Trans>No menu differences recorded.</Trans>
								</p>
							) : (
								(integration.menuCheck?.diffs ?? []).map((diff, index) => {
									const localPriceLabel = formatMinorUnits(diff.localPrice)
									const remotePriceLabel = formatMinorUnits(diff.remotePrice)
									const localAvailableLabel = diff.localAvailable
										? t`Available`
										: t`Unavailable`
									const remoteAvailableLabel = diff.remoteAvailable
										? t`Available`
										: t`Unavailable`
									return (
										<div
											key={`${diff.kind}:${diff.dishName}:${diff.groupName ?? ''}:${diff.optionName ?? ''}:${index}`}
											className="border-border space-y-1.5 rounded-md border p-3"
										>
											<div className="flex flex-wrap items-center justify-between gap-2">
												<span className="text-xs font-medium">
													{diff.dishName}
												</span>
												<div className="flex flex-wrap items-center gap-1.5">
													{diff.changedInPos ? (
														<Badge variant="secondary">
															<Trans>Changed in POS</Trans>
														</Badge>
													) : null}
													<Badge
														variant={diff.changedInPos ? 'outline' : 'warning'}
													>
														{diff.kind === 'missing' ? (
															<Trans>Missing on platform</Trans>
														) : diff.kind === 'extra' ? (
															<Trans>Extra on platform</Trans>
														) : diff.kind === 'price' ? (
															<Trans>Price differs</Trans>
														) : diff.kind === 'available' ? (
															<Trans>Availability differs</Trans>
														) : (
															<Trans>Modifiers differ</Trans>
														)}
													</Badge>
												</div>
											</div>

											{diff.kind === 'price' ? (
												<p className="text-muted-foreground text-xs">
													<Trans>
														Menuza: {localPriceLabel} · Platform:{' '}
														{remotePriceLabel}
													</Trans>
												</p>
											) : diff.kind === 'available' ? (
												<p className="text-muted-foreground text-xs">
													<Trans>
														Menuza: {localAvailableLabel} · Platform:{' '}
														{remoteAvailableLabel}
													</Trans>
												</p>
											) : diff.kind === 'modifiers' ? (
												<p className="text-muted-foreground text-xs">
													{diff.detail}
													{diff.localPrice !== undefined &&
													diff.remotePrice !== undefined ? (
														<>
															{' '}
															(Menuza: {localPriceLabel} · Platform:{' '}
															{remotePriceLabel})
														</>
													) : null}
												</p>
											) : null}
										</div>
									)
								})
							)}
						</div>

						<SheetFooter className="border-border border-t">
							<fixFetcher.Form method="POST" className="w-full">
								<input
									type="hidden"
									name="intent"
									value={fixDeliveryMenuActionIntent}
								/>
								<input
									type="hidden"
									name="organizationLocationId"
									value={selectedLocationId}
								/>
								<input
									type="hidden"
									name="integrationId"
									value={integration.id}
								/>
								<Button
									type="submit"
									size="sm"
									className="w-full"
									disabled={
										fixFetcher.state !== 'idle' ||
										Boolean(integration.managedByPos)
									}
								>
									<Trans>Fix by pushing</Trans>
								</Button>
							</fixFetcher.Form>
						</SheetFooter>
					</SheetContent>
				</Sheet>
			) : null}
		</Card>
	)
}
