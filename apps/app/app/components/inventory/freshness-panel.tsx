import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { type Freshness, type FreshnessRow } from '@repo/inventory'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { WorkspacePanel } from '@repo/ui/workspace'
import { useState } from 'react'
import { toast } from 'sonner'
import {
	useNotifyInventoryChanged,
	useQuantityFormat,
} from '#app/components/inventory/inventory-prefs.tsx'
import { useInventoryClient } from '#app/hooks/use-inventory-client.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import { inventorySaveErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import { newClientId } from '#app/utils/inventory/waste-form.ts'

/** A `YYYY-MM-DD` use-by date in the viewer's language. */
export function formatUseBy(date: string, locale: string): string {
	const [year, month, day] = date.split('-').map(Number)
	return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
		new Date(year!, month! - 1, day!),
	)
}

/**
 * "Use first" and "Expired" on Today (#479): stock with a use-by date in the
 * next two days, and stock already past it. Expired stock is one tap from
 * waste: the tap throws away that date's quantity as waste with the reason
 * "Expired" (the oldest date is not touched). The region lists them; this panel
 * only shows them. Hidden while nothing has a date to watch.
 */
export function FreshnessPanel({
	locationId,
	freshness,
	canEdit,
	canSeeCost,
	currency,
}: {
	locationId: string
	freshness: Freshness
	canEdit: boolean
	canSeeCost: boolean
	currency: string
}) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const notifyChanged = useNotifyInventoryChanged()
	const quantity = useQuantityFormat()
	const [busy, setBusy] = useState<string | null>(null)
	if (freshness.expiredCount === 0 && freshness.useFirstCount === 0) {
		return null
	}

	async function waste(row: FreshnessRow) {
		setBusy(row.lotId)
		try {
			await request(`/lots/${encodeURIComponent(row.lotId)}/waste`, {
				method: 'POST',
				body: JSON.stringify({
					clientId: newClientId('x'),
					locationId,
				}),
			})
			toast.success(t`Logged as waste.`)
			notifyChanged()
		} catch (error) {
			toast.error(i18n._(inventorySaveErrorMessage(error)))
		} finally {
			setBusy(null)
		}
	}

	const rowText = (row: FreshnessRow) =>
		quantity.format(row.remaining, {
			baseUnit: row.baseUnit,
			countUnit: row.countUnit,
		})

	return (
		<div id="freshness" className="scroll-mt-20" data-testid="today-freshness">
			<WorkspacePanel title={<Trans>Freshness</Trans>}>
				<div className="flex flex-col gap-4">
					{freshness.expired.length > 0 ? (
						<section
							className="flex flex-col gap-2"
							data-testid="today-expired"
						>
							<h3 className="text-sm font-medium">
								<Trans>Expired</Trans>{' '}
								<Badge variant="destructive">{freshness.expiredCount}</Badge>
							</h3>
							<ul className="flex flex-col divide-y rounded-xl border">
								{freshness.expired.map((row) => (
									<li
										key={row.lotId}
										className="flex flex-wrap items-center justify-between gap-3 p-3"
										data-testid={`today-expired-${row.lotId}`}
									>
										<span className="flex min-w-0 flex-col gap-0.5">
											<span className="text-sm font-medium wrap-anywhere">
												{row.itemName}
											</span>
											<span className="text-muted-foreground text-xs">
												<bdi dir="ltr">{rowText(row)}</bdi>{' '}
												<Trans>
													expired{' '}
													<bdi dir="ltr">
														{formatUseBy(row.useByDate, i18n.locale)}
													</bdi>
												</Trans>
												{canSeeCost && row.valueMinor !== undefined ? (
													<>
														{' · '}
														<bdi dir="ltr">
															{formatMoney(
																row.valueMinor,
																row.currency ?? currency,
																i18n.locale,
															)}
														</bdi>
													</>
												) : null}
											</span>
										</span>
										{canEdit ? (
											<Button
												variant="outline"
												size="sm"
												disabled={busy !== null}
												onClick={() => void waste(row)}
												data-testid={`today-expired-waste-${row.lotId}`}
											>
												<Trans>Log as waste</Trans>
											</Button>
										) : null}
									</li>
								))}
							</ul>
						</section>
					) : null}
					{freshness.useFirst.length > 0 ? (
						<section
							className="flex flex-col gap-2"
							data-testid="today-use-first"
						>
							<h3 className="text-sm font-medium">
								<Trans>Use first</Trans>{' '}
								<Badge variant="secondary">{freshness.useFirstCount}</Badge>
							</h3>
							<ul className="flex flex-col divide-y rounded-xl border">
								{freshness.useFirst.map((row) => (
									<li
										key={row.lotId}
										className="flex flex-wrap items-center justify-between gap-3 p-3"
										data-testid={`today-use-first-${row.lotId}`}
									>
										<span className="text-sm font-medium wrap-anywhere">
											{row.itemName}
										</span>
										<span className="text-muted-foreground text-xs">
											<bdi dir="ltr">{rowText(row)}</bdi>
											{' · '}
											{row.daysLeft === 0 ? (
												<Trans>expires today</Trans>
											) : (
												<Plural
													value={row.daysLeft}
													one="expires in # day"
													other="expires in # days"
												/>
											)}
										</span>
									</li>
								))}
							</ul>
						</section>
					) : null}
				</div>
			</WorkspacePanel>
		</div>
	)
}
