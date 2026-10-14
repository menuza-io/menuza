import { type I18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import {
	getPayRange,
	type JobEmploymentType,
	type JobPayType,
} from '@repo/common/job-posting'
import { translate } from '~/lib/translate.ts'

/** Plain-language labels for a job posting, in the visitor's language. */
export function employmentLabel(i18n: I18n, type: JobEmploymentType): string {
	switch (type) {
		case 'full_time':
			return i18n._(msg`Full time`)
		case 'part_time':
			return i18n._(msg`Part time`)
		case 'seasonal':
			return i18n._(msg`Seasonal`)
		case 'temporary':
			return i18n._(msg`Temporary`)
		case 'contract':
			return i18n._(msg`Contract`)
		case 'internship':
			return i18n._(msg`Internship`)
	}
}

function perLabel(i18n: I18n, period: Exclude<JobPayType, 'none'>): string {
	switch (period) {
		case 'hourly':
			return i18n._(msg`hour`)
		case 'weekly':
			return i18n._(msg`week`)
		case 'monthly':
			return i18n._(msg`month`)
		case 'yearly':
			return i18n._(msg`year`)
	}
}

/** "$18 – $22 per hour", or `null` when the posting shows no pay. */
export function payLine(
	i18n: I18n,
	locale: string,
	posting: {
		payType: JobPayType
		payMinMinor: number | null
		payMaxMinor: number | null
		currency: string
	},
): string | null {
	const range = getPayRange(posting)
	if (!range) return null
	const money = (amount: number) =>
		new Intl.NumberFormat(locale, {
			style: 'currency',
			currency: range.currency,
			// Whole amounts read cleaner ("$18") unless there are cents.
			minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
			maximumFractionDigits: 2,
		}).format(amount)
	const amount =
		range.min === range.max
			? money(range.min)
			: `${money(range.min)} – ${money(range.max)}`
	return translate(i18n, msg`{amount} per {unit}`, {
		amount,
		unit: perLabel(i18n, range.period),
	})
}
