import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CARD_ERROR_ID, CardErrorAlert, CardFields } from './__card-form.tsx'
import { formatMinor } from './__mock-page.tsx'

i18n.loadAndActivate({ locale: 'en', messages: {} })

function render(node: React.ReactNode) {
	return renderToStaticMarkup(<I18nProvider i18n={i18n}>{node}</I18nProvider>)
}

describe('formatMinor', () => {
	it.each([
		[1999, 'usd', '$19.99'],
		[1999, 'JPY', '¥1,999'],
		[1999, 'kwd', 'KWD 1.999'],
		[0, 'usd', '$0.00'],
	])('%s %s -> %s', (amount, currency, expected) => {
		expect(formatMinor(amount, currency).replace(/ /g, ' ')).toBe(expected)
	})

	it('falls back to two decimals for an unknown currency code', () => {
		expect(formatMinor(1234, 'not-a-currency')).toBe('12.34 NOT-A-CURRENCY')
	})
})

describe('card form errors', () => {
	it.each(['number', 'expiry', 'cvc'] as const)(
		'ties the %s field to the error with aria-describedby',
		(field) => {
			const html = render(<CardFields errorField={field} withZip={false} />)
			const input = new RegExp(`<input[^>]*id="mock-card-${field}"[^>]*>`).exec(
				html,
			)![0]
			expect(input).toContain('aria-invalid="true"')
			expect(input).toContain(`aria-describedby="${CARD_ERROR_ID}"`)
			// The other fields carry neither.
			expect(html.match(/aria-describedby/g)).toHaveLength(1)
		},
	)

	it('renders no description without an error', () => {
		expect(render(<CardFields withZip />)).not.toContain('aria-describedby')
	})

	it('the alert has the id the fields point at, is focusable and announced', () => {
		const html = render(<CardErrorAlert field="cvc">Declined</CardErrorAlert>)
		expect(html).toContain(`id="${CARD_ERROR_ID}"`)
		expect(html).toContain('role="alert"')
		expect(html).toContain('tabindex="-1"')
	})
})
