import {
	activeCateringCutoffs,
	buildCateringQnA,
	type CateringAnswerFacts,
	type CateringSettings,
} from '@repo/common/catering'
import { pickLocalized } from '@repo/common/site-locales'
import { type FaqEntry } from '@repo/phone-agent'

const ANSWER_MAX = 1000

function clip(text: string): string {
	return text.length > ANSWER_MAX ? `${text.slice(0, ANSWER_MAX - 1)}…` : text
}

/**
 * The catering answers as approved knowledge for the phone agent (#325, #255).
 * They are the same entries the catering page shows (`buildCateringQnA`), built
 * from the location's settings on every call, so a changed minimum notice or a
 * new answer reaches the next call and the agent can never say something the
 * page does not. One more entry says which holiday dates are still open: the
 * agent has no way to order catering, so it tells a caller whose date has
 * closed instead of taking a request for it.
 */
export function cateringKnowledge(input: {
	settings: CateringSettings
	facts: CateringAnswerFacts
	locationId: string
	timeZone: string
	locale: string
	defaultLocale: string
	now: Date
}): FaqEntry[] {
	const { settings, locationId } = input
	if (!settings.enabled) return []
	const entries: FaqEntry[] = buildCateringQnA(settings, {
		locale: input.locale,
		defaultLocale: input.defaultLocale,
		facts: input.facts,
	}).map((entry) => ({
		id: `catering_${entry.id.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`.slice(
			0,
			60,
		),
		category: 'general',
		question: entry.question.slice(0, 200),
		answer: clip(entry.answer),
		scopeId: locationId,
	}))
	const cutoffs = activeCateringCutoffs(settings, input.now, input.timeZone)
	if (cutoffs.length > 0) {
		const when = (ms: number) =>
			new Intl.DateTimeFormat('en-US', {
				timeZone: input.timeZone,
				dateStyle: 'medium',
				timeStyle: 'short',
			}).format(new Date(ms))
		const day = (date: string) =>
			new Intl.DateTimeFormat('en-US', {
				timeZone: 'UTC',
				dateStyle: 'medium',
			}).format(new Date(`${date}T12:00:00Z`))
		const lines = cutoffs.map((cutoff) => {
			const range =
				cutoff.from === cutoff.to
					? day(cutoff.from)
					: `${day(cutoff.from)} to ${day(cutoff.to)}`
			const note = cutoff.note
				? ` ${pickLocalized(cutoff.note, input.locale, input.defaultLocale)}`
				: ''
			return cutoff.closed
				? `Catering for ${range} is closed: orders had to be in by ${when(cutoff.orderByAtMs)}.${note}`
				: `Catering for ${range}: order by ${when(cutoff.orderByAtMs)}.${note}`
		})
		entries.push({
			id: 'catering_cutoffs',
			category: 'general',
			question: 'Until when can I order catering for a holiday or busy date?',
			answer: clip(lines.join(' ')),
			scopeId: locationId,
		})
	}
	return entries
}
