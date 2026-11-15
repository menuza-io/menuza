/**
 * Location settings for what a guest pays at online checkout: the tip buttons
 * per order type (#118) and the service fee (#123). The form keeps every
 * number as the text the person typed (Arabic-Indic digits and the Arabic
 * decimal mark read like ASCII ones); this file turns that text into the
 * shared `TipSettings` and `ServiceFeeSettings`, which the order region reads,
 * and back. A refusal names the section, the field and a code (the form words
 * it in the reader's language); it never echoes what was typed.
 */
import {
	MAX_TIP_CHOICES,
	TipSettingsSchema,
	type TipChoice,
	type TipOrderType,
	type TipOrderTypeSettings,
	type TipSettings,
} from '@repo/common/location-types'
import { TIP_MAX_PERCENT } from '@repo/common/order-tips'
import {
	DEFAULT_SERVICE_FEE_LABEL,
	SERVICE_FEE_FULFILLMENTS,
	SERVICE_FEE_LABEL_MAX_LENGTH,
	SERVICE_FEE_EXPLANATION_MAX_LENGTH,
	SERVICE_FEE_MAX_PERCENT_BP,
	defaultServiceFeeSettings,
	serviceFeeAmountsWithinLimit,
	serviceFeeSettingsSchema,
	type ServiceFeeSettings,
} from '@repo/common/service-fee'
import {
	minorToMajorText,
	parseMoneyToMinor,
	parseWholeNumber,
} from '#app/utils/money-input.ts'

export const TIP_ORDER_TYPES = ['pickup', 'delivery', 'qrTab'] as const

/** One tip button as typed. */
export type TipChoiceForm = { kind: 'percent' | 'amount'; value: string }

export type TipOrderTypeForm = {
	choices: TipChoiceForm[]
	/** '' is no preselected tip; otherwise the index of the choice. */
	defaultIndex: string
	allowCustom: boolean
}

export type TipFormValues = Record<TipOrderType, TipOrderTypeForm>

export type FeeFormValues = {
	enabled: boolean
	/** A percentage of the subtotal as typed, up to two decimals ("3", "2.5"). */
	percent: string
	/** Major units, blank is none. */
	fixed: string
	cap: string
	smallOrderBelow: string
	smallOrderFee: string
	pickup: boolean
	delivery: boolean
	dineIn: boolean
	label: string
	explanation: string
	taxable: boolean
}

export type CheckoutSettingsCode =
	| 'invalid_percent'
	| 'invalid_amount'
	| 'too_large'
	| 'required'
	| 'duplicate'
	| 'invalid_choice'
	| 'invalid_fee'

export type CheckoutSettingsIssue = {
	section: 'tips' | 'fee'
	/** `pickup.choice.2`, `delivery.default`, `percent`, `cap`, ... */
	field: string
	code: CheckoutSettingsCode
}

// ---------------------------------------------------------------------------
// Tips
// ---------------------------------------------------------------------------

function tipChoiceToForm(
	choice: TipChoice,
	currency: string,
): TipChoiceForm {
	return 'percent' in choice
		? { kind: 'percent', value: String(choice.percent) }
		: { kind: 'amount', value: minorToMajorText(choice.amountMinor, currency) }
}

function tipOrderTypeToForm(
	settings: TipOrderTypeSettings,
	currency: string,
): TipOrderTypeForm {
	return {
		choices: settings.choices.map((choice) => tipChoiceToForm(choice, currency)),
		defaultIndex:
			settings.defaultIndex === null ? '' : String(settings.defaultIndex),
		allowCustom: settings.allowCustom,
	}
}

export function tipFormFromSettings(
	settings: TipSettings,
	currency: string,
): TipFormValues {
	return {
		pickup: tipOrderTypeToForm(settings.pickup, currency),
		delivery: tipOrderTypeToForm(settings.delivery, currency),
		qrTab: tipOrderTypeToForm(settings.qrTab, currency),
	}
}

type TipResult =
	| { ok: true; settings: TipSettings }
	| { ok: false; issue: CheckoutSettingsIssue }

