import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { isImpersonating } from '@repo/auth'
import { and, asc, db, eq, OrganizationLocation } from '@repo/database'
import {
	LOYALTY_MAX_PROMOTIONS,
	LOYALTY_PERMISSIONS,
	loyaltyProgramConfigSchema,
	type LoyaltyOperatorProgram,
	type LoyaltyPromotion,
	type LoyaltyPromotionStacking,
} from '@repo/loyalty'
import { Alert, AlertDescription } from '@repo/ui/alert'
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
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { Switch } from '@repo/ui/switch'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLoaderData } from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { PromotionDialog } from '#app/components/loyalty/promotion-dialog.tsx'
import { SelectField } from '#app/components/staff/controls.tsx'
import { useLoyaltyClient } from '#app/hooks/use-loyalty-client.ts'
import { requireLoyaltyAccess } from '#app/utils/loyalty/access.server.ts'
import { loadLoyaltyCatalog } from '#app/utils/loyalty/catalog.server.ts'
import {
	afterFailedLoyaltySubmit,
	loyaltyKeyForSubmit,
	newLoyaltySubmitKey,
} from '#app/utils/loyalty/loyalty-client.ts'
import { loyaltyErrorMessage } from '#app/utils/loyalty/loyalty-errors.ts'
import { loyaltyEnumLabel } from '#app/utils/loyalty/loyalty-labels.ts'
import { isUsableTimeZone } from '#app/utils/loyalty/loyalty-view.ts'
import {
	describePromotionEffect,
	describePromotionLocations,
	describePromotionSchedule,
	promotionStatus,
	PROMOTION_STATUS_LABELS,
	type PromotionStatus,
} from '#app/utils/loyalty/promotions.ts'
import { LOYALTY_SECTION_REQUIREMENTS } from '#app/utils/loyalty/sections.ts'
import { type Route } from './+types/promotions.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireLoyaltyAccess(request, params.orgSlug, {
		anyOf: LOYALTY_SECTION_REQUIREMENTS.promotions.anyOf,
	})
	const impersonated = await isImpersonating(request)
	const [locations, catalog] = await Promise.all([
		db
			.select({
				id: OrganizationLocation.id,
				name: OrganizationLocation.name,
			})
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.organizationId, access.organizationId),
					eq(OrganizationLocation.isActive, true),
				),
			)
			.orderBy(asc(OrganizationLocation.createdAt)),
		loadLoyaltyCatalog(access.organizationId),
	])
	return {
		orgSlug: access.orgSlug,
		catalog,
		locations,
		canManage:
			!impersonated &&
			access.grants.includes(LOYALTY_PERMISSIONS.UPDATE_LOYALTY_PROGRAM),
	}
}

const STATUS_BADGE: Record<
	PromotionStatus,
	'success' | 'secondary' | 'warning' | 'outline'
> = {
	live: 'success',
	scheduled: 'outline',
	ended: 'secondary',
	paused: 'warning',
}

/** A clock that moves once a minute, so "Live now" stays true on an open page. */
function useNow(): number {
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 60_000)
		return () => clearInterval(timer)
	}, [])
	return now
}

