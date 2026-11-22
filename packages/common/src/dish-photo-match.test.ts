import { describe, expect, it } from 'vitest'
import {
	BULK_PHOTO_MAX_FILES,
	BULK_PHOTO_MAX_FILE_BYTES,
	BULK_PHOTO_MAX_TOTAL_BYTES,
	checkBulkPhotoBatch,
	checkBulkPhotoPairs,
	fileNameWords,
	matchConfidence,
	nameMatchScore,
	proposeBulkPhotoMatches,
	type BulkPhotoInput,
	type MatchDish,
} from './dish-photo-match.ts'

const NAMES = [
	'Margherita Pizza',
	'Chicken Shawarma',
	'Caesar Salad',
	'Beef Burger',
	'Lamb Kofta',
	'Falafel Wrap',
	'Hummus',
	'Tabbouleh',
	'Mutabbal',
	'Fattoush',
]

function dishes(count: number, withPhoto = new Set<string>()): MatchDish[] {
	return Array.from({ length: count }, (_, index) => {
		const base = NAMES[index % NAMES.length]!
		const name = index < NAMES.length ? base : `${base} ${index}`
		return {
			id: `dish-${index}`,
			names: [name],
			hasPhoto: withPhoto.has(`dish-${index}`),
		}
	})
}

function photo(index: number, fileName: string): BulkPhotoInput {
	return {
		assetId: `asset-${index}`,
		fileName,
		width: 2000,
		height: 1500,
	}
}

describe('fileNameWords', () => {
	it('drops extensions, camera prefixes and numbers', () => {
		expect(fileNameWords('IMG_2041.JPG')).toEqual([])
		expect(fileNameWords('beef-burger_final (2).jpeg')).toEqual([
			'beef',
			'burger',
		])
		expect(fileNameWords('ChickenShawarma.png')).toEqual([
			'chicken',
			'shawarma',
		])
	})
})

describe('nameMatchScore', () => {
	const dish: MatchDish = {
		id: 'd',
		names: ['Margherita Pizza'],
		hasPhoto: false,
	}
	it('scores a full name 1 and a partial name lower', () => {
		expect(nameMatchScore(['margherita', 'pizza'], dish)).toBe(1)
		expect(nameMatchScore(['pizza'], dish)).toBeLessThan(0.6)
		expect(nameMatchScore(['sushi'], dish)).toBe(0)
	})
	it('matches any language of the dish', () => {
		const arabic: MatchDish = {
			id: 'a',
			names: ['Hummus', 'حمّص'],
			hasPhoto: false,
		}
		expect(nameMatchScore(fileNameWords('حمص.jpg'), arabic)).toBe(1)
	})
	it('reads plurals as the same word', () => {
		expect(
			nameMatchScore(['burgers', 'beef'], {
				id: 'b',
				names: ['Beef Burger'],
				hasPhoto: false,
			}),
		).toBe(1)
	})
	it('maps confidence marks', () => {
		expect(matchConfidence(1)).toBe('high')
		expect(matchConfidence(0.7)).toBe('medium')
		expect(matchConfidence(0.4)).toBe('low')
		expect(matchConfidence(0.1)).toBeNull()
	})
})

describe('proposeBulkPhotoMatches', () => {
	it('proposes matches for 50 dropped photos, each dish at most once', () => {
		const menu = dishes(60)
		const photos = Array.from({ length: 50 }, (_, index) => {
			const name = menu[index]!.names[0]!.toLowerCase().replace(/\s+/g, '_')
			return photo(index, `${name}.jpg`)
		})
		const proposals = proposeBulkPhotoMatches(photos, menu)
		expect(proposals).toHaveLength(50)
		expect(proposals.every((proposal) => proposal.itemId !== null)).toBe(true)
		expect(new Set(proposals.map((proposal) => proposal.itemId)).size).toBe(50)
		proposals.forEach((proposal, index) => {
			expect(proposal.itemId).toBe(`dish-${index}`)
			expect(proposal.confidence).toBe('high')
		})
	})

	it('leaves unmatched photos unmatched', () => {
		const proposals = proposeBulkPhotoMatches(
			[photo(1, 'IMG_9912.jpg'), photo(2, 'sunset.jpg')],
			dishes(5),
		)
		expect(proposals.map((p) => p.itemId)).toEqual([null, null])
		expect(proposals.map((p) => p.confidence)).toEqual([null, null])
	})

	it('marks a dish that has a photo as Replace', () => {
		const menu = dishes(3, new Set(['dish-0']))
		const [proposal] = proposeBulkPhotoMatches(
			[photo(1, 'margherita pizza.jpg')],
			menu,
		)
		expect(proposal).toMatchObject({ itemId: 'dish-0', replace: true })
	})

	it('uses what the model saw when the file name says nothing', () => {
		const [proposal] = proposeBulkPhotoMatches(
			[
				{
					...photo(1, 'IMG_1.jpg'),
					vision: { looksLikeFood: true, label: 'Caesar salad' },
				},
			],
			dishes(5),
		)
		expect(proposal).toMatchObject({ itemId: 'dish-2' })
		expect(proposal!.confidence).not.toBe('high')
	})

	it('flags not food, too small, duplicate and weak photos', () => {
		const proposals = proposeBulkPhotoMatches(
			[
				{
					...photo(1, 'hummus.jpg'),
					vision: { looksLikeFood: false },
				},
				{ ...photo(2, 'hummus.jpg'), width: 500, height: 400 },
				{ ...photo(3, 'a.jpg'), contentHash: 'same' },
				{ ...photo(4, 'b.jpg'), contentHash: 'same' },
				{ ...photo(5, 'c.jpg'), qualityScore: 30 },
			],
			dishes(10),
		)
		expect(proposals[0]!.flags).toContain('not_food')
		expect(proposals[0]!.itemId).toBeNull()
		expect(proposals[1]!.flags).toContain('too_small')
		expect(proposals[2]!.flags).not.toContain('duplicate')
		expect(proposals[3]!.flags).toContain('duplicate')
		expect(proposals[4]!.flags).toContain('weak')
	})
})

