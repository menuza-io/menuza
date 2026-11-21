/**
 * #259: the Embed section renders a frame placeholder built from a provider and
 * checked ids, never pasted code; the frame itself is only created in the
 * browser after the cookie choice. Run with `vitest -c vitest.astro.config.ts`.
 */
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { describe, expect, it, vi } from 'vitest'
import { createSiteI18n } from '~/lib/i18n'
import EmbedBlock from './EmbedBlock.astro'

vi.mock('~/lib/org', () => ({}))
vi.mock('varlock/env', () => ({ ENV: {} }))

async function render(
	config: Record<string, unknown>,
	consentMode: 'required' | 'notice' | 'off' = 'required',
) {
	const container = await AstroContainer.create()
	return container.renderToString(EmbedBlock as never, {
		props: { config, consentMode },
		locals: { i18n: createSiteI18n('en'), requestedLocale: 'en' } as never,
	})
}

describe('Embed section', () => {
	it('renders the placeholder and the built address, with a plain link fallback', async () => {
		const html = await render({
			title: 'Book with OpenTable',
			provider: 'opentable',
			ids: { restaurantId: '12345' },
			height: 360,
		})
		expect(html).toContain('data-site-embed')
		expect(html).toContain('data-consent-mode="required"')
		expect(html).toContain(
			'data-embed-src="https://www.opentable.com/widget/reservation/canvas?rid=12345',
		)
		expect(html).toContain('Book with OpenTable')
		expect(html).toContain('height: 360px')
		expect(html).toContain('Load content')
		expect(html).toContain(
			'href="https://www.opentable.com/restref/client/?rid=12345"',
		)
		expect(html).toContain('rel="noopener noreferrer"')
		// The frame is not in the page until the browser allows it.
		expect(html).not.toContain('<iframe')
		expect(html).toContain('<noscript>')
	})

	it('gives a video a 16:9 shape', async () => {
		const html = await render({
			provider: 'youtube',
			ids: { video: 'dQw4w9WgXcQ' },
			height: 'auto',
		})
		expect(html).toContain('aspect-ratio: 16 / 9')
		expect(html).toContain('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')
		expect(html).toContain(
			'data-embed-allow="encrypted-media; picture-in-picture; fullscreen"',
		)
	})

	it('renders nothing for a config that does not check out, and never the raw HTML', async () => {
		for (const config of [
			{
				provider: 'opentable',
				ids: { restaurantId: '<script>alert(1)</script>' },
			},
			{
				provider: 'opentable',
				ids: { restaurantId: '1' },
				html: '<script>alert(1)</script>',
				src: 'https://evil.example',
			},
			{ provider: 'evil', ids: { x: '1' } },
			{},
		]) {
			const html = await render(config)
			expect(html).not.toContain('<script>alert')
			expect(html).not.toContain('evil.example')
			if (!('html' in config)) expect(html).not.toContain('data-site-embed')
		}
	})

	it('escapes a hostile title', async () => {
		const html = await render({
			title: '<img src=x onerror=alert(1)>',
			provider: 'opentable',
			ids: { restaurantId: '1' },
		})
		// Inside a quoted attribute `<` is inert; outside attributes it is escaped.
		const outsideAttributes = html.replace(/="[^"]*"/gu, '=""')
		expect(outsideAttributes).not.toContain('<img')
		expect(outsideAttributes).toContain('&lt;img')
	})
})
