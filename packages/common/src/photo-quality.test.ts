import { describe, expect, it } from 'vitest'
import {
	combinePhotoQuality,
	formatStudioIssues,
	hasLowResolution,
	isWeakPhoto,
	parsePhotoQualityIssues,
	parsePhotoQualityModelOutput,
	parseStudioIssues,
	studioInstructionsForIssues,
} from './photo-quality.ts'

describe('parsePhotoQualityModelOutput', () => {
	it('reads a clean answer', () => {
		expect(
			parsePhotoQualityModelOutput('{"score": 42.4, "issues": ["too_dark"]}'),
		).toEqual({ score: 42, issues: ['too_dark'] })
	})
	it('finds the object inside chatter and code fences', () => {
		expect(
			parsePhotoQualityModelOutput(
				'Here you go:\n```json\n{"score": 80, "issues": []}\n```',
			),
		).toEqual({ score: 80, issues: [] })
	})
	it('drops unknown issue keys and clamps the score', () => {
		expect(
			parsePhotoQualityModelOutput({
				score: 400,
				issues: ['blurry', 'ugly_plate', 'blurry'],
			}),
		).toEqual({ score: 100, issues: ['blurry'] })
	})
	it('is safe on malformed output', () => {
		for (const bad of [
			'',
			'not json',
			'{"score": "high"}',
			'{"issues": []}',
			'[1,2]',
			null,
			undefined,
			42,
			'{"score": NaN}',
			{ score: Number.POSITIVE_INFINITY },
		]) {
			expect(parsePhotoQualityModelOutput(bad)).toBeNull()
		}
	})
})

describe('resolution without the model', () => {
	it('flags a short side under 800 px', () => {
		expect(hasLowResolution(799, 4000)).toBe(true)
		expect(hasLowResolution(800, 800)).toBe(false)
		expect(hasLowResolution(null, 500)).toBe(false)
	})
	it('adds low_resolution and caps the score; leaves no model answer unscored', () => {
		expect(
			combinePhotoQuality({ width: 600, height: 900, model: null }),
		).toEqual({ score: null, issues: ['low_resolution'] })
		expect(
			combinePhotoQuality({
				width: 600,
				height: 900,
				model: { score: 90, issues: ['blurry'] },
			}),
		).toEqual({ score: 49, issues: ['blurry', 'low_resolution'] })
	})
	it('does not penalize a big photo the model could not read', () => {
		expect(
			combinePhotoQuality({ width: 2000, height: 1500, model: null }),
		).toEqual({ score: null, issues: [] })
	})
})

describe('isWeakPhoto', () => {
	it('is weak under 50 or when too small, never when unscored and clean', () => {
		expect(isWeakPhoto({ score: 49, issues: [] })).toBe(true)
		expect(isWeakPhoto({ score: 50, issues: [] })).toBe(false)
		expect(isWeakPhoto({ score: null, issues: [] })).toBe(false)
		expect(isWeakPhoto({ score: null, issues: ['low_resolution'] })).toBe(true)
	})
})

describe('stored values and studio link', () => {
	it('parses stored JSON and drops junk', () => {
		expect(parsePhotoQualityIssues('["too_dark","x"]')).toEqual(['too_dark'])
		expect(parsePhotoQualityIssues('{')).toEqual([])
		expect(parsePhotoQualityIssues(null)).toEqual([])
	})
	it('round-trips the studio issues query', () => {
		const value = formatStudioIssues(['too_dark', 'blurry'])
		expect(value).toBe('too_dark,blurry')
		expect(parseStudioIssues(value)).toEqual(['too_dark', 'blurry'])
		expect(parseStudioIssues('too_dark,<script>')).toEqual(['too_dark'])
		expect(parseStudioIssues(null)).toEqual([])
	})
})

describe('studioInstructionsForIssues', () => {
	it('turns issues into direction, skipping ones a studio cannot fix', () => {
		const text = studioInstructionsForIssues(['too_dark', 'blurry', 'not_food'])
		expect(text).toContain('Brighten')
		expect(text).toContain('sharp')
		expect(text).not.toContain('food')
		expect(studioInstructionsForIssues([])).toBe('')
		expect(
			studioInstructionsForIssues([
				'too_dark',
				'blurry',
				'dish_cut_off',
				'low_resolution',
			]).length,
		).toBeLessThanOrEqual(500)
	})
})
