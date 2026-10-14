import { type I18n, type Messages, setupI18n } from '@lingui/core'
import { DEFAULT_SCOPE_ID } from '@repo/staffing'

/**
 * What the Staff screens call a scope.
 *
 * The generic module says "workplace". An organization whose scopes are
 * restaurant locations says "location" instead. The messages stay generic and
 * fully translatable in the catalogs; for a location organization the staff
 * layout hands its subtree a derived i18n instance whose catalog has the one
 * word swapped (`withScopeWording`), so no component is forked and no message
 * is duplicated. `useScopeLabel()` gives new UI code the same choice directly.
 */
export type ScopeWording = 'location' | 'workplace'

/** `location` as soon as any scope is not the one implicit scope. */
export function scopeWordingFor(
	scopes: ReadonlyArray<{ id: string }>,
): ScopeWording {
	return scopes.some((scope) => scope.id !== DEFAULT_SCOPE_ID)
		? 'location'
		: 'workplace'
}

type Swap = [pattern: RegExp, replace: (match: string) => string]

function matchCase(word: string, like: string) {
	return like[0] === like[0]!.toUpperCase()
		? word[0]!.toUpperCase() + word.slice(1)
		: word
}

// Order matters: longer and plural forms first.
const SWAPS: Record<string, Swap[]> = {
	en: [
		[/\bworkplaces\b/gi, (m) => matchCase('locations', m)],
		[/\bworkplace\b/gi, (m) => matchCase('location', m)],
	],
	// The Arabic catalog already says "فرع" for a restaurant location.
	ar: [
		[/أماكن عمل(ه|ها|هم|هن)?/g, (m) => `فروع${m.slice('أماكن عمل'.length)}`],
		[/أماكن العمل/g, () => 'الفروع'],
		[/مكان العمل/g, () => 'الفرع'],
		[/مكان عمل(ه|ها|هم|هن)?/g, (m) => `فرع${m.slice('مكان عمل'.length)}`],
	],
}

export function swapScopeWords(text: string, locale: string): string {
	const swaps = SWAPS[locale.split('-')[0]!.toLowerCase()]
	if (!swaps) return text
	return swaps.reduce(
		(out, [pattern, replace]) => out.replace(pattern, replace),
		text,
	)
}

function swapNode(node: unknown, locale: string): unknown {
	if (typeof node === 'string') return swapScopeWords(node, locale)
	if (Array.isArray(node)) {
		// A compiled ICU token starts with its variable name: keep it as is.
		const isToken = node.length >= 2 && typeof node[1] === 'string'
		return node.map((item, index) =>
			isToken && index < 2 ? item : swapNode(item, locale),
		)
	}
	if (node && typeof node === 'object') {
		return Object.fromEntries(
			Object.entries(node).map(([key, value]) => [
				key,
				swapNode(value, locale),
			]),
		)
	}
	return node
}

/** A compiled catalog with the scope word swapped in every message. */
export function withScopeWording(messages: Messages, locale: string): Messages {
	return Object.fromEntries(
		Object.entries(messages).map(([id, message]) => [
			id,
			swapNode(message, locale),
		]),
	) as Messages
}

const cache = new WeakMap<object, Map<string, I18n>>()

/**
 * An i18n instance that speaks like `base` with "location" for "workplace".
 * Cached per catalog so a request or a re-render builds it once.
 */
export function createScopeWordingI18n(base: I18n): I18n {
	const messages = base.messages
	const locale = base.locale
	let byLocale = cache.get(messages)
	if (!byLocale) {
		byLocale = new Map()
		cache.set(messages, byLocale)
	}
	const cached = byLocale.get(locale)
	if (cached) return cached
	const derived = setupI18n({
		locale,
		locales: base.locales,
		messages: { [locale]: withScopeWording(messages, locale) },
	})
	byLocale.set(locale, derived)
	return derived
}

export type ScopeLabel = {
	wording: ScopeWording
	/** True when scopes are restaurant locations. */
	isLocation: boolean
}
