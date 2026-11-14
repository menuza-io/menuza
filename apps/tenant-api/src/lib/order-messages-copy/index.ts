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
import { type OrderMessageCopy } from './types.ts'
import { ZH } from './zh.ts'

export type {
	OrderCopyLabels,
	OrderKindCopy,
	OrderMessageCopy,
} from './types.ts'

/**
 * Shipped guest order message copy for every site language, like the
 * reservation copy (`reservations-copy/`). Typed on `SiteContentLocale`, so a
 * new site language breaks the typecheck until its copy exists here.
 * Machine-written first drafts: have a native speaker review.
 */
export const ORDER_MESSAGE_COPY: Record<SiteContentLocale, OrderMessageCopy> = {
	en: EN,
	ar: AR,
	es: ES,
	fr: FR,
	de: DE,
	zh: ZH,
}

export function orderCopyFor(locale: string): OrderMessageCopy {
	return isSiteContentLocale(locale)
		? ORDER_MESSAGE_COPY[locale]
		: ORDER_MESSAGE_COPY[DEFAULT_SITE_LOCALES.defaultLocale]
}
