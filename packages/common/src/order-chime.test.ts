import { describe, expect, it, vi } from 'vitest'
import { clampVolume, createChimePlayer, CHIME_SOUNDS } from './order-chime.ts'

function fakeAudio(state: AudioContextState) {
	const oscillators: Array<{ frequency: { value: number }; type: string }> = []
	const peaks: number[] = []
	const context = {
		state,
		currentTime: 0,
		destination: {},
		// Without a tap the browser leaves the context suspended.
		resume: vi.fn(async () => {}),
		createOscillator: () => {
			const tone = {
				type: '',
				frequency: { value: 0 },
				connect: (node: unknown) => node,
				start: vi.fn(),
				stop: vi.fn(),
			}
			oscillators.push(tone)
			return tone
		},
		createGain: () => ({
			gain: {
				setValueAtTime: vi.fn(),
				exponentialRampToValueAtTime: (value: number) => peaks.push(value),
			},
			connect: (node: unknown) => node,
		}),
	}
	return { context: context as unknown as AudioContext, oscillators, peaks }
}

describe('order chime', () => {
	it('skips quietly while the browser has not allowed sound', () => {
		const fake = fakeAudio('suspended')
		const player = createChimePlayer(() => fake.context)
		expect(player.play()).toBe(false)
		expect(player.state()).toBe('blocked')
		expect(fake.oscillators).toHaveLength(0)
	})

	it('plays each of the three sounds once running', () => {
		for (const sound of CHIME_SOUNDS) {
			const fake = fakeAudio('running')
			const player = createChimePlayer(() => fake.context)
			expect(player.play({ sound })).toBe(true)
			expect(fake.oscillators.length).toBeGreaterThanOrEqual(2)
			expect(player.state()).toBe('running')
		}
	})

	it('plays softer and at the chosen volume', () => {
		const loud = fakeAudio('running')
		createChimePlayer(() => loud.context).play({ volume: 1 })
		const soft = fakeAudio('running')
		createChimePlayer(() => soft.context).play({ volume: 1, soft: true })
		const quiet = fakeAudio('running')
		createChimePlayer(() => quiet.context).play({ volume: 0.3 })
		expect(Math.max(...soft.peaks)).toBeLessThan(Math.max(...loud.peaks))
		expect(Math.max(...quiet.peaks)).toBeLessThan(Math.max(...loud.peaks))
	})

	it('plays nothing at volume zero and reports an unsupported browser', () => {
		const fake = fakeAudio('running')
		expect(createChimePlayer(() => fake.context).play({ volume: 0 })).toBe(true)
		expect(fake.oscillators).toHaveLength(0)
		const broken = createChimePlayer(() => {
			throw new Error('no audio')
		})
		expect(broken.play()).toBe(false)
		expect(broken.state()).toBe('unsupported')
	})

	it('clamps the volume', () => {
		expect(clampVolume(2)).toBe(1)
		expect(clampVolume(-1)).toBe(0)
		expect(clampVolume('x')).toBe(0.6)
	})
})
