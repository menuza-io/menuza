import {
	DEFAULT_SITE_LOCALES,
	isSiteContentLocale,
	type SiteContentLocale,
} from '@repo/common/site-locales'
import { AR } from './ar.ts'
import { DE } from './de.ts'
import { EN } from './en.ts'
import { ES } from './es.ts'
import { FR } from './fr.ts'
import { type MessageCopy } from './types.ts'
import { ZH } from './zh.ts'

export { MESSAGE_KINDS } from './types.ts'
export type {
	CopyLabels,
	KindCopy,
	MessageCopy,
	MessageKind,
	PaymentEmailKind,
} from './types.ts'

/**
 * Shipped guest copy for every site language. Typed on `SiteContentLocale`, so
 * adding a language to `SITE_CONTENT_LOCALES` breaks the typecheck until its
 * copy exists here. Machine-written first drafts: have a native speaker review.
 */
export const MESSAGE_COPY: Record<SiteContentLocale, MessageCopy> = {
	en: EN,
	ar: AR,
	es: ES,
	fr: FR,
	de: DE,
	zh: ZH,
}

export function messageCopyFor(locale: string): MessageCopy {
	return isSiteContentLocale(locale)
		? MESSAGE_COPY[locale]
		: MESSAGE_COPY[DEFAULT_SITE_LOCALES.defaultLocale]
}

/** `{name}` placeholders; unknown placeholders stay as written. */
export function fillCopy(
	template: string,
	values: Record<string, string>,
): string {
	return template.replace(/\{(\w+)\}/g, (match, key: string) =>
		key in values ? values[key]! : match,
	)
}
