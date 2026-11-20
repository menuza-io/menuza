import {
	parseLocalizedString,
	serializeLocalizedString,
} from '@repo/common/site-locales'
import { LOCALIZED_FIELDS } from '#app/utils/website/block-types.ts'

/**
 * What a test (#338) may change in a section: its words. The editable texts of
 * a block are the ones the block registry already lists as localized
 * (`LOCALIZED_FIELDS`); variant B is the original config with some of those
 * texts replaced. Layout, images, links and structure never differ between
 * arms, so a result is about the words.
 */

export type TestableText = {
	/** `heading`, `links.0.link.label`: a concrete path into the config. */
	path: string
	/** The text in the site's default language. */
	value: string
}

/** Expands `items.[].title` into one concrete path per array element. */
function expandPaths(config: unknown, pattern: string): string[] {
	const parts = pattern.split('.')
	const walk = (node: unknown, index: number, prefix: string[]): string[][] => {
		if (index === parts.length) return [prefix]
		const part = parts[index]!
		if (part === '[]') {
			if (!Array.isArray(node)) return []
			return node.flatMap((child, at) =>
				walk(child, index + 1, [...prefix, String(at)]),
			)
		}
		if (!node || typeof node !== 'object' || Array.isArray(node)) return []
		return walk((node as Record<string, unknown>)[part], index + 1, [
			...prefix,
			part,
		])
	}
	return walk(config, 0, []).map((path) => path.join('.'))
}

function readAt(config: unknown, path: string): unknown {
	let node: unknown = config
	for (const key of path.split('.')) {
		if (node === null || typeof node !== 'object') return undefined
		node = (node as Record<string, unknown>)[key]
	}
	return node
}

function writeAt(config: unknown, path: string, value: string): unknown {
	const keys = path.split('.')
	const clone = structuredClone(config) as Record<string, unknown>
	let node: Record<string, unknown> | unknown[] = clone
	for (const key of keys.slice(0, -1)) {
		node = (node as Record<string, unknown>)[key] as Record<string, unknown>
		if (node === null || typeof node !== 'object') return config
	}
	;(node as Record<string, unknown>)[keys.at(-1)!] = value
	return clone
}

export function sectionTestableTexts(
	type: string,
	config: unknown,
	defaultLocale: string,
): TestableText[] {
	const patterns = LOCALIZED_FIELDS[type] ?? []
	const texts: TestableText[] = []
	for (const pattern of patterns) {
		for (const path of expandPaths(config, pattern)) {
			const raw = readAt(config, path)
			if (typeof raw !== 'string') continue
			const value =
				parseLocalizedString(raw, defaultLocale)[defaultLocale] ?? ''
			if (value.trim()) texts.push({ path, value })
		}
	}
	return texts
}

/**
 * Variant B: the original config with the edited texts set in `locale`. A path
 * that is not a testable text of the block is refused (returns null), so a
 * crafted request cannot change anything else. Other languages of an edited
 * text are kept: they were not part of the test.
 */
export function applyTextEdits(
	type: string,
	config: unknown,
	edits: ReadonlyArray<{ path: string; value: string }>,
	locale: string,
): Record<string, unknown> | null {
	const allowed = new Set(
		(LOCALIZED_FIELDS[type] ?? []).flatMap((pattern) =>
			expandPaths(config, pattern),
		),
	)
	let next: unknown = config
	for (const edit of edits) {
		if (!allowed.has(edit.path)) return null
		const raw = readAt(next, edit.path)
		if (typeof raw !== 'string') return null
		const localized = parseLocalizedString(raw, locale)
		localized[locale] = edit.value.trim().slice(0, 1000)
		next = writeAt(next, edit.path, serializeLocalizedString(localized))
	}
	return next as Record<string, unknown>
}

/** Whether a variant actually differs from the original in some text. */
export function variantDiffers(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) !== JSON.stringify(b)
}