export default function LoyaltyPromotionsRoute() {
	const { i18n } = useLingui()
	const tx = useCallback((d: MessageDescriptor) => i18n._(d), [i18n])
	const { orgSlug, canManage, catalog, locations } =
		useLoaderData<typeof loader>()
	const client = useLoyaltyClient()
	const now = useNow()

	const [program, setProgram] = useState<LoyaltyOperatorProgram | null>(null)
	const [loading, setLoading] = useState(true)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [stale, setStale] = useState(false)
	const [busy, setBusy] = useState(false)
	const [dialog, setDialog] = useState<
		{ mode: 'create' } | { mode: 'edit'; promotion: LoyaltyPromotion } | null
	>(null)
	const [deleting, setDeleting] = useState<LoyaltyPromotion | null>(null)
	const keyRef = useRef(newLoyaltySubmitKey('promotions'))

	const load = useCallback(async () => {
		setLoading(true)
		setLoadError(null)
		setError(null)
		setStale(false)
		try {
			setProgram(await client.getProgram())
		} catch (err) {
			setLoadError(
				loyaltyErrorMessage(err, tx, msg`The promotions could not be loaded.`),
			)
		} finally {
			setLoading(false)
		}
	}, [client, tx])

	useEffect(() => {
		void load()
	}, [load])

	/**
	 * Promotions are part of the program, so every change saves the program as
	 * a new version with the whole config carried over. Answers an error
	 * message, or null once saved.
	 */
	const persist = useCallback(
		async (
			promotions: LoyaltyPromotion[],
			stacking: LoyaltyPromotionStacking,
		): Promise<string | null> => {
			if (!program) return tx(msg`The promotions could not be saved.`)
			const checked = loyaltyProgramConfigSchema.safeParse({
				...program.current.config,
				promotions,
				promotionStacking: stacking,
			})
			if (!checked.success) return tx(msg`Check the fields and try again.`)
			const body = { expectedVersion: program.version, config: checked.data }
			try {
				const saved = await client.saveProgram(
					body,
					loyaltyKeyForSubmit(keyRef, 'promotions', body),
				)
				setProgram(saved)
				keyRef.current = newLoyaltySubmitKey('promotions')
				return null
			} catch (err) {
				afterFailedLoyaltySubmit(keyRef, 'promotions', err)
				const code =
					err instanceof Error && 'code' in err
						? (err as { code?: string | null }).code
						: null
				if (code === 'stale_version') {
					setStale(true)
					return tx(
						msg`Someone else saved changes first. Reload to see the latest version, then try again.`,
					)
				}
				return loyaltyErrorMessage(
					err,
					tx,
					msg`The promotions could not be saved.`,
				)
			}
		},
		[client, program, tx],
	)

	/** A change made from the list itself: the error lands on the page. */
	const change = useCallback(
		async (
			promotions: LoyaltyPromotion[],
			stacking: LoyaltyPromotionStacking,
		) => {
			setBusy(true)
			setError(null)
			const message = await persist(promotions, stacking)
			if (message) setError(message)
			setBusy(false)
			return message === null
		},
		[persist],
	)

	if (loading) {
		return (
			<div
				role="status"
				className="flex flex-col gap-4"
				data-testid="loyalty-promotions-loading"
			>
				<span className="sr-only">
					<Trans>Loading promotions…</Trans>
				</span>
				<Skeleton className="h-10 w-64" />
				<Skeleton className="h-64 w-full" />
			</div>
		)
	}

	if (loadError) {
		return (
			<Alert variant="destructive" data-testid="loyalty-promotions-load-error">
				<Icon name="alert-triangle" />
				<AlertDescription>
					<div className="flex flex-wrap items-center gap-3">
						{loadError}
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() => void load()}
						>
							<Trans>Try again</Trans>
						</Button>
					</div>
				</AlertDescription>
			</Alert>
		)
	}

	if (!program) {
		return (
			<div data-testid="loyalty-promotions-no-program">
				<EmptyState
					title={<Trans>Set up the program first</Trans>}
					description={
						<Trans>
							Promotions add bonus points to what the program already awards, so
							the program has to exist first.
						</Trans>
					}
					icons={['trophy', 'star', 'receipt']}
					action={{
						label: tx(msg`Go to the program`),
						href: `/${orgSlug}/loyalty/program`,
					}}
				/>
			</div>
		)
	}

	const { config } = program.current
	const timeZone = isUsableTimeZone(config.timeZone) ? config.timeZone : 'UTC'
	const promotions = config.promotions
	const stacking = config.promotionStacking
	const atLimit = promotions.length >= LOYALTY_MAX_PROMOTIONS

	return (
		<div className="flex flex-col gap-4" data-testid="loyalty-promotions-page">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="text-muted-foreground text-sm">
					<Trans>
						A purchase is judged by the promotions that were running when it was
						paid. Changing a promotion never changes points already given.
					</Trans>
				</p>
				{canManage ? (
					<Button
						type="button"
						size="sm"
						disabled={atLimit || busy}
						onClick={() => setDialog({ mode: 'create' })}
						data-testid="loyalty-promotion-create"
					>
						<Icon name="plus" className="size-4" />
						<Trans>New promotion</Trans>
					</Button>
				) : null}
			</div>

			{program.status !== 'active' ? (
				<Alert data-testid="loyalty-promotions-inactive">
					<Icon name="alert-triangle" />
					<AlertDescription>
						{program.status === 'paused' ? (
							<Trans>
								The program is paused, so nothing is earned and promotions give
								nothing until it is running again.
							</Trans>
						) : (
							<Trans>
								The program is still a draft. Promotions start working once you
								activate it.
							</Trans>
						)}
					</AlertDescription>
				</Alert>
			) : null}

			{error ? (
				<Alert variant="destructive" data-testid="loyalty-promotions-error">
					<Icon name="alert-triangle" />
					<AlertDescription>
						<div className="flex flex-wrap items-center gap-3">
							{error}
							{stale ? (
								<Button
									type="button"
									size="sm"
									variant="outline"
									onClick={() => void load()}
								>
									<Trans>Reload</Trans>
								</Button>
							) : null}
						</div>
					</AlertDescription>
				</Alert>
			) : null}

			{!canManage ? (
				<Alert data-testid="loyalty-promotions-readonly">
					<Icon name="lock" />
					<AlertDescription>
						<Trans>
							You can view promotions but not change them. Ask an administrator
							for edit access.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}

			{promotions.length === 0 ? (
				<div data-testid="loyalty-promotions-empty">
					<EmptyState
						title={<Trans>No promotions yet</Trans>}
						description={
							<Trans>
								Run double points on a slow Tuesday, a bonus on a new dish, or a
								boost at one location.
							</Trans>
						}
						icons={['trophy', 'star', 'receipt']}
					/>
				</div>
			) : (
				<>
					<Frame>
						<Table variant="card">
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Promotion</Trans>
									</TableHead>
									<TableHead>
										<Trans>When</Trans>
									</TableHead>
									<TableHead>
										<Trans>Where</Trans>
									</TableHead>
									<TableHead>
										<Trans>Status</Trans>
									</TableHead>
									{canManage ? (
										<TableHead>
											<span className="sr-only">
												<Trans>Actions</Trans>
											</span>
										</TableHead>
									) : null}
								</TableRow>
							</TableHeader>
							<TableBody>
								{promotions.map((promotion) => {
									const status = promotionStatus(promotion, now, timeZone)
									return (
										<TableRow
											key={promotion.id}
											data-testid={`loyalty-promotion-row-${promotion.id}`}
										>
											<TableCell>
												<span className="font-medium wrap-anywhere">
													{promotion.name}
												</span>
												<span className="text-muted-foreground block text-xs wrap-anywhere">
													{describePromotionEffect(promotion, tx)}
												</span>
											</TableCell>
											<TableCell className="text-muted-foreground text-sm">
												{describePromotionSchedule(
													promotion,
													{ locale: i18n.locale, timeZone },
													tx,
												)}
											</TableCell>
											<TableCell className="text-muted-foreground text-sm">
												{describePromotionLocations(promotion, locations, tx)}
											</TableCell>
											<TableCell>
												<Badge
													variant={STATUS_BADGE[status]}
													data-testid={`loyalty-promotion-status-${promotion.id}`}
												>
													{loyaltyEnumLabel(
														tx,
														PROMOTION_STATUS_LABELS,
														status,
													)}
												</Badge>
											</TableCell>
											{canManage ? (
												<TableCell>
													<div className="flex items-center justify-end gap-2">
														<Switch
															size="sm"
															checked={promotion.enabled}
															disabled={busy || status === 'ended'}
															aria-label={tx(msg`Turned on`)}
															onCheckedChange={(checked) =>
																void change(
																	promotions.map((entry) =>
																		entry.id === promotion.id
																			? { ...entry, enabled: checked }
																			: entry,
																	),
																	stacking,
																)
															}
															data-testid={`loyalty-promotion-toggle-${promotion.id}`}
														/>
														<Button
															type="button"
															variant="ghost"
															size="sm"
															disabled={busy}
															onClick={() =>
																setDialog({ mode: 'edit', promotion })
															}
															data-testid={`loyalty-promotion-edit-${promotion.id}`}
														>
															<Trans>Edit</Trans>
														</Button>
														<Button
															type="button"
															variant="ghost"
															size="sm"
															disabled={busy}
															onClick={() => setDeleting(promotion)}
															data-testid={`loyalty-promotion-delete-${promotion.id}`}
														>
															<Trans>Delete</Trans>
														</Button>
													</div>
												</TableCell>
											) : null}
										</TableRow>
									)
								})}
							</TableBody>
						</Table>
					</Frame>

					{promotions.length > 1 ? (
						<div
							className="flex flex-col gap-1"
							data-testid="loyalty-promotions-stacking"
						>
							{canManage ? (
								<SelectField
									label={
										<Trans>When several promotions match a purchase</Trans>
									}
									id="loyalty-promotions-stacking"
									testId="loyalty-promotions-stacking-select"
									options={[
										{
											value: 'best',
											label: tx(msg`Give only the biggest bonus`),
										},
										{ value: 'add', label: tx(msg`Add the bonuses up`) },
									]}
									value={stacking}
									disabled={busy}
									onValueChange={(next) => {
										if (next !== stacking) {
											void change(promotions, next as LoyaltyPromotionStacking)
										}
									}}
								/>
							) : (
								<p className="text-sm">
									{stacking === 'best' ? (
										<Trans>
											When several promotions match a purchase, only the biggest
											bonus is given.
										</Trans>
									) : (
										<Trans>
											When several promotions match a purchase, their bonuses
											add up.
										</Trans>
									)}
								</p>
							)}
						</div>
					) : null}
				</>
			)}

			{dialog ? (
				<PromotionDialog
					key={dialog.mode === 'edit' ? dialog.promotion.id : 'new'}
					promotion={dialog.mode === 'edit' ? dialog.promotion : null}
					config={config}
					catalog={catalog}
					locations={locations}
					onClose={() => setDialog(null)}
					onSubmit={async (saved) => {
						const next =
							dialog.mode === 'edit'
								? promotions.map((entry) =>
										entry.id === saved.id ? saved : entry,
									)
								: [...promotions, saved]
						const message = await persist(next, stacking)
						if (message === null) setDialog(null)
						return message
					}}
				/>
			) : null}

			<AlertDialog
				open={deleting !== null}
				onOpenChange={(open) => {
					if (!open) setDeleting(null)
				}}
			>
				<AlertDialogContent data-testid="loyalty-promotion-delete-dialog">
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Delete this promotion?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								{deleting?.name} stops giving bonus points right away. Points it
								already gave stay where they are. To pause it for a while, turn
								it off instead.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Keep it</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							data-testid="loyalty-promotion-delete-confirm"
							onClick={() => {
								const target = deleting
								setDeleting(null)
								if (target) {
									void change(
										promotions.filter((entry) => entry.id !== target.id),
										stacking,
									)
								}
							}}
						>
							<Trans>Delete</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
