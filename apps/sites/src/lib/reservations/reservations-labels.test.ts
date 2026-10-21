import { readFileSync } from 'node:fs'
import path from 'node:path'
import { type I18n, type MessageDescriptor } from '@lingui/core'
import { describe, expect, it } from 'vitest'
import { buildReservationLabels } from './labels.ts'

const LOCALES = ['en', 'ar', 'es', 'fr', 'de', 'zh'] as const

/** Records every source message the label builder asks for. */
function collectSources() {
	const sources = new Set<string>()
	const recorder = {
		_: (descriptor: MessageDescriptor) => {
			sources.add(String(descriptor.message))
			return String(descriptor.message)
		},
	} as unknown as I18n
	const labels = buildReservationLabels(recorder)
	return { labels, sources: [...sources] }
}

function parsePo(file: string) {
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

describe('reservation labels', () => {
	const { labels, sources } = collectSources()

	it('has a non-empty English string for every key', () => {
		for (const [key, value] of Object.entries(labels)) {
			expect({ key, value }).not.toEqual({ key, value: '' })
		}
		expect(Object.keys(labels).length).toBeGreaterThan(100)
	})

	for (const locale of LOCALES) {
		it(`has a translation for every reservations string in ${locale}`, () => {
			const catalog = parsePo(
				path.resolve(import.meta.dirname, `../../locales/${locale}.po`),
			)
			const missing = sources.filter((source) => {
				const value = catalog.get(source)
				return locale === 'en' ? value === undefined : !value
			})
			expect(missing).toEqual([])
		})
	}
})
