import { describe, expect, test } from 'vitest'
import {
	normalizeSpeech,
	numberAt,
	parseSpokenCount,
	type VoiceItem,
} from './voice-count.ts'

const item = (
	id: string,
	name: string,
	baseUnit: VoiceItem['baseUnit'],
	units: string[] = [],
	extra: Partial<VoiceItem> = {},
): VoiceItem => ({
	id,
	name,
	baseUnit,
	countUnit: null,
	units: units.map((unit, index) => ({ id: `${id}_u${index}`, name: unit })),
	...extra,
})

const kitchen: VoiceItem[] = [
	item('tom', 'Tomatoes', 'g', ['Case'], { nameAr: 'طماطم', countUnit: 'unit:tom_u0' }),
	item('rom', 'Romaine', 'g', ['Bag'], { nameAr: 'خس' }),
	item('rice', 'Basmati rice', 'g', ['Sack']),
	item('milk', 'Milk', 'ml', ['Carton'], { countUnit: 'l' }),
	item('egg', 'Eggs', 'piece', ['Tray']),
	item('flour', 'Flour', 'g'),
]

const linesOf = (text: string, items = kitchen) =>
	parseSpokenCount(text, items).lines.map((line) => [
		line.itemId,
		line.amount,
		line.unit,
	])

describe('numbers', () => {
	const at = (text: string) => {
		const tokens = normalizeSpeech(text).split(' ')
		const found = numberAt(tokens, 0)
		return found ? [found.value, found.next] : null
	}
	test('digits, words, halves and dozens', () => {
		expect(at('2')).toEqual([2, 1])
		expect(at('2.5')).toEqual([2.5, 1])
		expect(at('three')).toEqual([3, 1])
		expect(at('twenty five kilos')).toEqual([25, 2])
		expect(at('one hundred and five')).toEqual([105, 4])
		expect(at('two and a half cases')).toEqual([2.5, 4])
		expect(at('two point five')).toEqual([2.5, 3])
		expect(at('a dozen eggs')).toEqual([12, 2])
		expect(at('two dozen eggs')).toEqual([24, 2])
		expect(at('half a case')).toEqual([0.5, 1])
		expect(at('a case of milk')).toEqual([1, 1])
		expect(at('tomatoes')).toBeNull()
	})
	test('Arabic words and Arabic-Indic digits', () => {
		expect(at('ثلاثة')).toEqual([3, 1])
		expect(at('٣')).toEqual([3, 1])
		expect(at('٢٫٥')).toEqual([2.5, 1])
		expect(at('خمسة وعشرين')).toEqual([25, 2])
		expect(at('خمسة و عشرين')).toEqual([25, 3])
		expect(at('ثلاثة ونصف')).toEqual([3.5, 2])
		expect(at('عشرين')).toEqual([20, 1])
	})
	test('normalisation removes vowel marks and unifies letters', () => {
		expect(normalizeSpeech('أَكياس')).toBe('اكياس')
		expect(normalizeSpeech('كرتونة، ٣')).toBe('كرتونه , 3')
	})
})

describe('proposing lines', () => {
	test('"two cases of tomatoes and three bags of romaine" is two lines with the right units', () => {
		const parsed = parseSpokenCount(
			'two cases of tomatoes and three bags of romaine',
			kitchen,
		)
		expect(parsed.questions).toEqual([])
		expect(parsed.lines).toMatchObject([
			{ itemId: 'tom', amount: 2, unit: 'unit:tom_u0', unitLabel: 'Case', unitAssumed: false },
			{ itemId: 'rom', amount: 3, unit: 'unit:rom_u0', unitLabel: 'Bag', unitAssumed: false },
		])
	})

	test('standard units, plurals and number words', () => {
		expect(linesOf('twenty five kilos of basmati rice')).toEqual([['rice', 25, 'kg']])
		expect(linesOf('500 grams flour and 2 liters milk')).toEqual([
			['flour', 500, 'g'],
			['milk', 2, 'l'],
		])
		expect(linesOf('two and a half sacks of rice')).toEqual([['rice', 2.5, 'unit:rice_u0']])
		expect(linesOf('a dozen eggs')).toEqual([['egg', 12, 'piece']])
		expect(linesOf('a case of tomatoes')).toEqual([['tom', 1, 'unit:tom_u0']])
	})

	test('uses the count unit when no unit was said, and says so', () => {
		const parsed = parseSpokenCount('four tomatoes', kitchen)
		expect(parsed.lines[0]).toMatchObject({
			itemId: 'tom',
			amount: 4,
			unit: 'unit:tom_u0',
			unitAssumed: true,
		})
		// No count unit: the usual one for the item's base.
		expect(parseSpokenCount('three flour', kitchen).lines[0]).toMatchObject({
			unit: 'kg',
			unitAssumed: true,
		})
	})

	test('reads the item first as well as the amount first', () => {
		expect(linesOf('romaine three bags tomatoes two cases')).toEqual([
			['rom', 3, 'unit:rom_u0'],
			['tom', 2, 'unit:tom_u0'],
		])
	})

	test('ignores filler words and commas', () => {
		expect(linesOf('okay, we have two cases of tomatoes, then three bags of romaine'))
			.toHaveLength(2)
		expect(linesOf('I have two cases of tomatoes')).toEqual([['tom', 2, 'unit:tom_u0']])
	})

	test('matches a close spelling and flags it for a second look', () => {
		const parsed = parseSpokenCount('two bags of romain', kitchen)
		expect(parsed.lines[0]).toMatchObject({ itemId: 'rom', match: 'close' })
		expect(parseSpokenCount('two bags of romaine', kitchen).lines[0]!.match).toBe('exact')
	})

	test('an exact name beats longer names that contain it', () => {
		const items = [
			item('a', 'Tomatoes', 'g'),
			item('b', 'Cherry tomatoes', 'g'),
		]
		expect(linesOf('3 kilos of tomatoes', items)).toEqual([['a', 3, 'kg']])
		expect(linesOf('3 kilos of cherry tomatoes', items)).toEqual([['b', 3, 'kg']])
	})
})

