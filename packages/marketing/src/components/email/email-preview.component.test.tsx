// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EmailPreview } from './email-preview.tsx'

i18n.loadAndActivate({ locale: 'en', messages: {} })

const html =
	'<!DOCTYPE html><html><head></head><body><p>Hello</p></body></html>'

function previewSource(unsubscribeLinkPreview?: boolean) {
	render(
		<I18nProvider i18n={i18n}>
			<EmailPreview
				html={html}
				unsubscribeLinkPreview={unsubscribeLinkPreview}
			/>
		</I18nProvider>,
	)
	return screen.getByTitle('Email preview').getAttribute('srcdoc') ?? ''
}

describe('EmailPreview unsubscribe placeholder', () => {
	it('shows the footer link with a placeholder, not a signed URL', () => {
		const source = previewSource(true)
		expect(source).toContain(
			'<p style="font-size:12px;color:#666"><a href="#unsubscribe">Unsubscribe</a></p></body>',
		)
		expect(source).not.toContain('token=')
	})

	it('adds nothing unless asked (platform emails have no link yet)', () => {
		expect(previewSource()).not.toContain('Unsubscribe')
	})
})
