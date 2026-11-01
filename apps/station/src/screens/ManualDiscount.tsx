import { plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { useMemo, useState } from 'react'
import { toCents, type MoneyFormatter } from '~/lib/money.ts'
import { usePos } from '~/lib/store.ts'
import {
	limitedAutomaticRules,
	parseTillRules,
	tillRulesStatus,
	TILL_RULES_MAX_AGE_MS,
} from '~/lib/till-discounts.ts'
import { Button, Input, Select } from '~/ui/primitives.tsx'

/**
 * Accepts 10.5, 10,5, Arabic-Indic digits and the Arabic decimal separator
 * (U+066B, `٫`; its thousands separator U+066C is ignored). Null when it is not
 * a number.
 */
export function parseDecimal(raw: string): number | null {
	const normalized = raw
		.trim()
		.replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
		.replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
		.replace(/\u066C/g, '')
		.replace(/[\u066B,]/, '.')
	if (!/^\d+(\.\d+)?$/.test(normalized)) return null
	const value = Number(normalized)
	return Number.isFinite(value) ? value : null
}

/** Names as the till's language lists them ("A, B and C"). */
function listText(names: readonly string[], locale: string): string {
	try {
		return new Intl.ListFormat(locale || 'en', {
			style: 'long',
			type: 'conjunction',
		}).format(names)
	} catch {
		return names.join(', ')
	}
}

type ErrorField = 'value' | 'pin' | 'reason'

/** Cashier-applied discounts from the published till rules. */
export function ManualDiscount({
	disabled,
	money,
}: {
	disabled: boolean
	money: MoneyFormatter
}) {
	const { _, i18n } = useLingui()
	const ruleSource = usePos((state) => state.snapshot?.menu.discountRules)
	const rulesState = usePos((state) => tillRulesStatus(state.snapshot).state)
	const limitedCount = useMemo(
		() => limitedAutomaticRules(ruleSource).length,
		[ruleSource],
	)
	// Rules that are too old are not applied, automatic or manual.
	const stale = rulesState === 'expired'
	const reasonText = (reason: string, maxMinor?: number): string => {
		const most = money(maxMinor ?? 0)
		switch (reason) {
			case 'over_100':
				return _(t`A percentage cannot be more than 100.`)
			case 'over_bill':
				return _(
					t`That is more than this order can take off. The most is ${most}.`,
				)
			case 'over_max':
				return _(t`This discount is limited to ${most} at most.`)
			case 'value_required':
				return _(t`Enter how much to take off, an amount or a percentage.`)
			case 'rules_stale':
				return _(
					t`Discounts are off until this till refreshes its rules. Connect to the internet.`,
				)
			case 'not_found':
				return _(t`That discount is no longer available.`)
			case 'expired':
			case 'not_started':
			case 'not_available_now':
			case 'wrong_location':
			case 'wrong_channel':
				return _(t`That discount is not available right now.`)
			case 'wrong_fulfillment':
				return _(t`That discount does not apply to this kind of order.`)
			case 'minimum_not_met':
				return _(t`This order is below the minimum spend for that discount.`)
			case 'requirement_not_met':
			case 'quantity_not_met':
				return _(t`This order does not have the items that discount needs.`)
			default:
				return _(t`That discount does not apply to this order.`)
		}
	}
	const rules = useMemo(
		() =>
			parseTillRules(ruleSource).filter(
				(rule) => rule.application === 'manual',
			),
		[ruleSource],
	)
	const apply = usePos((state) => state.applyManualDiscount)
	const remove = usePos((state) => state.removeManualDiscount)
	const approve = usePos((state) => state.approve)
	const signInRequired = usePos((state) => state.settings.signInRequired)
	const online = usePos((state) => state.online)
	const notice = usePos((state) => state.discountNotice)
	const clearNotice = usePos((state) => state.clearDiscountNotice)
	const appliedManualId = usePos((state) => {
		const row = state.adjustments.find((adjustment) =>
			adjustment.id.startsWith('manual:'),
		)
		return row?.id.split(':')[1] ?? null
	})
	const appliedManualName = usePos(
		(state) =>
			state.adjustments.find((adjustment) =>
				adjustment.id.startsWith('manual:'),
			)?.label ?? null,
	)
	// Null until the cashier chooses: the choice then follows the discount on the
	// order, so it survives this panel mounting again.
	const [chosenId, setChosenId] = useState<string | null>(null)
	const discountId = chosenId ?? appliedManualId ?? ''
	const [value, setValue] = useState('')
	const [pin, setPin] = useState('')
	const [reason, setReason] = useState('')
	const [message, setMessageText] = useState<string | null>(null)
	const [errorField, setErrorField] = useState<ErrorField | null>(null)
	const setMessage = (text: string | null, field: ErrorField | null = null) => {
		setMessageText(text)
		setErrorField(text ? field : null)
	}
	const selected = rules.find((rule) => rule.id === discountId) ?? null
	if (
		rules.length === 0 &&
		!stale &&
		limitedCount === 0 &&
		!appliedManualId &&
		notice?.kind !== 'kept' &&
		notice?.kind !== 'stopped' &&
		notice?.kind !== 'replaced' &&
		notice?.kind !== 'rules_old'
	)
		return null

	const variable =
		selected?.valueType === 'variable_amount' ||
		selected?.valueType === 'variable_percent'
	const blocked = disabled || stale
	const staleHours = Math.round(TILL_RULES_MAX_AGE_MS / 3_600_000)
	const replacedNames =
		notice?.kind === 'replaced' ? listText(notice.names, i18n.locale) : ''
	const replacedCount = notice?.kind === 'replaced' ? notice.names.length : 0
	const skippedNames =
		notice?.kind === 'rules_old' ? listText(notice.names, i18n.locale) : ''
	const stoppedName = notice?.kind === 'stopped' ? (notice.name ?? '') : ''
	const stoppedWhy =
		notice?.kind === 'stopped' && notice.reason && notice.reason !== 'error'
			? reasonText(notice.reason, notice.maxMinor)
			: ''
	const invalid = (field: ErrorField) =>
		errorField === field && message ? true : undefined
	const describedBy = (field: ErrorField) =>
		errorField === field && message ? 'till-discount-message' : undefined
	const currentName = appliedManualName ?? ''

	const submit = async () => {
		if (!selected) return
		// Check what was typed before asking for a PIN, so a typo costs no approval.
		let amountMinor: number | undefined
		let percentBp: number | undefined
		if (variable) {
			const amount = parseDecimal(value)
			if (amount === null) {
				setMessage(_(t`Enter a number, such as 10 or 10.5.`), 'value')
				return
			}
			if (amount <= 0) {
				setMessage(reasonText('value_required'), 'value')
				return
			}
			if (selected.valueType === 'variable_amount') {
				amountMinor = toCents(amount)
			} else {
				percentBp = Math.round(amount * 100)
				if (percentBp > 10_000) {
					setMessage(reasonText('over_100'), 'value')
					return
				}
			}
		}
		let approvedByStaffId: string | undefined
		if (selected.requireApproval) {
			if (!reason.trim()) {
				setMessage(_(t`Enter a reason for this discount.`), 'reason')
				return
			}
			if (signInRequired) {
				if (!pin.trim()) {
					setMessage(_(t`Enter a manager PIN to apply this discount.`), 'pin')
					return
				}
				const approved = await approve(pin)
				setPin('')
				if (!approved.ok) {
					// The PIN was not accepted: the message says why (wrong PIN, not a
					// manager, or how long to wait).
					setMessage(approved.message, 'pin')
					return
				}
				approvedByStaffId = approved.manager.id
			}
		}
		const result = apply(selected.id, {
			...(amountMinor !== undefined ? { amountMinor } : {}),
			...(percentBp !== undefined ? { percentBp } : {}),
			...(approvedByStaffId ? { approvedByStaffId } : {}),
			...(reason.trim() ? { reason: reason.trim() } : {}),
		})
		if (result.ok) {
			const replaced = result.replacedManual
			setMessage(
				replaced
					? _(t`Discount applied. It replaced ${replaced}.`)
					: _(t`Discount applied`),
			)
			setPin('')
			setReason('')
		} else {
			setMessage(
				reasonText(result.reason, result.maxMinor),
				variable &&
					(result.reason === 'over_100' ||
						result.reason === 'over_bill' ||
						result.reason === 'over_max' ||
						result.reason === 'value_required')
					? 'value'
					: null,
			)
		}
	}

	return (
		<div className="space-y-2">
			{stale ? (
				<p
					role="status"
					className="notice-warning rounded-md px-3 py-2 text-sm"
				>
					{_(
						t`Discounts are off: this till has not refreshed its discount rules in over ${staleHours} hours. Connect to the internet and they come back.`,
					)}
				</p>
			) : null}
			{rules.length > 0 ? (
				<>
					{/* One row: the label beside the choice saves a line of height, which
				    on a short screen is a line of the order the cashier can see. */}
					<div className="flex items-center gap-3">
						<label
							className="shrink-0 text-sm font-medium"
							htmlFor="till-discount"
						>
							{_(t`Discount`)}
						</label>
						<div className="min-w-0 flex-1">
							<Select
								id="till-discount"
								value={discountId}
								disabled={blocked}
								aria-label={_(t`Discount`)}
								onChange={(event) => {
									setChosenId(event.currentTarget.value)
									setValue('')
									setPin('')
									setReason('')
									setMessage(null)
								}}
							>
								<option value="">{_(t`None`)}</option>
								{rules.map((rule) => (
									<option key={rule.id} value={rule.id}>
										{rule.name}
									</option>
								))}
							</Select>
						</div>
					</div>
					{variable ? (
						<div className="space-y-1">
							<label
								className="block text-sm font-medium"
								htmlFor="till-discount-value"
							>
								{selected?.valueType === 'variable_percent'
									? _(t`Percent`)
									: _(t`Amount`)}
							</label>
							<Input
								id="till-discount-value"
								inputMode="decimal"
								value={value}
								disabled={blocked}
								aria-invalid={invalid('value')}
								aria-describedby={describedBy('value')}
								onChange={(event) => setValue(event.currentTarget.value)}
							/>
						</div>
					) : null}
					{selected?.requireApproval ? (
						<div className="space-y-1">
							{signInRequired ? (
								<>
									<label
										className="block text-sm font-medium"
										htmlFor="till-discount-pin"
									>
										{_(t`Manager PIN`)}
									</label>
									<Input
										id="till-discount-pin"
										type="password"
										value={pin}
										disabled={blocked}
										inputMode="numeric"
										autoComplete="off"
										aria-invalid={invalid('pin')}
										aria-describedby={describedBy('pin')}
										onChange={(event) => setPin(event.currentTarget.value)}
									/>
								</>
							) : null}
							<label
								className="block text-sm font-medium"
								htmlFor="till-discount-reason"
							>
								{_(t`Reason`)}
							</label>
							<Input
								id="till-discount-reason"
								value={reason}
								disabled={blocked}
								maxLength={200}
								aria-invalid={invalid('reason')}
								aria-describedby={describedBy('reason')}
								onChange={(event) => setReason(event.currentTarget.value)}
							/>
						</div>
					) : null}
					{selected ? (
						<Button
							type="button"
							variant="outline"
							size="lg"
							className="w-full"
							disabled={blocked}
							onClick={() => {
								void submit()
							}}
						>
							{_(t`Apply discount`)}
						</Button>
					) : null}
					{selected && appliedManualId && appliedManualId !== selected.id ? (
						<p className="text-muted-foreground text-sm">
							{_(
								t`Only one discount can be applied. This replaces ${currentName}.`,
							)}
						</p>
					) : null}
				</>
			) : null}
			{appliedManualId ? (
				<Button
					type="button"
					variant="outline"
					size="lg"
					className="w-full"
					disabled={disabled}
					onClick={() => {
						remove(appliedManualId)
						setChosenId('')
						setMessage(_(t`Discount removed`))
					}}
				>
					{_(t`Remove discount`)}
				</Button>
			) : null}
			{/* One live region: the messages inside are plain text, so each
			    change is announced once. */}
			<div aria-live="polite" aria-atomic="true">
				{message ? (
					<p id="till-discount-message" className="text-sm">
						{message}
					</p>
				) : null}
				{notice?.kind === 'stopped' ? (
					<p className="text-sm">
						{stoppedName
							? _(t`The ${stoppedName} discount was taken off this order.`)
							: _(t`A discount no longer applies to this order.`)}
						{stoppedWhy ? ` ${stoppedWhy}` : ''}
					</p>
				) : null}
				{notice?.kind === 'rules_old' ? (
					<p className="text-sm">
						{_(
							t`Not applied: ${skippedNames}. This till’s discount rules are over ${staleHours} hours old. Go online to refresh them.`,
						)}
					</p>
				) : null}
				{notice?.kind === 'kept' ? (
					<p className="text-sm">
						{_(
							t`Some discounts on this tab are no longer offered; the guest keeps them.`,
						)}
					</p>
				) : null}
				{notice?.kind === 'replaced' ? (
					<p className="text-sm">
						{_(
							plural(replacedCount, {
								one: `This discount does not combine with ${replacedNames}, so it replaced it.`,
								other: `This discount does not combine with ${replacedNames}, so it replaced them.`,
							}),
						)}
					</p>
				) : null}
			</div>
			{notice ? (
				<Button
					type="button"
					variant="ghost"
					size="md"
					className="w-full"
					onClick={clearNotice}
				>
					{_(t`Dismiss`)}
				</Button>
			) : null}
			{limitedCount > 0 ? (
				<p className="text-muted-foreground text-sm">
					{_(
						t`Discounts with a use limit do not apply at the till by themselves, because it cannot count uses offline.`,
					)}
				</p>
			) : null}
			{!online ? (
				<p className="text-muted-foreground text-sm">
					{_(
						t`A coupon code needs a connection. Automatic discounts still apply.`,
					)}
				</p>
			) : null}
		</div>
	)
}
