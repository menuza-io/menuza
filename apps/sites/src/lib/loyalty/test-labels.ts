import { readFileSync } from 'node:fs'
import path from 'node:path'
import { setupI18n } from '@lingui/core'
import { generateMessageId } from '@lingui/message-utils/generateMessageId'
import { buildLoyaltyLabels } from '~/lib/loyalty/labels'

/** English labels with placeholders left in place, for DOM tests. */
export function testLoyaltyLabels() {
	return buildLoyaltyLabels(setupI18n({ locale: 'en', messages: { en: {} } }))
}

/** `msgid` to `msgstr` in a Sites catalog; obsolete `#~` entries are skipped. */
export function readCatalog(locale: string): Map<string, string> {
	const file = path.resolve(import.meta.dirname, `../../locales/${locale}.po`)
	const entries = new Map<string, string>()
	let current: 'id' | 'str' | null = null
	let id = ''
	let str = ''
	const flush = () => {
		if (id) entries.set(id, str)
		id = ''
		str = ''
	}
	const unquote = (line: string) =>
		JSON.parse(line.slice(line.indexOf('"'))) as string
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		if (line.startsWith('msgid ')) {
			flush()
			current = 'id'
			id = unquote(line)
		} else if (line.startsWith('msgstr ')) {
			current = 'str'
			str = unquote(line)
		} else if (line.startsWith('"') && current) {
			if (current === 'id') id += unquote(line)
			else str += unquote(line)
		} else if (!line.trim()) {
			flush()
			current = null
		}
	}
	flush()
	return entries
}

/** The labels a page in `locale` renders, from that locale's catalog. */
export function catalogLoyaltyLabels(locale: string) {
	const messages = Object.fromEntries(
		[...readCatalog(locale)].map(([source, translation]) => [
			generateMessageId(source),
			translation,
		]),
	)
	return buildLoyaltyLabels(
		setupI18n({ locale, messages: { [locale]: messages } }),
	)
}
