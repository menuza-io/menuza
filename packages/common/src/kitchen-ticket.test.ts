import { describe, expect, it } from 'vitest'
import {
	autoFireDueCourses,
	defaultKitchenHighlight,
	effectiveHighlight,
	fireNextCourse,
	groupLinesByCourse,
	holdLaterCourses,
	kitchenLineName,
	kitchenOrderType,
	kitchenWorkStarted,
} from './kitchen-ticket.ts'

describe('kitchen ticket view', () => {
	it('uses the kitchen name and falls back to the guest name', () => {
		expect(
			kitchenLineName(
				'Grilled Chicken Plate (Family)',
				'{"en":"Chicken","ar":"دجاج"}',
				'ar',
				'en',
			),
		).toBe('دجاج')
		expect(kitchenLineName('Soup', null)).toBe('Soup')
		expect(kitchenLineName('Soup', '')).toBe('Soup')
	})
	it('highlights a removal option unless the kitchen chose none', () => {
		expect(defaultKitchenHighlight('No onions')).toBe('attention')
		expect(defaultKitchenHighlight('بدون بصل')).toBe('attention')
		expect(defaultKitchenHighlight('Extra cheese')).toBe('none')
		expect(effectiveHighlight(null, 'No onions')).toBe('attention')
		expect(effectiveHighlight('none', 'No onions')).toBeNull()
		expect(effectiveHighlight('allergy', 'Fries')).toBe('allergy')
		expect(effectiveHighlight(undefined, 'Fries')).toBeNull()
	})
	it('keeps drive-through distinct from takeaway', () => {
		expect(
			kitchenOrderType({ fulfillment: 'takeaway', driveThrough: true }),
		).toBe('drive_through')
		expect(kitchenOrderType({ fulfillment: 'delivery' })).toBe('delivery')
	})
	it('holds later courses, fires the next, and does not age a held line', () => {
		const sent = holdLaterCourses(
			[
				{ courseId: 'starter', coursePosition: 0, sentAt: 1_000 },
				{ courseId: 'main', coursePosition: 1, sentAt: 1_000 },
			],
			1_000,
		)
		expect(sent[0]).toMatchObject({ courseHeld: false, courseFiredAt: 1_000 })
		expect(sent[1]).toMatchObject({ courseHeld: true, courseFiredAt: null })
		const fired = fireNextCourse(sent, 5_000)
		expect(fired[1]).toMatchObject({ courseHeld: false, courseFiredAt: 5_000 })
		const added = holdLaterCourses(
			[
				...fired,
				{ courseId: 'main', coursePosition: 1, sentAt: 6_000 },
			],
			6_000,
		)
		expect(added[2]).toMatchObject({ courseHeld: false })
		expect(
			kitchenWorkStarted(
				[{ held: true, firedAt: undefined }],
				1_000,
			),
		).toBe(Number.POSITIVE_INFINITY)
		expect(
			kitchenWorkStarted(
				[
					{ held: true },
					{ held: false, firedAt: 5_000 },
				],
				1_000,
			),
		).toBe(5_000)
		expect(
			groupLinesByCourse([
				{ courseId: 'main', courseName: 'Main', coursePosition: 1, held: true },
				{
					courseId: 'starter',
					courseName: 'Starter',
					coursePosition: 0,
					held: false,
				},
			]).map((group) => group.courseId),
		).toEqual(['starter', 'main'])
		expect(groupLinesByCourse([{ courseId: null }])).toHaveLength(1)
	})
	it('auto-fires the next course after the previous one has been ready', () => {
		const lines = [
			{
				courseId: 'starter',
				coursePosition: 0,
				courseHeld: false,
				courseFiredAt: 1_000,
			},
			{ courseId: 'main', coursePosition: 1, courseHeld: true },
		]
		expect(
			autoFireDueCourses(lines, new Map([['starter', 1_000]]), 5, 4 * 60_000),
		).toEqual(lines)
		expect(
			autoFireDueCourses(lines, new Map([['starter', 1_000]]), 5, 6 * 60_000)[1],
		).toMatchObject({ courseHeld: false })
		expect(autoFireDueCourses(lines, new Map(), null, 9_000)).toEqual(lines)
	})
})
