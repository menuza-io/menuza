import { ar } from './copy-ar.ts'
import { de } from './copy-de.ts'
import { en } from './copy-en.ts'
import { es } from './copy-es.ts'
import { fr } from './copy-fr.ts'
import { type LegalCopy } from './copy-shape.ts'
import { zh } from './copy-zh.ts'
import {
	type LegalBuildResult,
	type LegalContext,
	type LegalDocument,
	type LegalKind,
	type LegalSection,
	type TrackingTag,
} from './types.ts'

/** One wording per site language (`en`, `ar`, `es`, `fr`, `de`, `zh`). */
export const LEGAL_COPY: Record<string, LegalCopy> = { en, ar, es, fr, de, zh }

export const LEGAL_LOCALES = Object.keys(LEGAL_COPY)

const TAG_NAMES: Record<TrackingTag, string> = {
	google_analytics: 'Google Analytics',
	google_tag_manager: 'Google Tag Manager',
	meta_pixel: 'Meta Pixel',
	tiktok_pixel: 'TikTok Pixel',
}

function fill(text: string, vars: Record<string, string>) {
	return text.replace(/\{(\w+)\}/g, (match, key: string) =>
		key in vars ? vars[key]! : match,
	)
}

function formatDate(date: string, locale: string) {
	const instant = new Date(`${date}T00:00:00Z`)
	if (Number.isNaN(instant.getTime())) return date
	try {
		return new Intl.DateTimeFormat(locale, {
			dateStyle: 'long',
			timeZone: 'UTC',
		}).format(instant)
	} catch {
		return date
	}
}

function contactLine(c: LegalCopy, ctx: LegalContext) {
	return [
		[c['label.email'], ctx.email],
		[c['label.phone'], ctx.phone],
		[c['label.address'], ctx.address],
	]
		.filter(([, value]) => value?.trim())
		.map(([label, value]) => `${label}: ${value!.trim()}`)
		.join(' · ')
}

function processorList(c: LegalCopy, ctx: LegalContext) {
	const names = new Set<string>()
	if (ctx.paymentProviders.includes('stripe')) names.add('Stripe')
	if (ctx.paymentProviders.includes('checkout')) names.add('Checkout.com')
	if (ctx.features.accounts || ctx.features.marketing) names.add(c['proc.sms']!)
	if (
		ctx.features.ordering ||
		ctx.features.reservations ||
		ctx.features.marketing
	) {
		names.add(c['proc.email']!)
	}
	names.add(c['proc.hosting']!)
	return [...names].join(', ')
}

function tagList(ctx: LegalContext) {
	return ctx.trackingTags.map((tag) => TAG_NAMES[tag]).join(', ')
}

type Vars = Record<string, string>

function section(heading: string, paragraphs: string[]): LegalSection {
	return { heading, paragraphs: paragraphs.filter((p) => p.trim()) }
}

function privacy(c: LegalCopy, ctx: LegalContext, v: Vars): LegalSection[] {
	const f = ctx.features
	const collect = [
		c['privacy.collect.base']!,
		f.ordering && c['privacy.collect.ordering']!,
		f.delivery && c['privacy.collect.delivery']!,
		f.reservations && c['privacy.collect.reservations']!,
		f.accounts && c['privacy.collect.accounts']!,
		f.careers && c['privacy.collect.careers']!,
		f.loyalty && c['privacy.collect.loyalty']!,
		f.giftCards && c['privacy.collect.giftCards']!,
		f.marketing && c['privacy.collect.marketing']!,
		ctx.paymentProviders.length > 0 && c['privacy.collect.payments']!,
	].filter((line): line is string => Boolean(line))
	return [
		section(c['privacy.who.h']!, [fill(c['privacy.who.p']!, v), v.updated!]),
		section(c['privacy.collect.h']!, collect),
		section(c['privacy.use.h']!, [
			c['privacy.use.base']!,
			f.marketing ? c['privacy.use.marketing']! : '',
		]),
		section(c['privacy.share.h']!, [
			fill(c['privacy.share.providers']!, v),
			c['privacy.share.none']!,
		]),
		section(c['privacy.cookies.h']!, [
			c['privacy.cookies.essential']!,
			ctx.trackingTags.length > 0 ? fill(c['privacy.cookies.tags']!, v) : '',
		]),
		section(c['privacy.retention.h']!, [c['privacy.retention.p']!]),
		section(c['privacy.rights.h']!, [c[`privacy.rights.${ctx.region}`]!]),
		section(c['privacy.contact.h']!, [fill(c['privacy.contact.p']!, v)]),
	]
}

