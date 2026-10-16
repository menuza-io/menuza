import { describe, expect, it } from 'vitest'
import {
	resolveServices,
	type SpecialDayRuleInput,
	type WeeklyServiceTemplateInput,
} from './resolve-services.ts'

const templates: WeeklyServiceTemplateInput[] = [
	{
		id: 'srv_lunch',
		name: 'Lunch',
		slug: 'lunch',
		color: '#10B981',
		daysOfWeek: [1, 2, 3, 4, 5], // Mon..Fri
		startMin: 12 * 60,
		endMin: 15 * 60,
		lastSeatingMin: 14 * 60 + 30,
		onlineBookable: true,
		sortOrder: 1,
		active: true,
	},
	{
		id: 'srv_dinner',
		name: 'Dinner',
		slug: 'dinner',
		color: '#3B82F6',
		daysOfWeek: [0, 1, 2, 3, 4, 5, 6], // Every day
		startMin: 18 * 60,
		endMin: 26 * 60, // 02:00 next morning (1560 <= 2880)
		lastSeatingMin: 24 * 60 + 30,
		onlineBookable: true,
		sortOrder: 2,
		active: true,
	},
	{
		id: 'srv_brunch',
		name: 'Weekend Brunch',
		slug: 'brunch',
		color: '#F59E0B',
		daysOfWeek: [0, 6], // Sun, Sat
		startMin: 10 * 60,
		endMin: 15 * 60,
		lastSeatingMin: 14 * 60,
		onlineBookable: true,
		sortOrder: 0,
		active: true,
	},
	{
		id: 'srv_inactive',
		name: 'Inactive Late Night',
		slug: 'late',
		color: '#6B7280',
		daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
		startMin: 22 * 60,
		endMin: 25 * 60,
		lastSeatingMin: 24 * 60,
		onlineBookable: true,
		sortOrder: 3,
		active: false,
	},
]

