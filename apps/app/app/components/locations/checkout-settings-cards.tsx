'use client'

import { type MessageDescriptor } from '@lingui/core'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { MAX_TIP_CHOICES } from '@repo/common/location-types'
import {
	SERVICE_FEE_EXPLANATION_MAX_LENGTH,
	SERVICE_FEE_LABEL_MAX_LENGTH,
} from '@repo/common/service-fee'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Checkbox } from '@repo/ui/checkbox'
import { Label } from '@repo/ui/label'
import { Switch } from '@repo/ui/switch'
import { type ReactNode } from 'react'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import {
	TIP_ORDER_TYPES,
	type CheckoutSettingsCode,
	type CheckoutSettingsIssue,
	type FeeFormValues,
	type TipChoiceForm,
	type TipFormValues,
	type TipOrderTypeForm,
} from '#app/utils/orders/checkout-settings.ts'

const CODE_MESSAGES: Record<CheckoutSettingsCode, MessageDescriptor> = {
	invalid_percent: msg`Enter a whole percentage from 1 to 30.`,
	invalid_amount: msg`Enter an amount, for example 2 or 2.50.`,
	too_large: msg`That is more than is allowed.`,
	required: msg`This is needed.`,
	duplicate: msg`Each choice can only be listed once.`,
	invalid_choice: msg`Choose one of the listed options.`,
	invalid_fee: msg`Check the percentage and the amounts.`,
}

/** The message for a refused checkout field, in the reader's language. */
export function checkoutIssueMessage(
	issue: CheckoutSettingsIssue,
): MessageDescriptor {
	return CODE_MESSAGES[issue.code]
}

const ORDER_TYPE_TITLES = {
	pickup: msg`Pickup`,
	delivery: msg`Delivery`,
	qrTab: msg`Table tab`,
} as const

