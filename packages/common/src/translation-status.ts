import { parseLocalizedString } from './site-locales.ts'

/**
 * Menu translation status (#410): which dishes, options, option groups and
 * categories are missing a name or a description in each website language.
 * One pure function for the Menu > Translations view and for the guard that
 * refuses removing a language when names would be left empty. Never
 * translates anything.
 *
 * Names and descriptions are counted separately. A description counts as
 * missing in a language only when the record has one in another language (a
 * record with no description at all is not a translation gap). A plain-text
 * value (not a language map) belongs to the default language.
 */

export const TRANSLATABLE_KINDS = [
	'item',
	'option',
	'modifier_group',
	'category',
] as const
export type TranslatableKind = (typeof TRANSLATABLE_KINDS)[number]

export type TranslationField = 'name' | 'description'

export type TranslatableRecord = {
	kind: TranslatableKind
	id: string
	/** Stored localized name: a JSON language map or plain text. */
	name: string | null
	/** Stored localized description (groups have none). */
	description?: string | null
}

export type TranslationGap = {
	kind: TranslatableKind
	id: string
	field: TranslationField
	locale: string
	/** The name to show in the list: default language first, else any. */
	label: string
}

export type LocaleTranslationSummary = {
	locale: string
	missingNames: number
	missingDescriptions: number
	/** Records checked for names (every record). */
	names: number
	/** Records that have a description in some language. */
	descriptions: number
}

export type TranslationStatus = {
	locales: LocaleTranslationSummary[]
	gaps: TranslationGap[]
}

function hasText(value: string | undefined): boolean {
	return typeof value === 'string' && value.trim().length > 0
}

function labelOf(
	names: Record<string, string | undefined>,
	defaultLocale: string,
): string {
	if (hasText(names[defaultLocale])) return names[defaultLocale]!.trim()
	for (const value of Object.values(names)) {
		if (hasText(value)) return value!.trim()
	}
	return ''
}

function enabledLocales(locales: readonly string[], defaultLocale: string) {
	return Array.from(new Set([defaultLocale, ...locales]))
}

export function computeTranslationStatus(
	records: readonly TranslatableRecord[],
	config: { locales: readonly string[]; defaultLocale: string },
): TranslationStatus {
	const locales = enabledLocales(config.locales, config.defaultLocale)
	const summaries = new Map<string, LocaleTranslationSummary>(
		locales.map((locale) => [
			locale,
			{
				locale,
				missingNames: 0,
				missingDescriptions: 0,
				names: 0,
				descriptions: 0,
			},
		]),
	)
	const gaps: TranslationGap[] = []
	for (const record of records) {
		const names = parseLocalizedString(record.name, config.defaultLocale)
		const descriptions = parseLocalizedString(
			record.description ?? null,
			config.defaultLocale,
		)
		const hasDescription = Object.values(descriptions).some(hasText)
		const label = labelOf(names, config.defaultLocale)
		for (const locale of locales) {
			const summary = summaries.get(locale)!
			summary.names += 1
			if (!hasText(names[locale])) {
				summary.missingNames += 1
				gaps.push({
					kind: record.kind,
					id: record.id,
					field: 'name',
					locale,
					label,
				})
			}
			if (hasDescription) {
				summary.descriptions += 1
				if (!hasText(descriptions[locale])) {
					summary.missingDescriptions += 1
					gaps.push({
						kind: record.kind,
						id: record.id,
						field: 'description',
						locale,
						label,
					})
				}
			}
		}
	}
	return { locales: [...summaries.values()], gaps }
}

/** Gaps narrowed by the view's filters; `null` means any. */
export function filterTranslationGaps(
	gaps: readonly TranslationGap[],
	filter: {
		locale?: string | null
		field?: TranslationField | null
		kind?: TranslatableKind | null
	},
): TranslationGap[] {
	return gaps.filter(
		(gap) =>
			(!filter.locale || gap.locale === filter.locale) &&
			(!filter.field || gap.field === filter.field) &&
			(!filter.kind || gap.kind === filter.kind),
	)
}

/**
 * Records whose name would be empty in every language left after a language
 * change: today they have a name only in languages being removed. A plain-text
 * name shows in every language, so it is never left blank.
 */
export function namesLeftBlank(
	records: readonly TranslatableRecord[],
	config: { nextLocales: readonly string[]; defaultLocale: string },
): Array<{ kind: TranslatableKind; id: string; label: string }> {
	const blank: Array<{ kind: TranslatableKind; id: string; label: string }> = []
	for (const record of records) {
		const raw = record.name?.trim() ?? ''
		if (!raw || !raw.startsWith('{')) continue
		const names = parseLocalizedString(raw, config.defaultLocale)
		const hasAny = Object.values(names).some(hasText)
		if (!hasAny) continue
		const kept = config.nextLocales.some((locale) => hasText(names[locale]))
		if (!kept) {
			blank.push({
				kind: record.kind,
				id: record.id,
				label: labelOf(names, config.defaultLocale),
			})
		}
	}
	return blank
}
