'use client'

import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	DEFAULT_ORDER_ACCEPTANCE_TIMEOUT_MINUTES,
	GUEST_CANCEL_MAX_SCHEDULED_LEAD_MINUTES,
	GUEST_CANCEL_MINUTES_CHOICES,
	ORDER_ACCEPTANCE_TIMEOUT_CHOICES,
} from '@repo/common/restaurant-orders'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Switch } from '@repo/ui/switch'

/** What the form edits. Strings stay as typed; the action parses them. */
export type OrderPolicyValues = {
	/** '0' is Off. */
	guestCancelMinutes: string
	guestCancelScheduledLeadMinutes: string
	orderAcceptanceMode: 'auto' | 'manual'
	orderAcceptanceTimeoutMinutes: string
	/** Major units, blank means every order. */
	orderAcceptanceMinTotal: string
	orderAcceptanceScheduledOnly: boolean
}

export type OrderPolicyFlags = { guestCancel: boolean; acceptance: boolean }

export function OrderPoliciesCard({
	flags,
	currency,
	values,
	onChange,
}: {
	flags: OrderPolicyFlags
	currency: string
	values: OrderPolicyValues
	onChange: (next: OrderPolicyValues) => void
}) {
	const { _ } = useLingui()
	if (!flags.guestCancel && !flags.acceptance) return null
	const set = (patch: Partial<OrderPolicyValues>) =>
		onChange({ ...values, ...patch })
	const cancelOn = values.guestCancelMinutes !== '0'
	const manual = values.orderAcceptanceMode === 'manual'

	const cancelItems: Record<string, string> = {
		'0': _(msg`Off`),
		...Object.fromEntries(
			GUEST_CANCEL_MINUTES_CHOICES.map((m) => [
				String(m),
				m === 1 ? _(msg`1 minute`) : _(msg`${m} minutes`),
			]),
		),
	}
	const modeItems: Record<string, string> = {
		auto: _(msg`Automatic`),
		manual: _(msg`Manual`),
	}
	const timeoutItems: Record<string, string> = Object.fromEntries(
		ORDER_ACCEPTANCE_TIMEOUT_CHOICES.map((m) => [
			String(m),
			_(msg`${m} minutes`),
		]),
	)

	return (
		<Card data-testid="order-policies-card">
			<CardHeader>
				<CardTitle>
					<Trans>Online order rules</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Choose how guests can cancel and whether you accept each online
						order yourself.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-6">
				{flags.guestCancel ? (
					<div className="space-y-3" data-testid="guest-cancel-settings">
						<div className="space-y-1.5">
							<Label>
								<Trans>Guests can cancel within</Trans>
							</Label>
							<Select
								value={values.guestCancelMinutes}
								items={cancelItems}
								onValueChange={(v) => v && set({ guestCancelMinutes: v })}
							>
								<SelectTrigger data-testid="guest-cancel-minutes">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{Object.entries(cancelItems).map(([value, label]) => (
										<SelectItem key={value} value={value}>
											{label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<p className="text-muted-foreground text-xs">
								<Trans>
									A guest can cancel on the order page until this long after
									paying. Once the kitchen starts cooking, they can&apos;t.
									Online payments are refunded in full.
								</Trans>
							</p>
						</div>
						{cancelOn ? (
							<div className="space-y-1.5">
								<Label htmlFor="guest-cancel-lead">
									<Trans>
										Scheduled orders: until this many minutes before the
										scheduled time
									</Trans>
								</Label>
								<Input
									id="guest-cancel-lead"
									type="number"
									inputMode="numeric"
									min={0}
									max={GUEST_CANCEL_MAX_SCHEDULED_LEAD_MINUTES}
									value={values.guestCancelScheduledLeadMinutes}
									onChange={(e) =>
										set({ guestCancelScheduledLeadMinutes: e.target.value })
									}
								/>
								<p className="text-muted-foreground text-xs">
									<Trans>
										Leave empty to use the same time as other orders.
									</Trans>
								</p>
							</div>
						) : null}
					</div>
				) : null}

				{flags.acceptance ? (
					<div className="space-y-3" data-testid="order-acceptance-settings">
						<div className="space-y-1.5">
							<Label>
								<Trans>Order acceptance</Trans>
							</Label>
							<Select
								value={values.orderAcceptanceMode}
								items={modeItems}
								onValueChange={(v) =>
									v && set({ orderAcceptanceMode: v as 'auto' | 'manual' })
								}
							>
								<SelectTrigger data-testid="order-acceptance-mode">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{Object.entries(modeItems).map(([value, label]) => (
										<SelectItem key={value} value={value}>
											{label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<p className="text-muted-foreground text-xs">
								<Trans>
									With Manual, new online orders wait for you to press Accept
									before the kitchen sees them. An order that is not accepted in
									time is cancelled and refunded in full.
								</Trans>
							</p>
						</div>
						{manual ? (
							<>
								<div className="space-y-1.5">
									<Label>
										<Trans>Reject automatically after</Trans>
									</Label>
									<Select
										value={
											values.orderAcceptanceTimeoutMinutes ||
											String(DEFAULT_ORDER_ACCEPTANCE_TIMEOUT_MINUTES)
										}
										items={timeoutItems}
										onValueChange={(v) =>
											v && set({ orderAcceptanceTimeoutMinutes: v })
										}
									>
										<SelectTrigger data-testid="order-acceptance-timeout">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{Object.entries(timeoutItems).map(([value, label]) => (
												<SelectItem key={value} value={value}>
													{label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
								<div className="space-y-1.5">
									<Label htmlFor="acceptance-min-total">
										<Trans>Only for orders over ({currency})</Trans>
									</Label>
									<Input
										id="acceptance-min-total"
										type="number"
										inputMode="decimal"
										min={0}
										step="0.01"
										value={values.orderAcceptanceMinTotal}
										onChange={(e) =>
											set({ orderAcceptanceMinTotal: e.target.value })
										}
									/>
									<p className="text-muted-foreground text-xs">
										<Trans>Leave empty to review every online order.</Trans>
									</p>
								</div>
								<div className="flex items-center justify-between gap-3">
									<div>
										<Label htmlFor="acceptance-scheduled-only">
											<Trans>Only scheduled orders</Trans>
										</Label>
										<p className="text-muted-foreground text-xs">
											<Trans>
												Orders for right now go straight to the kitchen.
											</Trans>
										</p>
									</div>
									<Switch
										id="acceptance-scheduled-only"
										checked={values.orderAcceptanceScheduledOnly}
										onCheckedChange={(c) =>
											set({ orderAcceptanceScheduledOnly: c })
										}
									/>
								</div>
							</>
						) : null}
					</div>
				) : null}
			</CardContent>
		</Card>
	)
}