export function TipChoicesCard({
	currency,
	values,
	onChange,
	issue,
}: {
	currency: string
	values: TipFormValues
	onChange: (next: TipFormValues) => void
	/** The field the last save refused, until the next save. */
	issue?: CheckoutSettingsIssue | null
}) {
	const { _ } = useLingui()
	const tipsIssue = issue?.section === 'tips' ? issue : null
	const setType = (type: (typeof TIP_ORDER_TYPES)[number], next: TipOrderTypeForm) =>
		onChange({ ...values, [type]: next })

	return (
		<Card data-testid="tip-choices-card">
			<CardHeader>
				<CardTitle>
					<Trans>Tip choices at checkout</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Choose the tip buttons guests see for each kind of order. Turn tips
						off for an order type in the options above.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-6">
				{TIP_ORDER_TYPES.map((type) => {
					const section = values[type]
					const issueHere =
						tipsIssue && tipsIssue.field.startsWith(`${type}.`)
							? tipsIssue
							: null
					const issueField = issueHere?.field.slice(type.length + 1) ?? ''
					const choiceLabel = (choice: TipChoiceForm) =>
						choice.kind === 'percent'
							? `${choice.value || '?'}%`
							: `${choice.value || '?'} ${currency}`
					const defaultOptions = [
						{ value: '', label: _(msg`No tip selected`) },
						...section.choices.map((choice, index) => ({
							value: String(index),
							label: choiceLabel(choice),
						})),
					]
					const updateChoice = (index: number, patch: Partial<TipChoiceForm>) =>
						setType(type, {
							...section,
							choices: section.choices.map((choice, at) =>
								at === index ? { ...choice, ...patch } : choice,
							),
						})
					const removeChoice = (index: number) => {
						const kept = section.choices.filter((_, at) => at !== index)
						const current =
							section.defaultIndex === '' ? null : Number(section.defaultIndex)
						// The default follows its choice; removing it clears it.
						const nextDefault =
							current === null || current === index
								? ''
								: String(current > index ? current - 1 : current)
						setType(type, {
							...section,
							choices: kept,
							defaultIndex: nextDefault,
						})
					}
					return (
						<div
							key={type}
							className="space-y-3 border-t pt-4 first:border-t-0 first:pt-0"
							data-testid={`tip-choices-${type}`}
						>
							<h4 className="text-sm font-medium">{_(ORDER_TYPE_TITLES[type])}</h4>
							{section.choices.map((choice, index) => {
								const fieldError =
									issueField === `choice.${index}` && issueHere
										? _(checkoutIssueMessage(issueHere))
										: null
								return (
									<div
										key={index}
										className="grid grid-cols-[8rem_1fr_auto] items-start gap-2"
									>
										<SelectField
											id={`tip-${type}-kind-${index}`}
											label={<Trans>Type</Trans>}
											options={[
												{ value: 'percent', label: _(msg`Percent`) },
												{ value: 'amount', label: _(msg`Amount (${currency})`) },
											]}
											value={choice.kind}
											onValueChange={(v) =>
												updateChoice(index, {
													kind: v === 'amount' ? 'amount' : 'percent',
												})
											}
										/>
										<TextField
											id={`tip-${type}-value-${index}`}
											label={
												choice.kind === 'percent' ? (
													<Trans>Percent of the subtotal</Trans>
												) : (
													<Trans>Amount ({currency})</Trans>
												)
											}
											error={fieldError}
											// Text, not number: a number field drops Arabic-Indic digits.
											type="text"
											inputMode="decimal"
											dir="ltr"
											autoComplete="off"
											value={choice.value}
											onChange={(e) =>
												updateChoice(index, { value: e.target.value })
											}
										/>
										<Button
											type="button"
											variant="outline"
											size="sm"
											className="mt-6"
											onClick={() => removeChoice(index)}
										>
											<Trans>Remove</Trans>
										</Button>
									</div>
								)
							})}
							{issueField === 'choices' && issueHere ? (
								<p role="alert" className="text-destructive text-xs">
									{_(checkoutIssueMessage(issueHere))}
								</p>
							) : null}
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={section.choices.length >= MAX_TIP_CHOICES}
								onClick={() =>
									setType(type, {
										...section,
										choices: [...section.choices, { kind: 'percent', value: '' }],
									})
								}
							>
								<Trans>Add a choice</Trans>
							</Button>
							<SelectField
								id={`tip-${type}-default`}
								label={<Trans>Selected when checkout opens</Trans>}
								error={
									issueField === 'default' && issueHere
										? _(checkoutIssueMessage(issueHere))
										: null
								}
								options={defaultOptions}
								value={section.defaultIndex}
								onValueChange={(v) => setType(type, { ...section, defaultIndex: v })}
							/>
							<div className="flex items-center justify-between gap-3">
								<div>
									<Label htmlFor={`tip-${type}-custom`}>
										<Trans>Let guests enter their own amount</Trans>
									</Label>
									<p className="text-muted-foreground text-xs">
										<Trans>Shows a Custom button that opens an amount field.</Trans>
									</p>
								</div>
								<Switch
									id={`tip-${type}-custom`}
									checked={section.allowCustom}
									onCheckedChange={(c) =>
										setType(type, { ...section, allowCustom: c })
									}
								/>
							</div>
						</div>
					)
				})}
			</CardContent>
		</Card>
	)
}

