import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	getPayRange,
	type JobEmploymentType,
	type JobPayType,
	type JobPostingStatus,
	type ScreenerCategory,
} from '@repo/common/job-posting'
import { useMemo } from 'react'
import { type Option } from '#app/components/staff/controls.tsx'
import { formatMoneyMinor } from '#app/utils/staffing/staff-format.ts'

/** Plain-language labels for the hiring screens, translated once per render. */
export function useJobLabels() {
	const { _, i18n } = useLingui()
	return useMemo(() => {
		const employment: Record<JobEmploymentType, string> = {
			full_time: _(t`Full time`),
			part_time: _(t`Part time`),
			seasonal: _(t`Seasonal`),
			temporary: _(t`Temporary`),
			contract: _(t`Contract`),
			internship: _(t`Internship`),
		}
		const pay: Record<JobPayType, string> = {
			none: _(t`Do not show pay`),
			hourly: _(t`Per hour`),
			weekly: _(t`Per week`),
			monthly: _(t`Per month`),
			yearly: _(t`Per year`),
		}
		const per: Record<Exclude<JobPayType, 'none'>, string> = {
			hourly: _(t`hour`),
			weekly: _(t`week`),
			monthly: _(t`month`),
			yearly: _(t`year`),
		}
		const category: Record<ScreenerCategory, string> = {
			availability: _(t`Availability`),
			experience: _(t`Experience`),
			transport: _(t`Transport`),
			work_eligibility: _(t`Work eligibility`),
			certification: _(t`Certification`),
			language: _(t`Language`),
			other: _(t`Other`),
		}
		const status: Record<JobPostingStatus, string> = {
			draft: _(t`Draft`),
			published: _(t`Live`),
			closed: _(t`Closed`),
			expired: _(t`Ended`),
		}
		const options = <K extends string>(map: Record<K, string>): Option[] =>
			(Object.keys(map) as K[]).map((value) => ({ value, label: map[value] }))

		/** "$18 – $22 per hour", or null when the posting shows no pay. */
		function payLine(posting: {
			payType: JobPayType
			payMinMinor: number | null
			payMaxMinor: number | null
			currency: string
		}) {
			const range = getPayRange(posting)
			if (!range) return null
			const money = (amount: number) =>
				formatMoneyMinor(Math.round(amount * 100), range.currency, i18n.locale)
			const amount =
				range.min === range.max
					? money(range.min)
					: `${money(range.min)} – ${money(range.max)}`
			const unit = per[range.period]
			return _(t`${amount} per ${unit}`)
		}

		return {
			employment,
			pay,
			category,
			status,
			employmentOptions: options(employment),
			payOptions: options(pay),
			categoryOptions: options(category),
			payLine,
		}
	}, [_, i18n.locale])
}