export function tipSettingsFromForm(
	form: TipFormValues,
	currency: string,
): TipResult {
	const parsed: Partial<Record<TipOrderType, TipOrderTypeSettings>> = {}
	for (const type of TIP_ORDER_TYPES) {
		const section = form[type]
		const refuse = (field: string, code: CheckoutSettingsCode): TipResult => ({
			ok: false,
			issue: { section: 'tips', field: `${type}.${field}`, code },
		})
		if (!section || !Array.isArray(section.choices)) {
			return refuse('choices', 'invalid_choice')
		}
		if (section.choices.length > MAX_TIP_CHOICES) {
			return refuse('choices', 'too_large')
		}
		const choices: TipChoice[] = []
		for (const [index, choice] of section.choices.entries()) {
			const text = String(choice?.value ?? '')
			if (choice?.kind === 'percent') {
				const percent = parseWholeNumber(text, { min: 1, max: TIP_MAX_PERCENT })
				if (percent === null) return refuse(`choice.${index}`, 'invalid_percent')
				choices.push({ percent })
			} else if (choice?.kind === 'amount') {
				const amountMinor = parseMoneyToMinor(text, {
					currency,
					min: 1,
					max: 1_000_000,
				})
				if (amountMinor === null) {
					return refuse(`choice.${index}`, 'invalid_amount')
				}
				choices.push({ amountMinor })
			} else {
				return refuse(`choice.${index}`, 'invalid_choice')
			}
		}
		const keys = choices.map((choice) =>
			'percent' in choice ? `p${choice.percent}` : `a${choice.amountMinor}`,
		)
		if (new Set(keys).size !== keys.length) return refuse('choices', 'duplicate')
		let defaultIndex: number | null = null
		if (section.defaultIndex !== '' && section.defaultIndex != null) {
			const index = parseWholeNumber(String(section.defaultIndex))
			if (index === null || index >= choices.length) {
				return refuse('default', 'invalid_choice')
			}
			defaultIndex = index
		}
		if (choices.length === 0 && section.allowCustom !== true) {
			return refuse('choices', 'required')
		}
		parsed[type] = {
			choices,
			defaultIndex,
			allowCustom: section.allowCustom === true,
		}
	}
	const result = TipSettingsSchema.safeParse(parsed)
	if (!result.success) {
		return {
			ok: false,
			issue: { section: 'tips', field: 'pickup.choices', code: 'invalid_choice' },
		}
	}
	return { ok: true, settings: result.data }
}

// ---------------------------------------------------------------------------
// Service fee
// ---------------------------------------------------------------------------

export function feeFormFromSettings(
	settings: ServiceFeeSettings,
	currency: string,
): FeeFormValues {
	const money = (minor: number | null) =>
		minor === null ? '' : minorToMajorText(minor, currency)
	return {
		enabled: settings.enabled,
		percent: settings.percentBp === 0 ? '' : String(settings.percentBp / 100),
		fixed: settings.fixedMinor === 0 ? '' : money(settings.fixedMinor),
		cap: money(settings.capMinor),
		smallOrderBelow: money(settings.smallOrderBelowMinor),
		smallOrderFee: money(settings.smallOrderFeeMinor),
		pickup: settings.fulfillments.includes('pickup'),
		delivery: settings.fulfillments.includes('delivery'),
		dineIn: settings.fulfillments.includes('dine_in'),
		label: settings.label,
		explanation: settings.explanation ?? '',
		taxable: settings.taxable,
	}
}

/** The form of a location that has saved no fee yet. */
export function emptyFeeForm(currency: string): FeeFormValues {
	return feeFormFromSettings(defaultServiceFeeSettings(currency), currency)
}

type FeeResult =
	| { ok: true; settings: ServiceFeeSettings }
	| { ok: false; issue: CheckoutSettingsIssue }