export function ServiceFeeCard({
	currency,
	values,
	onChange,
	issue,
}: {
	currency: string
	values: FeeFormValues
	onChange: (next: FeeFormValues) => void
	issue?: CheckoutSettingsIssue | null
}) {
	const { _ } = useLingui()
	const set = (patch: Partial<FeeFormValues>) => onChange({ ...values, ...patch })
	const feeIssue = issue?.section === 'fee' ? issue : null
	const errorFor = (field: string) =>
		feeIssue?.field === field ? _(checkoutIssueMessage(feeIssue)) : null
	const money = (
		id: string,
		field: keyof FeeFormValues & string,
		label: ReactNode,
		hint?: ReactNode,
	) => (
		<TextField
			id={id}
			label={label}
			hint={hint}
			error={errorFor(field)}
			optional
			type="text"
			inputMode="decimal"
			dir="ltr"
			autoComplete="off"
			value={String(values[field])}
			onChange={(e) => set({ [field]: e.target.value } as Partial<FeeFormValues>)}
		/>
	)
	return (
		<Card data-testid="service-fee-card">
			<CardHeader>
				<CardTitle>
					<Trans>Service fee</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Add a small, clearly labeled fee to online orders. Guests see it as
						its own line before they pay.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="flex items-center justify-between gap-3">
					<Label htmlFor="service-fee-enabled">
						<Trans>Charge a service fee</Trans>
					</Label>
					<Switch
						id="service-fee-enabled"
						checked={values.enabled}
						onCheckedChange={(c) => set({ enabled: c })}
					/>
				</div>
				{values.enabled ? (
					<div className="space-y-4" data-testid="service-fee-fields">
						<TextField
							id="service-fee-percent"
							label={<Trans>Percentage of the subtotal</Trans>}
							hint={
								<Trans>
									Up to 10. Worked out on the subtotal after discounts, before tax
									and tip.
								</Trans>
							}
							error={errorFor('percent')}
							optional
							type="text"
							inputMode="decimal"
							dir="ltr"
							autoComplete="off"
							value={values.percent}
							onChange={(e) => set({ percent: e.target.value })}
						/>
						{money('service-fee-fixed', 'fixed', <Trans>Fixed amount ({currency})</Trans>)}
						{money(
							'service-fee-cap',
							'cap',
							<Trans>Most per order ({currency})</Trans>,
							<Trans>Leave empty for no limit. The cap can not be 0.</Trans>,
						)}
						<div className="grid gap-4 sm:grid-cols-2">
							{money(
								'service-fee-small-below',
								'smallOrderBelow',
								<Trans>Small order: subtotal below ({currency})</Trans>,
							)}
							{money(
								'service-fee-small-fee',
								'smallOrderFee',
								<Trans>Small order fee ({currency})</Trans>,
								<Trans>
									Charged instead of the percentage and fixed amount on small
									orders.
								</Trans>,
							)}
						</div>
						<fieldset className="space-y-2">
							<legend className="text-sm font-medium">
								<Trans>Applies to</Trans>
							</legend>
							<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
								{(
									[
										['pickup', msg`Pickup`],
										['delivery', msg`Delivery`],
										['dineIn', msg`Table tab`],
									] as const
								).map(([key, title]) => (
									<label
										key={key}
										className="hover:bg-muted/40 flex cursor-pointer items-center gap-2.5 rounded-md border p-3"
									>
										<Checkbox
											checked={values[key]}
											onCheckedChange={(c) => set({ [key]: c === true })}
										/>
										<span className="text-xs font-medium">{_(title)}</span>
									</label>
								))}
							</div>
							{errorFor('fulfillments') ? (
								<p role="alert" className="text-destructive text-xs">
									{errorFor('fulfillments')}
								</p>
							) : null}
						</fieldset>
						<TextField
							id="service-fee-label"
							label={<Trans>Name guests see</Trans>}
							hint={<Trans>Leave empty for “Service fee”.</Trans>}
							error={errorFor('label')}
							maxLength={SERVICE_FEE_LABEL_MAX_LENGTH}
							value={values.label}
							onChange={(e) => set({ label: e.target.value })}
						/>
						<TextField
							id="service-fee-explanation"
							label={<Trans>Explanation</Trans>}
							hint={<Trans>Shown when a guest taps the fee at checkout.</Trans>}
							error={errorFor('explanation')}
							optional
							maxLength={SERVICE_FEE_EXPLANATION_MAX_LENGTH}
							value={values.explanation}
							onChange={(e) => set({ explanation: e.target.value })}
						/>
						<div className="flex items-center justify-between gap-3">
							<div>
								<Label htmlFor="service-fee-taxable">
									<Trans>Charge tax on the fee</Trans>
								</Label>
								<p className="text-muted-foreground text-xs">
									<Trans>
										Uses this location&apos;s tax rate. In Saudi Arabia VAT
										applies to service charges.
									</Trans>
								</p>
							</div>
							<Switch
								id="service-fee-taxable"
								checked={values.taxable}
								onCheckedChange={(c) => set({ taxable: c })}
							/>
						</div>
					</div>
				) : null}
			</CardContent>
		</Card>
	)
}
