import { describe, expect, it } from 'vitest'
import {
	buildStoryboard,
	checkStoryboard,
	HERO_VIDEO_MAX_SECONDS,
	HERO_VIDEO_MIN_SECONDS,
	HERO_VIDEO_STYLES,
	heroVideoDuration,
	pickHeroPhotos,
	type PhotoCandidate,
} from './hero-video.ts'

describe('hero video duration and storyboard', () => {
	it('is always 8 to 12 seconds, for every style and photo count', () => {
		for (const style of HERO_VIDEO_STYLES) {
			for (let n = 3; n <= 6; n++) {
				const seconds = heroVideoDuration(style, n)
				expect(seconds).toBeGreaterThanOrEqual(HERO_VIDEO_MIN_SECONDS)
				expect(seconds).toBeLessThanOrEqual(HERO_VIDEO_MAX_SECONDS)
				const plan = buildStoryboard({ style, photoCount: n })
				expect(checkStoryboard(plan)).toBeNull()
				expect(plan.durationS).toBe(seconds)
			}
		}
	})

	it('is silent, loops, takes its poster from the first shot and is sized for the hero', () => {
		const plan = buildStoryboard({ style: 'slow_pans', photoCount: 4 })
		expect(plan.silent).toBe(true)
		expect(plan.loopCrossfadeS).toBeGreaterThan(0)
		expect(plan.posterShot).toBe(0)
		expect(plan.size).toEqual({ width: 1280, height: 720 })
		// Quick cuts are hard cuts, so there is nothing to blend at the loop.
		expect(
			buildStoryboard({ style: 'quick_cuts', photoCount: 4 }).loopCrossfadeS,
		).toBe(0)
	})

	it('uses every chosen photo and only the chosen photos', () => {
		for (const style of HERO_VIDEO_STYLES) {
			const plan = buildStoryboard({ style, photoCount: 5 })
			const used = new Set(plan.shots.map((shot) => shot.photo))
			expect([...used].sort()).toEqual([0, 1, 2, 3, 4])
			expect(
				plan.shots.every((shot) => shot.photo >= 0 && shot.photo < 5),
			).toBe(true)
		}
	})

	it('pans and zooms inside the frame, never beyond the photo', () => {
		for (const style of HERO_VIDEO_STYLES) {
			for (const shot of buildStoryboard({ style, photoCount: 6 }).shots) {
				for (const frame of [shot.from, shot.to]) {
					expect(frame.zoom).toBeGreaterThanOrEqual(1)
					expect(frame.zoom).toBeLessThanOrEqual(1.2)
					// The visible window stays inside the photo.
					const half = 0.5 / frame.zoom
					expect(frame.x - half).toBeGreaterThanOrEqual(-1e-9)
					expect(frame.x + half).toBeLessThanOrEqual(1 + 1e-9)
				}
			}
		}
	})

	it('differs by style and is deterministic', () => {
		const a = buildStoryboard({ style: 'slow_pans', photoCount: 4 })
		const b = buildStoryboard({ style: 'warm_fade', photoCount: 4 })
		const c = buildStoryboard({ style: 'quick_cuts', photoCount: 4 })
		expect(buildStoryboard({ style: 'slow_pans', photoCount: 4 })).toEqual(a)
		expect(a.shots[1]!.transition).toBe('crossfade')
		expect(b.shots[1]!.transition).toBe('fade')
		expect(b.shots.every((shot) => shot.warm)).toBe(true)
		expect(c.shots.every((shot) => shot.transition === 'none')).toBe(true)
		expect(c.shots.length).toBeGreaterThan(a.shots.length)
	})

	it('refuses a plan with a bad length, too few photos or wrong timing', () => {
		const plan = buildStoryboard({ style: 'slow_pans', photoCount: 4 })
		expect(checkStoryboard({ ...plan, durationS: 30 })).toBe('duration')
		expect(
			checkStoryboard({
				...plan,
				shots: plan.shots.slice(0, 2).map((s) => ({ ...s })),
			}),
		).toBe('photos')
		expect(
			checkStoryboard({
				...plan,
				shots: plan.shots.map((s) => ({ ...s, durationS: 0.5 })),
			}),
		).toBe('timing')
		expect(
			checkStoryboard({ ...plan, size: { width: 1, height: 1 } as never }),
		).toBe('size')
	})
})

describe('pickHeroPhotos', () => {
	const photo = (
		id: string,
		extra: Partial<PhotoCandidate> = {},
	): PhotoCandidate => ({
		id,
		tags: [],
		width: 1600,
		height: 900,
		usedByDish: false,
		createdAt: 1,
		...extra,
	})
	it('prefers Featured, then room and dish photos', () => {
		const picked = pickHeroPhotos([
			photo('plain'),
			photo('dish', { usedByDish: true }),
			photo('room', { tags: ['interior'] }),
			photo('hero', { tags: ['featured'] }),
			photo('tall', { width: 800, height: 1200 }),
		])
		expect(picked.slice(0, 3)).toEqual(['hero', 'room', 'dish'])
		expect(picked).toContain('plain')
	})
	it('returns at most six and never invents photos', () => {
		const many = Array.from({ length: 20 }, (_, i) =>
			photo(`p${i}`, { createdAt: i }),
		)
		const picked = pickHeroPhotos(many)
		expect(picked).toHaveLength(6)
		expect(new Set(picked).size).toBe(6)
		expect(picked.every((id) => many.some((p) => p.id === id))).toBe(true)
		expect(pickHeroPhotos([photo('only')])).toEqual(['only'])
	})
})