describe('resolveServices special-day precedence and weekly templates', () => {
	it('returns weekday template services in sort_order when no special day matches, including midnight-crossing end_min', () => {
		// 2026-06-13 is Saturday (dayOfWeek = 6)
		const sat = resolveServices('2026-06-13', templates, [])
		expect(sat.closed).toBe(false)
		expect(sat.onlineClosed).toBe(false)
		expect(sat.services.map((s) => s.id)).toEqual(['srv_brunch', 'srv_dinner'])
		expect(sat.services[1]?.endMin).toBe(26 * 60)

		// 2026-06-10 is Wednesday (dayOfWeek = 3)
		const wed = resolveServices('2026-06-10', templates, [])
		expect(wed.services.map((s) => s.id)).toEqual(['srv_lunch', 'srv_dinner'])
	})

	it('precedence 1: closed special day returns { closed: true, onlineClosed: true, services: [] }', () => {
		const specialDays: SpecialDayRuleInput[] = [
			{
				id: 'sd_closed',
				businessDate: '2026-12-25',
				type: 'closed',
				name: 'Christmas Day',
				customServices: null,
			},
		]
		const res = resolveServices('2026-12-25', templates, specialDays)
		expect(res.closed).toBe(true)
		expect(res.onlineClosed).toBe(true)
		expect(res.services).toEqual([])
	})

	it('precedence 2: replace special day ignores weekly templates and uses only customServices', () => {
		const specialDays: SpecialDayRuleInput[] = [
			{
				id: 'sd_replace',
				businessDate: '2026-12-31',
				type: 'replace',
				name: 'New Year Eve Gala',
				customServices: [
					{
						id: 'srv_nye_gala',
						name: 'NYE Gala Seating',
						slug: 'nye-gala',
						color: '#8B5CF6',
						startMin: 19 * 60,
						endMin: 27 * 60, // 03:00 AM
						lastSeatingMin: 22 * 60,
						onlineBookable: true,
						sortOrder: 0,
					},
				],
			},
		]
		const res = resolveServices('2026-12-31', templates, specialDays)
		expect(res.closed).toBe(false)
		expect(res.onlineClosed).toBe(false)
		expect(res.services).toHaveLength(1)
		expect(res.services[0]?.id).toBe('srv_nye_gala')
		expect(res.services[0]?.endMin).toBe(27 * 60)
	})

	it('precedence 3: modified special day overlays customServices onto the weekday template', () => {
		const specialDays: SpecialDayRuleInput[] = [
			{
				id: 'sd_modified',
				businessDate: '2026-06-10', // Wednesday (Lunch + Dinner)
				type: 'modified',
				name: 'Extended Dinner + Patio Pop-up',
				customServices: [
					{
						id: 'srv_dinner',
						name: 'Extended Dinner',
						slug: 'dinner',
						color: '#3B82F6',
						startMin: 17 * 60,
						endMin: 27 * 60,
						lastSeatingMin: 25 * 60,
						onlineBookable: true,
						sortOrder: 2,
					},
					{
						id: 'srv_popup',
						name: 'Patio Pop-up',
						slug: 'popup',
						color: '#EC4899',
						startMin: 15 * 60,
						endMin: 18 * 60,
						lastSeatingMin: 17 * 60 + 30,
						onlineBookable: true,
						sortOrder: 1,
					},
				],
			},
		]
		const res = resolveServices('2026-06-10', templates, specialDays)
		expect(res.closed).toBe(false)
		expect(res.onlineClosed).toBe(false)
		expect(res.services.map((s) => s.id)).toEqual([
			'srv_lunch',
			'srv_popup',
			'srv_dinner',
		])
		expect(res.services[2]?.startMin).toBe(17 * 60)
		expect(res.services[2]?.endMin).toBe(27 * 60)
	})

	it('precedence 4: online_closed keeps weekday template services for staff/walk-in while marking onlineClosed: true', () => {
		const specialDays: SpecialDayRuleInput[] = [
			{
				id: 'sd_online_closed',
				businessDate: '2026-06-10',
				type: 'online_closed',
				name: 'Walk-in Only Day',
				customServices: null,
			},
		]
		const res = resolveServices('2026-06-10', templates, specialDays)
		expect(res.closed).toBe(false)
		expect(res.onlineClosed).toBe(true)
		expect(res.services.map((s) => s.id)).toEqual(['srv_lunch', 'srv_dinner'])
		expect(res.services.every((s) => s.onlineBookable === false)).toBe(true)
	})

	it('supports days_mask (bit 0 = Monday), effective_from/effective_to, special_day_id on replace, and (config, businessDate) call order', () => {
		const maskTemplates: WeeklyServiceTemplateInput[] = [
			{
				id: 'srv_mon_wed',
				name: 'Mon/Wed Service',
				slug: 'mon-wed',
				color: '#10B981',
				days_mask: (1 << 0) | (1 << 2), // Monday (bit 0) + Wednesday (bit 2)
				effective_from: '2026-06-01',
				effective_to: '2026-06-30',
				start_min: 18 * 60,
				end_min: 22 * 60,
				last_seating_min: 21 * 60,
				online_bookable: 1,
				sort_order: 1,
				active: 1,
			},
			{
				id: 'srv_special_linked',
				name: 'Linked Holiday Service',
				slug: 'holiday-linked',
				color: '#8B5CF6',
				special_day_id: 'sd_replace_linked',
				start_min: 17 * 60,
				end_min: 23 * 60,
				last_seating_min: 22 * 60,
				online_bookable: 1,
				sort_order: 0,
				active: 1,
			},
		]
		// 2026-06-10 is Wednesday -> matches bit 2 and effective range
		const wed = resolveServices({ services: maskTemplates }, '2026-06-10')
		expect(wed.services.map((s) => s.id)).toEqual(['srv_mon_wed'])

		// 2026-07-01 is Wednesday but outside effective_to
		const july = resolveServices({ services: maskTemplates }, '2026-07-01')
		expect(july.services).toEqual([])

		// Replace day using linked special_day_id
		const replaced = resolveServices(
			{
				services: maskTemplates,
				specialDays: [
					{
						id: 'sd_replace_linked',
						business_date: '2026-06-10',
						type: 'replace',
					},
				],
			},
			'2026-06-10',
		)
		expect(replaced.services.map((s) => s.id)).toEqual(['srv_special_linked'])

		// Competing weekly templates sort by latest effective_from descending, then priority descending
		const competing: WeeklyServiceTemplateInput[] = [
			{
				id: 'srv_a_old',
				name: 'Old Dinner',
				slug: 'dinner-old',
				daysOfWeek: [3],
				startMin: 18 * 60,
				endMin: 23 * 60,
				lastSeatingMin: 22 * 60,
				effectiveFrom: '2026-01-01',
				priority: 10,
			},
			{
				id: 'srv_m_new_low',
				name: 'New Dinner Low Priority',
				slug: 'dinner-new-low',
				daysOfWeek: [3],
				startMin: 18 * 60,
				endMin: 23 * 60,
				lastSeatingMin: 22 * 60,
				effectiveFrom: '2026-06-01',
				priority: 1,
			},
			{
				id: 'srv_z_new_high',
				name: 'New Dinner High Priority',
				slug: 'dinner-new-high',
				daysOfWeek: [3],
				startMin: 18 * 60,
				endMin: 23 * 60,
				lastSeatingMin: 22 * 60,
				effectiveFrom: '2026-06-01',
				priority: 5,
			},
		]
		const ordered = resolveServices('2026-06-10', competing, [])
		expect(ordered.services.map((s) => s.id)).toEqual([
			'srv_z_new_high',
			'srv_m_new_low',
			'srv_a_old',
		])
	})
})
