import { pickLocalized } from '@repo/common/site-locales'

/** Guest-facing copy while editing: language code to text (a language may be unset). */
export type LocalizedMap = Record<string, string | undefined>

/** Guest-facing copy as sent and stored: no empty or unset languages. */
export type LocalizedText = Record<string, string>

/** The enabled languages; the default is one of them. */
export type LocalesLike = {
	locales: readonly string[]
	defaultLocale: string
}

/**
 * Text for a list row or heading: the organization's default language first,
 * then the canonical column. The operator's interface language never picks
 * which content language is shown.
 */
export function displayText(
	map: LocalizedMap | null | undefined,
	config: Pick<LocalesLike, 'defaultLocale'>,
	canonical = '',
): string {
	return (
		pickLocalized(map ?? {}, config.defaultLocale, config.defaultLocale) ||
		canonical
	)
}

/**
 * What to send on save: empty values dropped, languages the organization no
 * longer enables dropped (Menu does the same), values trimmed.
 */
export function cleanLocalizedMap(
	map: LocalizedMap | null | undefined,
	config: LocalesLike,
): LocalizedText {
	const out: LocalizedText = {}
	for (const locale of new Set([...config.locales, config.defaultLocale])) {
		const text = map?.[locale]?.trim()
		if (text) out[locale] = text
	}
	return out
}

/** The default-language entry: the canonical text of a localized name. */
export function defaultEntry(
	map: LocalizedMap | null | undefined,
	config: Pick<LocalesLike, 'defaultLocale'>,
): string {
	return map?.[config.defaultLocale]?.trim() ?? ''
}

/** A map holding only `text` in the default language, or `{}` when empty. */
export function singleLanguageMap(
	text: string,
	config: Pick<LocalesLike, 'defaultLocale'>,
): LocalizedText {
	const trimmed = text.trim()
	return trimmed ? { [config.defaultLocale]: trimmed } : {}
}