function terms(c: LegalCopy, ctx: LegalContext, v: Vars): LegalSection[] {
	const f = ctx.features
	const sections: Array<LegalSection | false> = [
		section(c['terms.about.h']!, [fill(c['terms.about.p']!, v), v.updated!]),
		f.ordering && section(c['terms.ordering.h']!, [c['terms.ordering.p']!]),
		f.ordering &&
			section(c['terms.refunds.h']!, [
				ctx.refundText.trim() || fill(c['terms.refunds.default']!, v),
			]),
		f.delivery && section(c['terms.delivery.h']!, [c['terms.delivery.p']!]),
		f.reservations &&
			section(c['terms.reservations.h']!, [
				c['terms.reservations.p']!,
				f.reservationDeposits ? c['terms.reservations.deposits']! : '',
				ctx.reservationText.trim(),
			]),
		f.giftCards && section(c['terms.giftCards.h']!, [c['terms.giftCards.p']!]),
		f.loyalty && section(c['terms.loyalty.h']!, [c['terms.loyalty.p']!]),
		f.accounts && section(c['terms.accounts.h']!, [c['terms.accounts.p']!]),
		section(c['terms.use.h']!, [c['terms.use.p']!]),
		section(c['terms.liability.h']!, [c['terms.liability.p']!]),
		section(c['terms.law.h']!, [
			c['terms.law.changes']!,
			c[`terms.law.${ctx.region}`]!,
		]),
		section(c['terms.contact.h']!, [fill(c['terms.contact.p']!, v)]),
	]
	return sections.filter((s): s is LegalSection => s !== false)
}

function cookies(c: LegalCopy, ctx: LegalContext, v: Vars): LegalSection[] {
	return [
		section(c['cookies.what.h']!, [fill(c['cookies.what.p']!, v), v.updated!]),
		section(c['cookies.essential.h']!, [c['cookies.essential.p']!]),
		section(c['cookies.tracking.h']!, [
			ctx.trackingTags.length > 0
				? fill(c['cookies.tracking.p']!, v)
				: c['cookies.tracking.none']!,
		]),
		section(c['cookies.choices.h']!, [c['cookies.choices.p']!]),
		section(c['cookies.contact.h']!, [fill(c['cookies.contact.p']!, v)]),
	]
}

function accessibility(
	c: LegalCopy,
	ctx: LegalContext,
	v: Vars,
): LegalSection[] {
	return [
		section(c['accessibility.commitment.h']!, [
			fill(c['accessibility.commitment.p']!, v),
			v.updated!,
		]),
		section(c['accessibility.help.h']!, [fill(c['accessibility.help.p']!, v)]),
		section(c['accessibility.limits.h']!, [
			c['accessibility.limits.base']!,
			ctx.hasEmbeds ? c['accessibility.limits.embeds']! : '',
			ctx.hasPdfMenu ? c['accessibility.limits.pdf']! : '',
		]),
		section(c['accessibility.feedback.h']!, [
			fill(c['accessibility.feedback.p']!, v),
		]),
	]
}

/**
 * One legal document in one language, filled with the restaurant's details
 * and the features it has on. A document that must name a way to reach the
 * restaurant is refused (with what is missing) rather than generated blank:
 * every kind needs an email, and the accessibility statement a phone number
 * too, so a guest who cannot use the site can ask for help.
 */
export function buildLegalDocument(
	kind: LegalKind,
	locale: string,
	ctx: LegalContext,
): LegalBuildResult {
	const missing: Array<'email' | 'phone'> = []
	if (!ctx.email.trim()) missing.push('email')
	if (kind === 'accessibility' && !ctx.phone.trim()) missing.push('phone')
	if (missing.length > 0) return { ok: false, missing }

	const c = LEGAL_COPY[locale] ?? en
	const vars: Vars = {
		name: ctx.name.trim(),
		legalName: ctx.legalName.trim() || ctx.name.trim(),
		email: ctx.email.trim(),
		phone: ctx.phone.trim(),
		address: ctx.address.trim(),
		contact: contactLine(c, ctx),
		date: formatDate(ctx.date, locale),
		processors: processorList(c, ctx),
		tags: tagList(ctx),
	}
	vars.updated = fill(c.updated!, vars)
	const build =
		kind === 'privacy'
			? privacy
			: kind === 'terms'
				? terms
				: kind === 'cookies'
					? cookies
					: accessibility
	const document: LegalDocument = {
		kind,
		locale,
		title: c[`title.${kind}`]!,
		sections: build(c, ctx, vars),
	}
	return { ok: true, document }
}

/** The document as plain text, to compare and diff. */
export function legalDocumentText(document: LegalDocument) {
	return document.sections
		.map((s) => `${s.heading}\n${s.paragraphs.join('\n\n')}`)
		.join('\n\n')
}