describe('asking instead of guessing', () => {
	test('a word that matches no item asks which one', () => {
		const parsed = parseSpokenCount('two cases of dragonfruit', kitchen)
		expect(parsed.lines).toEqual([])
		expect(parsed.questions).toEqual([
			{
				kind: 'which_item',
				heard: 'dragonfruit',
				amount: 2,
				unitWords: 'cases',
				reason: 'no_match',
				candidates: [],
			},
		])
	})

	test('shows the closest items for a near miss', () => {
		const parsed = parseSpokenCount('2 kilos of tomato paste', kitchen)
		expect(parsed.lines).toEqual([])
		const [question] = parsed.questions
		expect(question).toMatchObject({ kind: 'which_item', reason: 'no_match' })
		expect(question).toMatchObject({
			candidates: [{ itemId: 'tom', name: 'Tomatoes' }],
		})
	})

	test('more than one match asks which one, with both', () => {
		const items = [
			item('c', 'Cherry tomatoes', 'g', ['Case']),
			item('r', 'Roma tomatoes', 'g', ['Case']),
		]
		const parsed = parseSpokenCount('two cases of tomatoes', items)
		expect(parsed.lines).toEqual([])
		expect(parsed.questions).toMatchObject([
			{
				kind: 'which_item',
				reason: 'ambiguous',
				amount: 2,
				candidates: [{ itemId: 'c' }, { itemId: 'r' }],
			},
		])
	})

	test('a unit the item does not have asks which unit, with the ones it has', () => {
		const parsed = parseSpokenCount('two cases of romaine', kitchen)
		expect(parsed.lines).toEqual([])
		const [question] = parsed.questions
		expect(question).toMatchObject({
			kind: 'which_unit',
			itemId: 'rom',
			amount: 2,
			unitWords: 'cases',
		})
		const refs =
			question?.kind === 'which_unit' ? question.options.map((o) => o.ref) : []
		// Its own Bag first, then the standard units that can measure it.
		expect(refs[0]).toBe('unit:rom_u0')
		expect(refs).toEqual(expect.arrayContaining(['g', 'kg', 'lb', 'oz']))
		expect(refs).not.toContain('ml')
		// A standard unit that cannot measure the item is refused the same way.
		const liters = parseSpokenCount('two liters of flour', kitchen)
		expect(liters.lines).toEqual([])
		expect(liters.questions[0]).toMatchObject({ kind: 'which_unit', itemId: 'flour' })
	})

	test('an item with two units of the same kind asks which', () => {
		const items = [item('o', 'Olive oil', 'ml', ['Bottle 1L', 'Bottle 5L'])]
		const [question] = parseSpokenCount('two bottles of olive oil', items).questions
		expect(question).toMatchObject({ kind: 'which_unit', itemId: 'o' })
		expect(
			question?.kind === 'which_unit'
				? question.options.slice(0, 2).map((o) => o.label)
				: [],
		).toEqual(['Bottle 1L', 'Bottle 5L'])
	})

	test('an item with no usable amount is not counted', () => {
		const parsed = parseSpokenCount('romaine', kitchen)
		expect(parsed.lines).toEqual([])
		expect(parsed.questions).toHaveLength(1)
	})

	test('nothing heard gives nothing', () => {
		expect(parseSpokenCount('', kitchen)).toEqual({
			transcript: '',
			lines: [],
			questions: [],
		})
	})
})

describe('Arabic', () => {
	test('Arabic words, with the item Arabic name', () => {
		const parsed = parseSpokenCount('ثلاث اكياس خس وخمسة كراتين طماطم', [
			item('rom', 'Romaine', 'g', ['Bag'], { nameAr: 'خس' }),
			item('tom', 'Tomatoes', 'g', ['Carton'], { nameAr: 'طماطم' }),
		])
		expect(parsed.questions).toEqual([])
		expect(parsed.lines).toMatchObject([
			{ itemId: 'rom', amount: 3, unit: 'unit:rom_u0' },
			{ itemId: 'tom', amount: 5, unit: 'unit:tom_u0' },
		])
	})

	test('Arabic-Indic digits, and English item names inside an Arabic sentence', () => {
		expect(linesOf('٣ اكياس romaine و ٢ كرتون milk')).toEqual([
			['rom', 3, 'unit:rom_u0'],
			['milk', 2, 'unit:milk_u0'],
		])
		expect(linesOf('خمسة كيلو basmati rice')).toEqual([['rice', 5, 'kg']])
	})

	test('an Arabic unit the item lacks asks which unit', () => {
		const parsed = parseSpokenCount('٢ صناديق خس', kitchen)
		expect(parsed.questions[0]).toMatchObject({ kind: 'which_unit', itemId: 'rom' })
	})

	test('an unmatched Arabic word asks which item', () => {
		const parsed = parseSpokenCount('ثلاثة كيلو فراوله', kitchen)
		expect(parsed.lines).toEqual([])
		expect(parsed.questions[0]).toMatchObject({ kind: 'which_item', reason: 'no_match' })
	})
})