export function serviceFeeFromForm(
	form: FeeFormValues,
	currency: string,
): FeeResult {
	const refuse = (field: string, code: CheckoutSettingsCode): FeeResult => ({
		ok: false,
		issue: { section: 'fee', field, code },
	})
	const optionalMinor = (text: string, field: string) => {
		if (String(text ?? '').trim() === '') return { value: null as number | null }
		const value = parseMoneyToMinor(String(text), { currency, min: 0 })
		return value === null ? { error: refuse(field, 'invalid_amount') } : { value }
	}
	let percentBp = 0
	if (String(form.percent ?? '').trim() !== '') {
		// Two decimals read as basis points: "3" is 300, "2.5" is 250.
		const parsed = parseMoneyToMinor(String(form.percent), {
			min: 0,
			max: SERVICE_FEE_MAX_PERCENT_BP,
		})
		if (parsed === null) {
			return refuse(
				'percent',
				Number.isNaN(Number(form.percent)) ? 'invalid_percent' : 'too_large',
			)
		}
		percentBp = parsed
	}
	const fixed = optionalMinor(form.fixed, 'fixed')
	if (fixed.error) return fixed.error
	const cap = optionalMinor(form.cap, 'cap')
	if (cap.error) return cap.error
	if (cap.value === 0) return refuse('cap', 'invalid_amount')
	const below = optionalMinor(form.smallOrderBelow, 'smallOrderBelow')
	if (below.error) return below.error
	const smallFee = optionalMinor(form.smallOrderFee, 'smallOrderFee')
	if (smallFee.error) return smallFee.error
	if ((below.value === null) !== (smallFee.value === null)) {
		return refuse(
			below.value === null ? 'smallOrderBelow' : 'smallOrderFee',
			'required',
		)
	}
	const fulfillments = SERVICE_FEE_FULFILLMENTS.filter((type) =>
		type === 'pickup'
			? form.pickup
			: type === 'delivery'
				? form.delivery
				: form.dineIn,
	)
	const label = String(form.label ?? '').trim() || DEFAULT_SERVICE_FEE_LABEL
	if (label.length > SERVICE_FEE_LABEL_MAX_LENGTH) {
		return refuse('label', 'too_large')
	}
	const explanation = String(form.explanation ?? '').trim()
	if (explanation.length > SERVICE_FEE_EXPLANATION_MAX_LENGTH) {
		return refuse('explanation', 'too_large')
	}
	const candidate = {
		enabled: form.enabled === true,
		percentBp,
		fixedMinor: fixed.value ?? 0,
		capMinor: cap.value ?? null,
		smallOrderBelowMinor: below.value,
		smallOrderFeeMinor: smallFee.value,
		fulfillments,
		label,
		explanation: explanation === '' ? null : explanation,
		taxable: form.taxable === true,
	}
	const result = serviceFeeSettingsSchema.safeParse(candidate)
	if (!result.success) {
		const key = String(result.error.issues[0]?.path[0] ?? '')
		const field =
			key === 'fulfillments'
				? 'fulfillments'
				: key === 'capMinor'
					? 'cap'
					: key === 'smallOrderFeeMinor'
						? 'smallOrderFee'
						: 'percent'
		return refuse(field, field === 'fulfillments' ? 'required' : 'invalid_fee')
	}
	if (!serviceFeeAmountsWithinLimit(result.data, currency)) {
		return refuse('fixed', 'too_large')
	}
	return { ok: true, settings: result.data }
}

// ---------------------------------------------------------------------------
// The posted form
// ---------------------------------------------------------------------------

export type CheckoutSettingsPatch = {
	/** JSON `TipSettings`. */
	tipSettings?: string
	/** JSON `ServiceFeeSettings`. */
	serviceFee?: string
}

function readJson(value: unknown): unknown {
	if (typeof value !== 'string' || value === '') return undefined
	try {
		return JSON.parse(value)
	} catch {
		return null
	}
}

/**
 * Reads the posted `checkoutTips` and `checkoutFee` fields (JSON of the form
 * values) into column values. A field that was not posted is left alone, and
 * the fee group is skipped while `ordering.service_fee` is off, so a hidden or
 * stale form cannot change it.
 */
export function parseCheckoutSettingsFields(
	raw: Record<string, unknown>,
	options: { currency: string; serviceFeeEnabled: boolean },
):
	| { ok: true; patch: CheckoutSettingsPatch }
	| { ok: false; error: string; issue: CheckoutSettingsIssue } {
	const patch: CheckoutSettingsPatch = {}
	const tips = readJson(raw.checkoutTips)
	if (tips !== undefined) {
		const result =
			tips && typeof tips === 'object'
				? tipSettingsFromForm(tips as TipFormValues, options.currency)
				: ({
						ok: false,
						issue: {
							section: 'tips',
							field: 'pickup.choices',
							code: 'invalid_choice',
						},
					} as const)
		if (!result.ok) {
			return { ok: false, error: 'Check the tip choices.', issue: result.issue }
		}
		patch.tipSettings = JSON.stringify(result.settings)
	}
	if (options.serviceFeeEnabled) {
		const fee = readJson(raw.checkoutFee)
		if (fee !== undefined) {
			const result =
				fee && typeof fee === 'object'
					? serviceFeeFromForm(fee as FeeFormValues, options.currency)
					: ({
							ok: false,
							issue: { section: 'fee', field: 'percent', code: 'invalid_fee' },
						} as const)
			if (!result.ok) {
				return {
					ok: false,
					error: 'Check the service fee settings.',
					issue: result.issue,
				}
			}
			patch.serviceFee = JSON.stringify(result.settings)
		}
	}
	return { ok: true, patch }
}
