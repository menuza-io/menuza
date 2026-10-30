import { type MessageDescriptor } from '@lingui/core'
import { msg, plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { isImpersonating } from '@repo/auth'
import {
	LOYALTY_PERMISSIONS,
	type LoyaltyDiscount,
	type LoyaltyOperatorReward,
} from '@repo/loyalty'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
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
import { RewardDialog } from '#app/components/loyalty/reward-dialog.tsx'
import { useLoyaltyClient } from '#app/hooks/use-loyalty-client.ts'
import { requireLoyaltyAccess } from '#app/utils/loyalty/access.server.ts'
import { loadLoyaltyCatalog } from '#app/utils/loyalty/catalog.server.ts'
import {
	afterFailedLoyaltySubmit,
	loyaltyKeyForSubmit,
	newLoyaltySubmitKey,
} from '#app/utils/loyalty/loyalty-client.ts'
import { loyaltyErrorMessage } from '#app/utils/loyalty/loyalty-errors.ts'
import {
	LOYALTY_REWARD_KIND_LABELS,
	LOYALTY_REWARD_STATUS_LABELS,
	loyaltyEnumLabel,
} from '#app/utils/loyalty/loyalty-labels.ts'
import { formatLoyaltyMoney } from '#app/utils/loyalty/loyalty-view.ts'
import { LOYALTY_SECTION_REQUIREMENTS } from '#app/utils/loyalty/sections.ts'
import { type Route } from './+types/rewards.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireLoyaltyAccess(request, params.orgSlug, {
		anyOf: LOYALTY_SECTION_REQUIREMENTS.rewards.anyOf,
	})
	const [impersonated, catalog] = await Promise.all([
		isImpersonating(request),
		loadLoyaltyCatalog(access.organizationId),
	])
	return {
		orgSlug: access.orgSlug,
		catalog,
		canManage:
			!impersonated &&
			access.grants.includes(LOYALTY_PERMISSIONS.UPDATE_LOYALTY_PROGRAM),
	}
}

/** One-line summary of what the reward does, for the list. */
function rewardSummary(
	reward: LoyaltyOperatorReward,
	tx: (d: MessageDescriptor) => string,
	locale: string,
): string {
	const definition = reward.definition
	if (definition.kind === 'free_item') {
		const name = definition.labels.items[definition.itemId] ?? definition.itemId
		return tx(msg`Free: ${name}`)
	}
	const discount = discountSummary(
		definition.discount,
		reward.currency,
		tx,
		locale,
	)
	if (definition.kind === 'order') {
		return tx(msg`${discount} off the whole order`)
	}
	if (definition.kind === 'categories') {
		const count = definition.categoryIds.length
		return tx(
			msg`${discount} on ${plural(count, { one: '# category', other: '# categories' })}`,
		)
	}
	const count = definition.itemIds.length
	return tx(
		msg`${discount} on ${plural(count, { one: '# item', other: '# items' })}`,
	)
}

function discountSummary(
	discount: LoyaltyDiscount,
	currency: string,
	tx: (d: MessageDescriptor) => string,
	locale: string,
): string {
	if (discount.type === 'fixed') {
		return formatLoyaltyMoney(discount.amountMinor, currency, locale)
	}
	const percent = (discount.percentBp / 100).toString()
	if (discount.maxDiscountMinor !== null) {
		const max = formatLoyaltyMoney(discount.maxDiscountMinor, currency, locale)
		return tx(msg`${percent}% (up to ${max})`)
	}
	return `${percent}%`
}

