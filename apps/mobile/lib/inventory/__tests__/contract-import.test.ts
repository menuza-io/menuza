import { bottlesToMl, countSheetSchema } from '@repo/inventory'

describe('the shared inventory contract in the phone app', () => {
	it('loads the same schemas and bottle math the web app uses', () => {
		expect(bottlesToMl({ sizeMl: 700 }, 3, 4)).toBe(2380)
		expect(countSheetSchema.safeParse({}).success).toBe(false)
	})
})
