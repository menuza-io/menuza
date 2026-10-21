// @vitest-environment jsdom
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import {
	countAllergyParties,
	deriveGuestFlags,
	GuestFlags,
} from './guest-flags.tsx'

const base = {
	hasAllergy: false,
	dietaryCodes: [] as string[],
	occasion: null as string | null,
	guest: null,
	status: 'booked',
}

describe('deriveGuestFlags', () => {
	it('keeps coded allergens and ignores preferences', () => {
		const flags = deriveGuestFlags({
			...base,
			hasAllergy: true,
			dietaryCodes: ['vegan', 'nut_allergy', 'sesame_allergy'],
		})
		expect(flags.allergy).toBe(true)
		expect(flags.allergenCodes).toEqual(['nut_allergy', 'sesame_allergy'])
		expect(flags.allergenText).toBeNull()
	})

	it('flags an allergy with no coded allergen without inventing a name', () => {
		const flags = deriveGuestFlags({ ...base, hasAllergy: true })
		expect(flags.allergy).toBe(true)
		expect(flags.allergenText).toBeNull()
	})

	it('uses free text only when the feed carried it', () => {
		const flags = deriveGuestFlags({
			...base,
			hasAllergy: true,
			dietaryCodes: ['Severe peanut reaction', 'x'],
		})
		expect(flags.allergenText).toBe('Severe peanut reaction')
	})

	it('treats VIP tier none as no VIP', () => {
		expect(
			deriveGuestFlags({ ...base, guest: { vipTier: 'none' } as never })
				.vipTier,
		).toBeNull()
	})
})

describe('countAllergyParties', () => {
	it('skips cancelled parties', () => {
		expect(
			countAllergyParties([
				{ ...base, hasAllergy: true },
				{ ...base, hasAllergy: true, status: 'cancelled' },
				base,
			]),
		).toBe(1)
	})
})

describe('GuestFlags', () => {
	it('renders nothing without flags', () => {
		const { container } = renderStaff(<GuestFlags reservation={base} />)
		expect(container.textContent).toBe('')
	})

	it('shows the whole allergen name on the chip and +n for more', () => {
		renderStaff(
			<GuestFlags
				reservation={{
					...base,
					hasAllergy: true,
					dietaryCodes: ['shellfish_allergy', 'egg_allergy'],
				}}
			/>,
		)
		const chip = screen.getByTestId('guest-flag-allergy')
		expect(chip.textContent).toContain('Shellfish Allergy')
		expect(chip.textContent).toContain('+1')
		expect(chip.innerHTML).not.toContain('truncate')
	})

	it('tight tier gives icons a title and screen-reader text', () => {
		renderStaff(
			<GuestFlags
				tier="tight"
				reservation={{
					...base,
					hasAllergy: true,
					dietaryCodes: ['nut_allergy'],
				}}
			/>,
		)
		expect(screen.getByTestId('guest-flag-allergy').getAttribute('title')).toBe(
			'Allergy: Nut Allergy',
		)
	})
})
