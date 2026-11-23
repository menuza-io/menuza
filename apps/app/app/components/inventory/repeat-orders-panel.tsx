import { Trans, useLingui } from '@lingui/react/macro'
import {
	type RepeatOrderRunView,
	type RepeatOrderSummary,
	repeatOrderSummarySchema,
} from '@repo/inventory'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemTitle,
} from '@repo/ui/item'
import { Skeleton } from '@repo/ui/skeleton'
import { WorkspacePanel } from '@repo/ui/workspace'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { weekdayName } from '#app/components/inventory/supplier-form.tsx'
import { useInventoryClient } from '#app/hooks/use-inventory-client.ts'
import { inventorySaveErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import { localDate } from '#app/utils/inventory/today-view.ts'

export type RepeatOrdersPanelProps = {
	repeatOrders: readonly RepeatOrderSummary[]
	loading?: boolean
	canManagePurchasing: boolean
	orderHrefPrefix: string
	orderHrefSuffix?: string
	onReload: () => void
}

export function RepeatOrdersPanel({
	repeatOrders,
	loading = false,
	canManagePurchasing,
	orderHrefPrefix,
	orderHrefSuffix = '',
	onReload,
}: RepeatOrdersPanelProps) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const [busyId, setBusyId] = useState<string | null>(null)

	const formatDay = (date: string) =>
		new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' }).format(
			localDate(date),
		)

	function cadenceLabel(weeks: number) {
		if (weeks === 1) return t`Weekly`
		if (weeks === 2) return t`Every 2 weeks`
		return t`Every 4 weeks`
	}

	function statusBadge(item: RepeatOrderSummary) {
		switch (item.effectiveStatus) {
			case 'active':
				return (
					<Badge variant="default" data-testid={`repeat-status-${item.id}`}>
						<Trans>Active</Trans>
					</Badge>
				)
			case 'paused':
				return (
					<Badge variant="secondary" data-testid={`repeat-status-${item.id}`}>
						<Trans>Paused</Trans>
					</Badge>
				)
			case 'paused_supplier':
				return (
					<Badge variant="warning" data-testid={`repeat-status-${item.id}`}>
						{item.supplierArchived ? (
							<Trans>Supplier archived</Trans>
						) : (
							<Trans>Supplier paused</Trans>
						)}
					</Badge>
				)
			case 'cancelled':
				return (
					<Badge variant="outline" data-testid={`repeat-status-${item.id}`}>
						<Trans>Cancelled</Trans>
					</Badge>
				)
		}
	}

	function runBadge(run: RepeatOrderRunView) {
		switch (run.status) {
			case 'scheduled':
				return (
					<Badge variant="outline">
						<Trans>Scheduled</Trans>
					</Badge>
				)
			case 'drafted':
				return (
					<Badge variant="secondary">
						<Trans>Drafted</Trans>
					</Badge>
				)
			case 'skipped':
				return (
					<Badge variant="outline">
						<Trans>Skipped</Trans>
					</Badge>
				)
			case 'skipped_holiday':
				return (
					<Badge variant="warning">
						<Trans>Closed (holiday)</Trans>
					</Badge>
				)
		}
	}

	async function updateStatus(
		item: RepeatOrderSummary,
		status: 'active' | 'paused' | 'cancelled',
	) {
		setBusyId(item.id)
		try {
			repeatOrderSummarySchema.parse(
				await request(`/repeat-orders/${encodeURIComponent(item.id)}`, {
					method: 'PATCH',
					body: JSON.stringify({
						expectedVersion: item.version,
						status,
					}),
				}),
			)
			toast.success(
				status === 'paused'
					? t`Repeat order paused.`
					: status === 'active'
						? t`Repeat order resumed.`
						: t`Repeat order removed.`,
			)
			onReload()
		} catch (caught) {
			toast.error(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setBusyId(null)
		}
	}

	async function toggleSkip(
		item: RepeatOrderSummary,
		run: RepeatOrderRunView,
		skipped: boolean,
	) {
		setBusyId(`${item.id}:${run.deliveryDate}`)
		try {
			repeatOrderSummarySchema.parse(
				await request(`/repeat-orders/${encodeURIComponent(item.id)}/skip`, {
					method: 'POST',
					body: JSON.stringify({
						deliveryDate: run.deliveryDate,
						skipped,
					}),
				}),
			)
			toast.success(skipped ? t`Run skipped.` : t`Run restored.`)
			onReload()
		} catch (caught) {
			toast.error(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setBusyId(null)
		}
	}

	if (!loading && repeatOrders.length === 0) {
		return null
	}

	return (
		<WorkspacePanel
			title={<Trans>Repeat orders</Trans>}
			description={
				<Trans>
					Drafts created automatically before each supplier cut-off. Nothing is
					sent until you review it.
				</Trans>
			}
			data-testid="repeat-orders-panel"
		>
			{loading ? (
				<div className="flex flex-col gap-3">
					<Skeleton className="h-16 w-full" />
					<Skeleton className="h-16 w-full" />
				</div>
			) : (
				<div className="flex flex-col gap-4">
					{repeatOrders.map((item) => {
						const daysLabel = item.weekdays
							.map((day) => weekdayName(day, i18n.locale, 'short'))
							.join(', ')
						return (
							<div
								key={item.id}
								className="border-border flex flex-col gap-3 rounded-lg border p-4"
								data-testid={`repeat-order-${item.id}`}
							>
								<div className="flex flex-wrap items-start justify-between gap-2">
									<div className="flex flex-col gap-1">
										<div className="flex flex-wrap items-center gap-2">
											<span className="font-medium">{item.supplierName}</span>
											{statusBadge(item)}
											<Badge variant="outline">
												{item.mode === 'top_up' ? (
													<Trans>Top up to level</Trans>
												) : (
													<Trans>Same lines</Trans>
												)}
											</Badge>
										</div>
										<p className="text-muted-foreground text-sm">
											{cadenceLabel(item.cadenceWeeks)} · {daysLabel}
											{item.note ? ` · ${item.note}` : ''}
										</p>
									</div>
									{canManagePurchasing && item.status !== 'cancelled' ? (
										<div className="flex flex-wrap items-center gap-2">
											{item.status === 'active' ? (
												<Button
													type="button"
													size="sm"
													variant="outline"
													disabled={busyId !== null}
													onClick={() => void updateStatus(item, 'paused')}
													data-testid={`repeat-pause-${item.id}`}
												>
													<Trans>Pause</Trans>
												</Button>
											) : (
												<Button
													type="button"
													size="sm"
													variant="outline"
													disabled={busyId !== null}
													onClick={() => void updateStatus(item, 'active')}
													data-testid={`repeat-resume-${item.id}`}
												>
													<Trans>Resume</Trans>
												</Button>
											)}
											<Button
												type="button"
												size="sm"
												variant="ghost"
												disabled={busyId !== null}
												onClick={() => void updateStatus(item, 'cancelled')}
												data-testid={`repeat-cancel-${item.id}`}
											>
												<Trans>Remove</Trans>
											</Button>
										</div>
									) : null}
								</div>

								{item.upcomingRuns.length > 0 ? (
									<ItemGroup>
										{item.upcomingRuns.map((run) => {
											const cutoffDay = formatDay(run.cutoffDate)
											const cutoffTime = run.cutoffTime
											return (
												<Item
													key={run.deliveryDate}
													variant="outline"
													size="sm"
													data-testid={`repeat-run-${item.id}-${run.deliveryDate}`}
												>
													<ItemContent>
														<ItemTitle>
															{formatDay(run.deliveryDate)}
															{runBadge(run)}
														</ItemTitle>
														<ItemDescription>
															<Trans>
																Cut-off {cutoffDay} at {cutoffTime}
															</Trans>
															{run.note ? ` · ${run.note}` : ''}
														</ItemDescription>
													</ItemContent>
													<ItemActions>
														{run.status === 'drafted' && run.orderId ? (
															<Button
																size="sm"
																variant="outline"
																render={
																	<Link
																		to={`${orderHrefPrefix}/${encodeURIComponent(run.orderId)}${orderHrefSuffix}`}
																	/>
																}
																data-testid={`repeat-open-draft-${run.deliveryDate}`}
															>
																<Trans>Review draft</Trans>
															</Button>
														) : null}
														{canManagePurchasing &&
														run.status === 'scheduled' ? (
															<Button
																type="button"
																size="sm"
																variant="outline"
																disabled={busyId !== null}
																onClick={() => void toggleSkip(item, run, true)}
																data-testid={`repeat-skip-${item.id}-${run.deliveryDate}`}
															>
																<Trans>Skip</Trans>
															</Button>
														) : null}
														{canManagePurchasing && run.status === 'skipped' ? (
															<Button
																type="button"
																size="sm"
																variant="outline"
																disabled={busyId !== null}
																onClick={() =>
																	void toggleSkip(item, run, false)
																}
																data-testid={`repeat-unskip-${item.id}-${run.deliveryDate}`}
															>
																<Trans>Undo skip</Trans>
															</Button>
														) : null}
													</ItemActions>
												</Item>
											)
										})}
									</ItemGroup>
								) : null}
							</div>
						)
					})}
				</div>
			)}
		</WorkspacePanel>
	)
}