export default function LoyaltyRewardsRoute() {
	const { i18n } = useLingui()
	const tx = useCallback((d: MessageDescriptor) => i18n._(d), [i18n])
	const { canManage, catalog } = useLoaderData<typeof loader>()
	const client = useLoyaltyClient()

	const [rewards, setRewards] = useState<LoyaltyOperatorReward[] | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [dialog, setDialog] = useState<
		{ mode: 'create' } | { mode: 'edit'; reward: LoyaltyOperatorReward } | null
	>(null)
	const [busyId, setBusyId] = useState<string | null>(null)
	const statusKeyRef = useRef(newLoyaltySubmitKey('reward-status'))

	const load = useCallback(async () => {
		setError(null)
		try {
			setRewards(await client.listRewards())
		} catch (err) {
			setRewards(null)
			setError(
				loyaltyErrorMessage(err, tx, msg`The rewards could not be loaded.`),
			)
		}
	}, [client, tx])

	useEffect(() => {
		void load()
	}, [load])

	const changeStatus = useCallback(
		async (reward: LoyaltyOperatorReward, status: 'active' | 'archived') => {
			setBusyId(reward.id)
			setError(null)
			const body = { expectedVersion: reward.version, status }
			try {
				const saved = await client.setRewardStatus(
					reward.id,
					body,
					loyaltyKeyForSubmit(statusKeyRef, 'reward-status', {
						rewardId: reward.id,
						...body,
					}),
				)
				setRewards(
					(current) =>
						current?.map((row) => (row.id === saved.id ? saved : row)) ?? null,
				)
				statusKeyRef.current = newLoyaltySubmitKey('reward-status')
			} catch (err) {
				afterFailedLoyaltySubmit(statusKeyRef, 'reward-status', err)
				setError(
					loyaltyErrorMessage(
						err,
						tx,
						msg`The reward status could not be changed.`,
					),
				)
			} finally {
				setBusyId(null)
			}
		},
		[client, tx],
	)

	return (
		<div className="flex flex-col gap-4" data-testid="loyalty-rewards-page">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="text-muted-foreground text-sm">
					<Trans>
						Every edit creates a new version; redemptions keep the reward they
						were made with.
					</Trans>
				</p>
				{canManage ? (
					<Button
						type="button"
						size="sm"
						onClick={() => setDialog({ mode: 'create' })}
						data-testid="loyalty-reward-create"
					>
						<Icon name="plus" className="size-4" />
						<Trans>New reward</Trans>
					</Button>
				) : null}
			</div>

			{error ? (
				<Alert variant="destructive" data-testid="loyalty-rewards-error">
					<Icon name="alert-triangle" />
					<AlertDescription>
						<div className="flex flex-wrap items-center gap-3">
							{error}
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
			) : null}

			{rewards === null && !error ? (
				<Frame data-testid="loyalty-rewards-loading" aria-busy="true">
					<div role="status" className="divide-border flex flex-col divide-y">
						<span className="sr-only">
							<Trans>Loading rewards…</Trans>
						</span>
						{[0, 1, 2].map((row) => (
							<div key={row} className="flex items-center gap-4 px-3 py-2.5">
								<Skeleton className="h-4 w-40" />
								<Skeleton className="h-4 w-56" />
								<Skeleton className="ms-auto h-4 w-16" />
							</div>
						))}
					</div>
				</Frame>
			) : null}

			{rewards !== null && rewards.length === 0 ? (
				<div data-testid="loyalty-rewards-empty">
					<EmptyState
						title={<Trans>No rewards yet</Trans>}
						description={
							<Trans>
								Rewards are what customers spend their points on: a discount or
								a free item.
							</Trans>
						}
						icons={['trophy', 'star', 'receipt']}
					/>
				</div>
			) : null}

			{rewards !== null && rewards.length > 0 ? (
				<Frame>
					<Table variant="card">
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>Name</Trans>
								</TableHead>
								<TableHead>
									<Trans>Reward</Trans>
								</TableHead>
								<TableHead className="text-end">
									<Trans>Cost</Trans>
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
							{rewards.map((reward) => (
								<TableRow
									key={reward.id}
									data-testid={`loyalty-reward-row-${reward.id}`}
								>
									<TableCell>
										<span className="font-medium wrap-anywhere">
											{reward.definition.name}
										</span>
										{reward.definition.description ? (
											<span className="text-muted-foreground block text-xs wrap-anywhere">
												{reward.definition.description}
											</span>
										) : null}
									</TableCell>
									<TableCell className="text-muted-foreground text-sm">
										<div className="flex flex-col gap-0.5">
											<Badge variant="outline">
												{loyaltyEnumLabel(
													tx,
													LOYALTY_REWARD_KIND_LABELS,
													reward.definition.kind,
												)}
											</Badge>
											<span>{rewardSummary(reward, tx, i18n.locale)}</span>
										</div>
									</TableCell>
									<TableCell className="text-end tabular-nums" dir="ltr">
										{reward.definition.pointsCost}
									</TableCell>
									<TableCell>
										<Badge
											variant={
												reward.status === 'active' ? 'success' : 'secondary'
											}
											data-testid={`loyalty-reward-status-${reward.id}`}
										>
											{loyaltyEnumLabel(
												tx,
												LOYALTY_REWARD_STATUS_LABELS,
												reward.status,
											)}
										</Badge>
									</TableCell>
									{canManage ? (
										<TableCell>
											<div className="flex items-center justify-end gap-1">
												<Button
													type="button"
													variant="ghost"
													size="sm"
													onClick={() => setDialog({ mode: 'edit', reward })}
													data-testid={`loyalty-reward-edit-${reward.id}`}
												>
													<Trans>Edit</Trans>
												</Button>
												{reward.status === 'active' ? (
													<Button
														type="button"
														variant="ghost"
														size="sm"
														disabled={busyId === reward.id}
														onClick={() =>
															void changeStatus(reward, 'archived')
														}
														data-testid={`loyalty-reward-archive-${reward.id}`}
													>
														<Trans>Archive</Trans>
													</Button>
												) : (
													<Button
														type="button"
														variant="ghost"
														size="sm"
														disabled={busyId === reward.id}
														onClick={() => void changeStatus(reward, 'active')}
														data-testid={`loyalty-reward-activate-${reward.id}`}
													>
														<Trans>Activate</Trans>
													</Button>
												)}
											</div>
										</TableCell>
									) : null}
								</TableRow>
							))}
						</TableBody>
					</Table>
				</Frame>
			) : null}

			{dialog ? (
				<RewardDialog
					key={dialog.mode === 'edit' ? dialog.reward.id : 'new'}
					client={client}
					reward={dialog.mode === 'edit' ? dialog.reward : null}
					// The page has no program; rewards carry the program currency.
					currency={rewards?.[0]?.currency ?? null}
					catalog={catalog}
					onClose={() => setDialog(null)}
					onSaved={(saved) => {
						setDialog(null)
						setRewards((current) => {
							if (!current) return [saved]
							const index = current.findIndex((row) => row.id === saved.id)
							if (index === -1) return [...current, saved]
							return current.map((row) => (row.id === saved.id ? saved : row))
						})
					}}
				/>
			) : null}
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
