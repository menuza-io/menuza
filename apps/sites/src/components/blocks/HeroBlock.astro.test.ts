/**
 * #301: the hero renders a clip's poster still first, without a video source,
 * so reduced-motion guests and pages without script see the still.
 * Run with `vitest -c vitest.astro.config.ts`.
 */
import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { describe, expect, it, vi } from 'vitest'
import { createSiteI18n } from '~/lib/i18n'
import HeroBlock from './HeroBlock.astro'

vi.mock('~/lib/org', () => ({}))
vi.mock('varlock/env', () => ({
	ENV: { PUBLIC_APP_URL: 'https://app.example.com' },
}))

async function render(config: Record<string, unknown>) {
	const container = await AstroContainer.create()
	return container.renderToString(HeroBlock as never, {
		props: { config },
		locals: {
			organization: { id: 'o', name: 'Acme', slug: 'acme', locales: ['en'] },
			i18n: createSiteI18n('en'),
			requestedLocale: 'en',
			defaultLocale: 'en',
		} as never,
	})
}

const video = {
	assetType: 'video',
	videoSrc:
		'/resources/videos/source?objectKey=orgs%2Fo%2Fmedia%2Fhero-video%2Fa.mp4',
	videoAutoPlay: true,
	videoLoop: true,
	videoMuted: true,
	videoControls: false,
}

describe('hero video markup (#301)', () => {
	it('with a poster the video has no source and shows the still', async () => {
		const html = await render({
			...video,
			videoPoster:
				'/resources/images?objectKey=orgs%2Fo%2Fmedia%2Fhero-video%2Fa-poster.jpg',
		})
		const tag = /<video\b[^>]*>/u.exec(html)![0]
		expect(tag).toContain(
			'poster="https://app.example.com/resources/images?objectKey=',
		)
		expect(tag).toContain('data-src="/api/videos?objectKey=')
		expect(tag).toContain('data-hero-video')
		expect(tag).toContain('preload="none"')
		// No `src` and no `autoplay`: nothing downloads or moves until script allows it.
		expect(tag).not.toMatch(/\ssrc=/u)
		expect(tag).not.toMatch(/\sautoplay[\s=>]/u)
		expect(tag).toContain('muted')
		expect(tag).toContain('loop')
		expect(tag).not.toContain('controls')
	})

	it('without a poster the hero video is as it was', async () => {
		const html = await render(video)
		const tag = /<video\b[^>]*>/u.exec(html)![0]
		expect(tag).toMatch(/\ssrc="\/api\/videos\?objectKey=/u)
		expect(tag).toMatch(/\sautoplay[\s=>]/u)
		expect(tag).not.toContain('data-src')
	})

	it('a hero with a slideshow or a photo is untouched', async () => {
		const html = await render({
			assetType: 'image',
			slides: [
				{ url: '/a.jpg', alt: 'A' },
				{ url: '/b.jpg', alt: 'B' },
			],
		})
		expect(html).not.toContain('<video')
		expect(html).toContain('data-hero-slideshow')
	})
})
