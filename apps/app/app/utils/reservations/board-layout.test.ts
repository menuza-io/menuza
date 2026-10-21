import { describe, expect, it } from 'vitest'
import { boardGridClass } from './board-layout.ts'

describe('boardGridClass', () => {
	it('keeps Finished a slim strip until it is expanded', () => {
		const slim = boardGridClass({ waitlistEnabled: true, finishedOpen: false })
		expect(slim).toContain('xl:grid-cols-[')
		expect(slim).toContain('13rem')
		expect(
			boardGridClass({ waitlistEnabled: true, finishedOpen: true }),
		).toContain('xl:grid-cols-4')
		expect(
			boardGridClass({ waitlistEnabled: false, finishedOpen: true }),
		).toContain('xl:grid-cols-3')
	})

	it('snap-scrolls the columns sideways on phones', () => {
		expect(
			boardGridClass({ waitlistEnabled: false, finishedOpen: false }),
		).toContain('max-md:snap-x')
	})
})
