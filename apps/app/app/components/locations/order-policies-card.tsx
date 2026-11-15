'use client'

import { type MessageDescriptor } from '@lingui/core'
import { Trans, msg, plural } from '@lingui/macro'
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
import { Label } from '@repo/ui/label'
import { Switch } from '@repo/ui/switch'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import {
	type OrderPolicyError,
	type OrderPolicyField,
} from '#app/utils/orders/order-policy-settings.ts'

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

const MAX_LEAD = GUEST_CANCEL_MAX_SCHEDULED_LEAD_MINUTES

/** What to do about a refused field; the server sends only its name and a code. */
const FIELD_ERRORS: Record<OrderPolicyField, MessageDescriptor> = {
	guestCancelMinutes: msg`Choose one of the listed times.`,
	guestCancelScheduledLeadMinutes: msg`Enter a whole number of minutes, from 0 to ${MAX_LEAD}.`,
	orderAcceptanceMode: msg`Choose Automatic or Manual.`,
	orderAcceptanceTimeoutMinutes: msg`Choose one of the listed times.`,
	orderAcceptanceMinTotal: msg`Enter an amount, for example 25 or 25.50.`,
}

/** The message for a refused order-rules field, in the reader's language. */
export function orderPolicyErrorMessage(
	error: OrderPolicyError,
): MessageDescriptor {
	return FIELD_ERRORS[error.field]
}

export function OrderPoliciesCard({
	flags,
	currency,
	values,
	onChange,
	error,
}: {
	flags: OrderPolicyFlags
	currency: string
	values: OrderPolicyValues
	onChange: (next: OrderPolicyValues) => void
	/** The field the last save refused, until the next save. */
	error?: OrderPolicyError | null
}) {
	const { _ } = useLingui()
	if (!flags.guestCancel && !flags.acceptance) return null
	const set = (patch: Partial<OrderPolicyValues>) =>
		onChange({ ...values, ...patch })
	const cancelOn = values.guestCancelMinutes !== '0'
	const manual = values.orderAcceptanceMode === 'manual'
	const errorFor = (field: OrderPolicyField) =>
		error?.field === field ? _(FIELD_ERRORS[field]) : null
	const minutes = (m: number) =>
		plural(m, { one: '# minute', other: '# minutes' })

	const cancelOptions = [
		{ value: '0', label: _(msg`Off`) },
		...GUEST_CANCEL_MINUTES_CHOICES.map((m) => ({
			value: String(m),
			label: minutes(m),
		})),
	]
	const modeOptions = [
		{ value: 'auto', label: _(msg`Automatic`) },
		{ value: 'manual', label: _(msg`Manual`) },
	]
	const timeoutOptions = ORDER_ACCEPTANCE_TIMEOUT_CHOICES.map((m) => ({
		value: String(m),
		label: minutes(m),
	}))

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
						<SelectField
							id="guest-cancel-minutes"
							testId="guest-cancel-minutes"
							label={<Trans>Guests can cancel within</Trans>}
							hint={
								<Trans>
									A guest can cancel on the order page until this long after
									paying. Once the kitchen starts cooking, they can&apos;t.
									Online payments are refunded in full.
								</Trans>
							}
							error={errorFor('guestCancelMinutes')}
							options={cancelOptions}
							value={values.guestCancelMinutes}
							onValueChange={(v) => set({ guestCancelMinutes: v })}
						/>
						{cancelOn ? (
							<TextField
								id="guest-cancel-lead"
								label={
									<Trans>
										Scheduled orders: until this many minutes before the
										scheduled time
									</Trans>
								}
								hint={
									<Trans>
										Leave empty to use the same time as other orders.
									</Trans>
								}
								error={errorFor('guestCancelScheduledLeadMinutes')}
								// Text, not number: a number field drops Arabic-Indic digits.
								type="text"
								inputMode="numeric"
								dir="ltr"
								autoComplete="off"
								value={values.guestCancelScheduledLeadMinutes}
								onChange={(e) =>
									set({ guestCancelScheduledLeadMinutes: e.target.value })
								}
							/>
						) : null}
					</div>
				) : null}

				{flags.acceptance ? (
					<div className="space-y-3" data-testid="order-acceptance-settings">
						<SelectField
							id="order-acceptance-mode"
							testId="order-acceptance-mode"
							label={<Trans>Order acceptance</Trans>}
							hint={
								<Trans>
									With Manual, new online orders wait for you to press Accept
									before the kitchen sees them. An order that is not accepted in
									time is cancelled and refunded in full.
								</Trans>
							}
							error={errorFor('orderAcceptanceMode')}
							options={modeOptions}
							value={values.orderAcceptanceMode}
							onValueChange={(v) =>
								set({ orderAcceptanceMode: v === 'manual' ? 'manual' : 'auto' })
							}
						/>
						{manual ? (
							<>
								<SelectField
									id="order-acceptance-timeout"
									testId="order-acceptance-timeout"
									label={<Trans>Reject automatically after</Trans>}
									error={errorFor('orderAcceptanceTimeoutMinutes')}
									options={timeoutOptions}
									value={
										values.orderAcceptanceTimeoutMinutes ||
										String(DEFAULT_ORDER_ACCEPTANCE_TIMEOUT_MINUTES)
									}
									onValueChange={(v) =>
										set({ orderAcceptanceTimeoutMinutes: v })
									}
								/>
								<TextField
									id="acceptance-min-total"
									label={<Trans>Only for orders over ({currency})</Trans>}
									hint={
										<Trans>Leave empty to review every online order.</Trans>
									}
									error={errorFor('orderAcceptanceMinTotal')}
									// Text, not number: a number field drops Arabic-Indic digits
									// and the Arabic decimal mark; the server reads both.
									type="text"
									inputMode="decimal"
									dir="ltr"
									autoComplete="off"
									value={values.orderAcceptanceMinTotal}
									onChange={(e) =>
										set({ orderAcceptanceMinTotal: e.target.value })
									}
								/>
								<div className="flex items-center justify-between gap-3">
									<div>
										<Label htmlFor="acceptance-scheduled-only">
											<Trans>Only scheduled orders</Trans>
										</Label>
										<p
											id="acceptance-scheduled-only-hint"
											className="text-muted-foreground text-xs"
										>
											<Trans>
												Orders for right now go straight to the kitchen.
											</Trans>
										</p>
									</div>
									<Switch
										id="acceptance-scheduled-only"
										aria-describedby="acceptance-scheduled-only-hint"
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
