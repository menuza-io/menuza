import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatMessageMarkdown } from './chat-message-markdown.tsx'

function renderMessage(body: string) {
	const i18n = setupI18n({ locale: 'en', messages: { en: {} } })
	return renderToStaticMarkup(
		<I18nProvider i18n={i18n}>
			<ChatMessageMarkdown body={body} />
		</I18nProvider>,
	)
}

describe('chat markdown presentation', () => {
	it('preserves visible list markers and spacing', () => {
		const html = renderMessage('- Review the flow\n- Test on mobile')
		expect(html).toContain('list-disc')
		expect(html).toContain('<li>Review the flow</li>')
		expect(renderMessage('1. First\n2. Second')).toContain('list-decimal')
	})

	it('keeps code blocks and tables in horizontally scrollable containers', () => {
		const code = renderMessage('```ts\nconst ready = true\n```')
		expect(code).toContain('<pre')
		expect(code).toContain('overflow-x-auto')
		const table = renderMessage(
			'| Name | Status |\n| --- | --- |\n| Chat | Ready |',
		)
		expect(table).toContain('<table')
		expect(table).toContain('overflow-x-auto')
	})

	it('wraps long text and preserves paragraph breaks', () => {
		const html = renderMessage('First paragraph\n\nSecond paragraph')
		expect(html).toContain('[overflow-wrap:anywhere]')
		expect(html).toContain('not-last:mb-2')
		expect(html).toContain('Second paragraph')
	})

	it('keeps unsafe links and raw HTML non-executable', () => {
		const html = renderMessage(
			'[unsafe](javascript:alert(1))\n\n<script>alert(1)</script>',
		)
		expect(html).not.toContain('href="javascript:')
		expect(html).not.toContain('<script>')
	})

	it('preserves mentions and safe external links', () => {
		const html = renderMessage(
			'[Sam](user:member-id) [Docs](https://example.com/docs)',
		)
		expect(html).not.toContain('href="user:')
		expect(html).toContain('Sam')
		expect(html).toContain('href="https://example.com/docs"')
		expect(html).toContain('rel="noopener noreferrer"')
	})
})
