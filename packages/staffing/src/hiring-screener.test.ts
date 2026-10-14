import { describe, expect, it } from 'vitest'
import {
	buildAnswerSnapshots,
	cleanAnswerText,
	parseAnswerSnapshots,
	scoreScreener,
	type ScreenerQuestionLike,
} from './hiring-screener.ts'

const questions: ScreenerQuestionLike[] = [
	{
		id: 'weekends',
		kind: 'yes_no',
		prompt: 'Can you work weekends?',
		category: 'availability',
		dealbreaker: true,
		requiredAnswer: 'yes',
	},
	{
		id: 'smoker',
		kind: 'yes_no',
		prompt: 'Do you prefer cold prep?',
		dealbreaker: false,
		requiredAnswer: 'no',
	},
	{
		id: 'about',
		kind: 'open',
		prompt: 'About you',
		required: false,
		maxLength: 60,
	},
]

describe('buildAnswerSnapshots', () => {
	it('snapshots the question as asked', () => {
		const built = buildAnswerSnapshots(questions, {
			weekends: 'yes',
			smoker: false,
			about: '  Two years on the grill  ',
		})
		expect(built.ok).toBe(true)
		if (!built.ok) return
		expect(built.snapshots).toEqual([
			expect.objectContaining({
				id: 'weekends',
				answer: 'yes',
				requiredAnswer: 'yes',
				dealbreaker: true,
				prompt: 'Can you work weekends?',
			}),
			expect.objectContaining({
				id: 'smoker',
				answer: 'no',
				requiredAnswer: 'no',
			}),
			{
				id: 'about',
				kind: 'open',
				prompt: 'About you',
				answer: 'Two years on the grill',
			},
		])
	})

	it('requires every yes/no and only the open questions marked required', () => {
		const result = buildAnswerSnapshots(questions, { weekends: 'yes' })
		expect(result).toEqual({
			ok: false,
			problems: [{ questionId: 'smoker', code: 'missing' }],
		})
		const required = buildAnswerSnapshots(
			[{ id: 'why', kind: 'open', prompt: 'Why?', required: true }],
			{},
		)
		expect(required.ok).toBe(false)
	})

	it('rejects answers to questions the posting does not ask', () => {
		const result = buildAnswerSnapshots(questions, {
			weekends: 'yes',
			smoker: 'no',
			injected: 'yes',
		})
		expect(result).toEqual({
			ok: false,
			problems: [{ questionId: 'injected', code: 'unknown' }],
		})
	})

	it('rejects malformed, oversized and mistyped answers', () => {
		const result = buildAnswerSnapshots(questions, {
			weekends: 'maybe',
			smoker: 'no',
			about: 'x'.repeat(61),
		})
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.problems).toEqual([
			{ questionId: 'weekends', code: 'invalid' },
			{ questionId: 'about', code: 'too_long' },
		])
		expect(
			buildAnswerSnapshots(questions, {
				weekends: 'yes',
				smoker: 'no',
				about: 5,
			}).ok,
		).toBe(false)
	})

	it('never reads inherited or prototype keys as answers', () => {
		const answers = JSON.parse(
			'{"__proto__": "yes", "weekends": "yes", "smoker": "no"}',
		) as Record<string, unknown>
		const result = buildAnswerSnapshots(questions, answers)
		expect(result.ok).toBe(false)
		const inherited = buildAnswerSnapshots(
			[{ id: 'constructor', kind: 'yes_no', prompt: 'x' }],
			{},
		)
		expect(inherited).toEqual({
			ok: false,
			problems: [{ questionId: 'constructor', code: 'missing' }],
		})
	})

	it('strips control characters from open answers and limits by characters', () => {
		expect(cleanAnswerText('a\u0000b\u0007c\r\nd')).toBe('abc\nd')
		const emoji = '😀'.repeat(60)
		expect(
			buildAnswerSnapshots(questions, {
				weekends: 'yes',
				smoker: 'no',
				about: emoji,
			}).ok,
		).toBe(true)
	})
})

describe('scoreScreener', () => {
	it('scores the share of matching yes/no answers, deterministically', () => {
		const built = buildAnswerSnapshots(questions, {
			weekends: 'no',
			smoker: 'no',
		})
		if (!built.ok) throw new Error('expected snapshots')
		expect(scoreScreener(built.snapshots)).toEqual({
			score: 50,
			flags: ['weekends'],
		})
		expect(scoreScreener(built.snapshots)).toEqual(
			scoreScreener(built.snapshots),
		)
	})

	it('flags only dealbreakers, and gives no score without yes/no questions', () => {
		const built = buildAnswerSnapshots(questions, {
			weekends: 'yes',
			smoker: 'yes',
		})
		if (!built.ok) throw new Error('expected snapshots')
		// smoker mismatches but is not a dealbreaker: lowers the score, no flag.
		expect(scoreScreener(built.snapshots)).toEqual({ score: 50, flags: [] })
		expect(scoreScreener([])).toEqual({ score: null, flags: [] })
	})
})

describe('parseAnswerSnapshots', () => {
	it('drops damaged rows instead of throwing', () => {
		expect(parseAnswerSnapshots('nope')).toEqual([])
		expect(
			parseAnswerSnapshots([
				null,
				{ id: 1 },
				{ id: 'a', kind: 'yes_no', prompt: 'p', answer: 'yes' },
				{ id: 'b', kind: 'open', prompt: 'p', answer: 'text' },
				{ id: 'c', kind: 'open', prompt: 'p', answer: 5 },
			]),
		).toEqual([
			expect.objectContaining({
				id: 'a',
				requiredAnswer: 'yes',
				dealbreaker: false,
			}),
			{ id: 'b', kind: 'open', prompt: 'p', answer: 'text' },
		])
	})
})
