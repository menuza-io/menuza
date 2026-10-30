import { type MessageDescriptor } from '@lingui/core'
import { Trans, useLingui } from '@lingui/react/macro'
import {
	type LoyaltyOperatorLedgerEntry,
	type LoyaltyOperatorPurchase,
	type LoyaltyOperatorRedemption,
} from '@repo/loyalty'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { useCallback, type ReactNode } from 'react'
import {
	LOYALTY_ADJUSTMENT_REASON_LABELS,
	LOYALTY_CHANNEL_LABELS,
	LOYALTY_LEDGER_TYPE_LABELS,
	LOYALTY_PURCHASE_SOURCE_LABELS,
	LOYALTY_PURCHASE_STATE_LABELS,
	LOYALTY_REDEMPTION_STATE_LABELS,
	loyaltyEnumLabel,
} from '#app/utils/loyalty/loyalty-labels.ts'
import {
	canRefundPurchase,
	formatLoyaltyInstant,
	formatLoyaltyMoney,
	formatSignedPoints,
} from '#app/utils/loyalty/loyalty-view.ts'

export const LOYALTY_PURCHASES_HEADING_ID = 'customer-loyalty-purchases-heading'

function useLoyaltyTranslate() {
	const { i18n } = useLingui()
	const tx = useCallback((d: MessageDescriptor) => i18n._(d), [i18n])
	return { tx, locale: i18n.locale }
}

function ListSection({
	title,
	headingId,
	children,
}: {
	title: ReactNode
	headingId?: string
	children: ReactNode
}) {
	return (
		<section className="flex flex-col gap-2">
			<h3 id={headingId} className="text-sm font-semibold">
				{title}
			</h3>
			{children}
		</section>
	)
}

/** The ledger of one customer, newest first. */
export function LoyaltyEntriesList({
	entries,
}: {
	entries: LoyaltyOperatorLedgerEntry[]
}) {
	const { tx, locale } = useLoyaltyTranslate()
	return (
		<ListSection title={<Trans>Recent points activity</Trans>}>
			{entries.length === 0 ? (
				<p
					className="text-muted-foreground text-sm"
					data-testid="customer-loyalty-entries-empty"
				>
					<Trans>No point movements yet.</Trans>
				</p>
			) : (
				<ul
					className="divide-border divide-y rounded-xl border"
					data-testid="customer-loyalty-entries"
				>
					{entries.map((entry) => (
						<li
							key={entry.id}
							className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
						>
							<div className="flex min-w-0 flex-col gap-0.5">
								<span className="font-medium">
									{loyaltyEnumLabel(tx, LOYALTY_LEDGER_TYPE_LABELS, entry.type)}
								</span>
								<span className="text-muted-foreground text-xs wrap-anywhere">
									{[
										entry.reason
											? loyaltyEnumLabel(
													tx,
													LOYALTY_ADJUSTMENT_REASON_LABELS,
													entry.reason,
												)
											: null,
										entry.channel
											? loyaltyEnumLabel(
													tx,
													LOYALTY_CHANNEL_LABELS,
													entry.channel,
												)
											: null,
										formatLoyaltyInstant(entry.at, locale),
									]
										.filter(Boolean)
										.join(' · ')}
								</span>
								{entry.note ? (
									<span className="text-muted-foreground text-xs wrap-anywhere">
										{entry.note}
									</span>
								) : null}
							</div>
							<bdi
								dir="ltr"
								className={
									entry.delta > 0
										? 'text-success shrink-0 font-medium tabular-nums'
										: 'shrink-0 font-medium tabular-nums'
								}
							>
								{formatSignedPoints(entry.delta, locale)}
							</bdi>
						</li>
					))}
				</ul>
			)}
		</ListSection>
	)
}

export function RefundedLine({ amount }: { amount: string }) {
	return (
		<span className="text-muted-foreground text-xs">
			<Trans>
				Refunded <bdi dir="ltr">{amount}</bdi>
			</Trans>
		</span>
	)
}

/** Sales that earned points; QR tabs paid online offer Record refund. */
export function LoyaltyPurchasesList({
	purchases,
	canRecordRefund,
	onRecordRefund,
}: {
	purchases: LoyaltyOperatorPurchase[]
	canRecordRefund: boolean
	onRecordRefund: (purchase: LoyaltyOperatorPurchase) => void
}) {
	const { tx, locale } = useLoyaltyTranslate()
	if (purchases.length === 0) return null
	return (
		<ListSection
			title={<Trans>Purchases</Trans>}
			headingId={LOYALTY_PURCHASES_HEADING_ID}
		>
			<ul
				className="divide-border divide-y rounded-xl border"
				data-testid="customer-loyalty-purchases"
			>
				{purchases.map((purchase) => (
					<li
						key={purchase.id}
						className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
					>
						<div className="flex min-w-0 flex-col gap-0.5">
							<span className="font-medium">
								{loyaltyEnumLabel(
									tx,
									LOYALTY_PURCHASE_SOURCE_LABELS,
									purchase.sourceType,
								)}
							</span>
							<span className="text-muted-foreground text-xs">
								{formatLoyaltyInstant(purchase.occurredAt, locale) ?? '—'}
							</span>
							{purchase.refundedMinor > 0 ? (
								<RefundedLine
									amount={formatLoyaltyMoney(
										purchase.refundedMinor,
										purchase.currency,
										locale,
									)}
								/>
							) : null}
						</div>
						<div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
							<bdi dir="ltr" className="tabular-nums">
								{formatLoyaltyMoney(
									purchase.totalPaidMinor,
									purchase.currency,
									locale,
								)}
							</bdi>
							<Badge variant="outline">
								{loyaltyEnumLabel(
									tx,
									LOYALTY_PURCHASE_STATE_LABELS,
									purchase.state,
								)}
							</Badge>
							{canRecordRefund && canRefundPurchase(purchase) ? (
								<Button
									type="button"
									size="sm"
									variant="outline"
									onClick={() => onRecordRefund(purchase)}
									data-testid="loyalty-purchase-refund-open"
								>
									<Trans>Record refund</Trans>
								</Button>
							) : null}
						</div>
					</li>
				))}
			</ul>
		</ListSection>
	)
}

export function LoyaltyRedemptionsList({
	redemptions,
}: {
	redemptions: LoyaltyOperatorRedemption[]
}) {
	const { tx, locale } = useLoyaltyTranslate()
	if (redemptions.length === 0) return null
	return (
		<ListSection title={<Trans>Redemptions</Trans>}>
			<ul
				className="divide-border divide-y rounded-xl border"
				data-testid="customer-loyalty-redemptions"
			>
				{redemptions.map((redemption) => (
					<li
						key={redemption.id}
						className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
					>
						<div className="flex min-w-0 flex-col gap-0.5">
							<span className="font-medium wrap-anywhere">
								{redemption.rewardName}
							</span>
							<span className="text-muted-foreground text-xs">
								{formatLoyaltyInstant(redemption.createdAt, locale)}
							</span>
						</div>
						<div className="flex shrink-0 items-center gap-2">
							<bdi dir="ltr" className="tabular-nums">
								{redemption.points}
							</bdi>
							<Badge variant="outline">
								{loyaltyEnumLabel(
									tx,
									LOYALTY_REDEMPTION_STATE_LABELS,
									redemption.state,
								)}
							</Badge>
						</div>
					</li>
				))}
			</ul>
		</ListSection>
	)
}
