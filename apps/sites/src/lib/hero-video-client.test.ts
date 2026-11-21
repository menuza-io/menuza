// @vitest-environment jsdom
/**
 * #301: a guest who prefers reduced motion sees the still image: the hero video
 * gets no source and does not play; everyone else gets the clip.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type HeroVideoEnv, initHeroVideos } from './hero-video-client'

function mount(html: string) {
	document.body.innerHTML = html
	const video = document.querySelector<HTMLVideoElement>('[data-hero-video]')!
	// jsdom has no media pipeline.
	video.play = vi.fn(async () => {}) as never
	video.pause = vi.fn() as never
	video.load = vi.fn() as never
	return video
}

function motion(reduce: boolean) {
	const listeners: Array<() => void> = []
	const query = {
		matches: reduce,
		addEventListener: (_: string, fn: () => void) => {
			listeners.push(fn)
		},
	}
	return {
		env: { matchMedia: () => query } as unknown as HeroVideoEnv,
		change(next: boolean) {
			query.matches = next
			for (const fn of listeners) fn()
		},
	}
}

const WITH_POSTER =
	'<video data-hero-video data-autoplay="true" data-src="/api/videos?objectKey=orgs%2Fo%2Fhero.mp4" poster="/resources/images?objectKey=p.jpg" preload="none" muted loop playsinline></video>'
const LEGACY =
	'<video data-hero-video data-autoplay="true" src="/api/videos?objectKey=a.mp4" autoplay muted loop playsinline></video>'

beforeEach(() => {
	document.body.innerHTML = ''
})

describe('hero video and reduced motion', () => {
	it('a guest who prefers reduced motion sees the poster: no source, no playback', () => {
		const video = mount(WITH_POSTER)
		initHeroVideos(document, motion(true).env)
		expect(video.hasAttribute('src')).toBe(false)
		expect(video.getAttribute('poster')).toBe(
			'/resources/images?objectKey=p.jpg',
		)
		expect(video.play).not.toHaveBeenCalled()
	})

	it('everyone else gets the clip, started by script', () => {
		const video = mount(WITH_POSTER)
		initHeroVideos(document, motion(false).env)
		expect(video.getAttribute('src')).toBe(
			'/api/videos?objectKey=orgs%2Fo%2Fhero.mp4',
		)
		expect(video.play).toHaveBeenCalled()
	})

	it('follows the setting when it changes while the page is open', () => {
		const video = mount(WITH_POSTER)
		const setting = motion(false)
		initHeroVideos(document, setting.env)
		expect(video.hasAttribute('src')).toBe(true)
		setting.change(true)
		expect(video.pause).toHaveBeenCalled()
		expect(video.hasAttribute('src')).toBe(false)
		setting.change(false)
		expect(video.hasAttribute('src')).toBe(true)
	})

	it('pauses a hero video that has no poster for a guest who prefers reduced motion', () => {
		const video = mount(LEGACY)
		initHeroVideos(document, motion(true).env)
		expect(video.pause).toHaveBeenCalled()
		expect(video.hasAttribute('autoplay')).toBe(false)
		// Its source stays: there is no still to show instead.
		expect(video.getAttribute('src')).toBe('/api/videos?objectKey=a.mp4')
	})

	it('leaves a video that is not set to autoplay alone', () => {
		const video = mount(
			WITH_POSTER.replace('data-autoplay="true"', 'data-autoplay="false"'),
		)
		initHeroVideos(document, motion(false).env)
		expect(video.play).not.toHaveBeenCalled()
	})

	it('does nothing on a page without a hero video', () => {
		document.body.innerHTML = '<p>no video</p>'
		const matchMedia = vi.fn(() => ({ matches: true }))
		initHeroVideos(document, { matchMedia })
		expect(matchMedia).not.toHaveBeenCalled()
	})
})