describe('checkBulkPhotoBatch', () => {
	const ok = { name: 'a.jpg', size: 1000 }
	it('accepts images within limits', () => {
		expect(checkBulkPhotoBatch([ok])).toEqual({ ok: true })
	})
	it('refuses non-image files', () => {
		expect(checkBulkPhotoBatch([{ name: 'menu.pdf', size: 10 }])).toMatchObject(
			{
				ok: false,
				error: 'not_an_image',
			},
		)
		expect(
			checkBulkPhotoBatch([{ name: 'x.svg', size: 10, type: 'image/svg+xml' }]),
		).toMatchObject({ ok: false, error: 'not_an_image' })
		expect(checkBulkPhotoBatch([{ name: 'x.jpg', size: 0 }])).toMatchObject({
			ok: false,
		})
	})
	it('limits the count, each file and the total', () => {
		expect(
			checkBulkPhotoBatch(
				Array.from({ length: BULK_PHOTO_MAX_FILES + 1 }, () => ok),
			),
		).toMatchObject({ ok: false, error: 'too_many_files' })
		expect(
			checkBulkPhotoBatch([
				{ name: 'big.jpg', size: BULK_PHOTO_MAX_FILE_BYTES + 1 },
			]),
		).toMatchObject({ ok: false, error: 'too_large' })
		const files = Array.from(
			{
				length:
					Math.ceil(BULK_PHOTO_MAX_TOTAL_BYTES / BULK_PHOTO_MAX_FILE_BYTES) + 1,
			},
			(_, i) => ({ name: `${i}.jpg`, size: BULK_PHOTO_MAX_FILE_BYTES }),
		)
		expect(checkBulkPhotoBatch(files.slice(0, 40))).toMatchObject({ ok: true })
		expect(checkBulkPhotoBatch(files)).toMatchObject({
			ok: false,
			error: expect.stringMatching(/batch_too_large|too_many_files/),
		})
		expect(checkBulkPhotoBatch([])).toMatchObject({ ok: false, error: 'empty' })
	})
})

describe('checkBulkPhotoPairs', () => {
	const state = new Map([
		['a', false],
		['b', true],
	])
	it('needs Replace for a dish that already has a photo', () => {
		expect(
			checkBulkPhotoPairs(
				[{ assetId: '1', itemId: 'b', replace: false }],
				state,
			),
		).toMatchObject({ ok: false, error: 'replace_not_confirmed' })
		expect(
			checkBulkPhotoPairs(
				[{ assetId: '1', itemId: 'b', replace: true }],
				state,
			),
		).toEqual({ ok: true })
	})
	it('refuses a dish, photo or an unknown dish used wrongly', () => {
		expect(
			checkBulkPhotoPairs(
				[
					{ assetId: '1', itemId: 'a', replace: false },
					{ assetId: '2', itemId: 'a', replace: false },
				],
				state,
			),
		).toMatchObject({ ok: false, error: 'duplicate_pair' })
		expect(
			checkBulkPhotoPairs(
				[{ assetId: '1', itemId: 'zz', replace: false }],
				state,
			),
		).toMatchObject({ ok: false, error: 'unknown_dish' })
		expect(checkBulkPhotoPairs([], state)).toMatchObject({
			ok: false,
			error: 'empty',
		})
	})
})
