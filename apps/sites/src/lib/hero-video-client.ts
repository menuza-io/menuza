/**
 * The hero's background video (#301). A hero that has a poster (every clip
 * made from the restaurant's photos has one) is rendered WITHOUT a video
 * source: the page shows the poster still, and this script gives the video its
 * source only for a guest who has not asked for less motion. A guest who
 * prefers reduced motion (`prefers-reduced-motion: reduce`) therefore sees the
 * still image, downloads no video and sees nothing move; a page without
 * script shows the still too. The choice follows the setting if it changes
 * while the page is open. A hero video without a poster keeps its source but
 * is paused for a guest who prefers reduced motion.
 */

const QUERY = '(prefers-reduced-motion: reduce)'

type MotionQuery = Pick<MediaQueryList, 'matches'> &
	Partial<Pick<MediaQueryList, 'addEventListener'>>

export type HeroVideoEnv = {
	matchMedia: (query: string) => MotionQuery
}

function browserEnv(): HeroVideoEnv {
	return { matchMedia: (query) => window.matchMedia(query) }
}

function play(video: HTMLVideoElement) {
	if (video.dataset.src && video.getAttribute('src') !== video.dataset.src) {
		video.setAttribute('src', video.dataset.src)
		video.load()
	}
	// Autoplay can be refused (battery saver): the poster stays.
	void video.play?.()?.catch?.(() => {})
}

function still(video: HTMLVideoElement) {
	video.pause?.()
	video.removeAttribute('autoplay')
	if (video.dataset.src) {
		// Drop the source so nothing is downloaded or held: the poster shows.
		video.removeAttribute('src')
		video.load?.()
	}
}

/** Starts or stops every hero video as the guest's motion setting says. */
export function initHeroVideos(
	root: ParentNode = document,
	env: HeroVideoEnv = browserEnv(),
) {
	const videos = [
		...root.querySelectorAll<HTMLVideoElement>('[data-hero-video]'),
	]
	if (videos.length === 0) return
	const query = env.matchMedia(QUERY)
	const apply = () => {
		for (const video of videos) {
			if (query.matches) still(video)
			else if (video.dataset.autoplay !== 'false') play(video)
		}
	}
	apply()
	query.addEventListener?.('change', apply)
}
