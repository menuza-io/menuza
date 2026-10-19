import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { type ReactNode } from 'react'
import {
	type ReportByKind,
	type ReportKind,
} from '#app/utils/reservations/reports-api.ts'
import {
	formatMinutes,
	formatPercent,
} from '#app/utils/reservations/reports-view.ts'

type Insightful = {
	[K in ReportKind]: { kind: K; report: ReportByKind[K] }
}[ReportKind]

/** Share of parties that no-showed, in percent with one decimal; null with no parties. */
export function summaryNoShowRate(
	report: ReportByKind['summary'],
): number | null {
	const parties = report.totals.parties
	if (parties <= 0) return null
	const noShows =
		report.byStatus.find((row) => row.status === 'no_show')?.parties ?? 0
	return Math.round((noShows / parties) * 1000) / 10
}

/**
 * One sentence that says what the numbers mean, computed from what is already
 * loaded. Returns nothing when there is nothing honest to say (no data, or no
 * earlier period to compare with).
 */
export function ReportInsight({
	loaded,
	previous,
}: {
	loaded: Insightful
	/** The summary of the period just before the one shown, when it was loaded. */
	previous: ReportByKind['summary'] | null
}) {
	const { t, i18n } = useLingui()
	const pct = (value: number) => formatPercent(value, i18n.locale)
	let text: ReactNode = null

	switch (loaded.kind) {
		case 'summary': {
			const rate = summaryNoShowRate(loaded.report)
			if (rate === null) break
			const prior = previous ? summaryNoShowRate(previous) : null
			const rateText = pct(rate)
			if (prior === null) {
				text = t`No-show rate ${rateText}.`
			} else {
				const priorText = pct(prior)
				text =
					rate > prior
						? t`No-show rate ${rateText}, up from ${priorText} in the period before.`
						: rate < prior
							? t`No-show rate ${rateText}, down from ${priorText} in the period before.`
							: t`No-show rate ${rateText}, the same as in the period before.`
			}
			break
		}
		case 'no-shows': {
			const { total, covers } = loaded.report
			if (total <= 0) break
			text = (
				<Trans>
					<Plural value={total} one="# no-show" other="# no-shows" /> left{' '}
					<Plural value={covers} one="# seat" other="# seats" /> empty.
				</Trans>
			)
			break
		}
		case 'cancellations': {
			const { total, late } = loaded.report
			if (total <= 0) break
			text = (
				<Trans>
					{late} of{' '}
					<Plural value={total} one="# cancellation" other="# cancellations" />{' '}
					came late.
				</Trans>
			)
			break
		}
		case 'turn-times': {
			const avg = formatMinutes(loaded.report.actualAvgMin, i18n.locale)
			if (loaded.report.total <= 0 || !avg) break
			text = t`Parties stayed ${avg} minutes on average.`
			break
		}
		case 'waitlist': {
			const quoted = formatMinutes(loaded.report.quotedAvgMin, i18n.locale)
			const actual = formatMinutes(loaded.report.actualAvgMin, i18n.locale)
			if (!quoted || !actual) break
			text = t`Guests waited ${actual} minutes on average, against ${quoted} quoted.`
			break
		}
		case 'pacing': {
			const over = loaded.report.slots.filter((slot) => slot.overLimit).length
			if (over <= 0) break
			text = (
				<Trans>
					<Plural value={over} one="# seating" other="# seatings" /> went over
					their pacing limit.
				</Trans>
			)
			break
		}
	}
	if (!text) return null
	return (
		<p className="text-sm text-pretty" data-testid="report-insight">
			{text}
		</p>
	)
}
