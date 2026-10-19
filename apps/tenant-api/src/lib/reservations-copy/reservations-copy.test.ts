import { SITE_CONTENT_LOCALES } from '@repo/common/site-locales'
import { describe, expect, it } from 'vitest'
import { MESSAGE_COPY, MESSAGE_KINDS, type KindCopy } from './index.ts'

function placeholders(value: string | undefined): string[] {
	return [...(value ?? '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort()
}

const FIELDS = [
	'subject',
	'heading',
	'lead',
	'leadNoTime',
	'ctaLabel',
	'sms',
	'smsNoTime',
] as const satisfies readonly (keyof KindCopy)[]

describe('shipped guest copy', () => {
	it('has a dictionary for every site language', () => {
		expect(Object.keys(MESSAGE_COPY).sort()).toEqual(
			[...SITE_CONTENT_LOCALES].sort(),
		)
	})

	describe.each(SITE_CONTENT_LOCALES)('%s', (locale) => {
		const copy = MESSAGE_COPY[locale]

		it('has every message kind with the same fields as English', () => {
			expect(Object.keys(copy.kinds).sort()).toEqual([...MESSAGE_KINDS].sort())
			for (const kind of MESSAGE_KINDS) {
				for (const field of FIELDS) {
					expect(
						Boolean(copy.kinds[kind][field]),
						`${locale}.${kind}.${field}`,
					).toBe(Boolean(MESSAGE_COPY.en.kinds[kind][field]))
				}
			}
		})

		it('keeps the same placeholders as English in every string', () => {
			for (const kind of MESSAGE_KINDS) {
				for (const field of FIELDS) {
					expect(
						placeholders(copy.kinds[kind][field]),
						`${locale}.${kind}.${field}`,
					).toEqual(placeholders(MESSAGE_COPY.en.kinds[kind][field]))
				}
			}
			expect(placeholders(copy.labels.emailWait)).toEqual(['wait'])
			expect(placeholders(copy.labels.smsWait)).toEqual(['min'])
		})

		it('does not fall back to the English text', () => {
			if (locale === 'en') return
			for (const kind of MESSAGE_KINDS) {
				expect(copy.kinds[kind].subject, `${locale}.${kind}`).not.toBe(
					MESSAGE_COPY.en.kinds[kind].subject,
				)
				expect(copy.kinds[kind].sms, `${locale}.${kind}`).not.toBe(
					MESSAGE_COPY.en.kinds[kind].sms,
				)
			}
			for (const key of Object.keys(copy.labels) as Array<
				keyof typeof copy.labels
			>) {
				// Words that are genuinely the same in some languages.
				if (['sampleName', 'restaurant', 'date', 'waitUnit'].includes(key)) {
					continue
				}
				expect(copy.labels[key], `${locale}.labels.${key}`).not.toBe(
					MESSAGE_COPY.en.labels[key],
				)
			}
		})
	})
})
