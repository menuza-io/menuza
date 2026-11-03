// @vitest-environment jsdom

import {
	ChoiceCard,
	ChoiceCardContent,
	ChoiceCardDescription,
	ChoiceCardTitle,
} from '@repo/ui/choice-card'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

function renderGroup(chip = false) {
	return render(
		<RadioGroup defaultValue="a" aria-label="Pick one">
			<ChoiceCard>
				<RadioGroupItem value="a" />
				<ChoiceCardContent>
					<ChoiceCardTitle>First</ChoiceCardTitle>
					<ChoiceCardDescription>First detail</ChoiceCardDescription>
				</ChoiceCardContent>
			</ChoiceCard>
			{chip ? (
				<ChoiceCard className="w-auto">
					<RadioGroupItem value="b" disabled />
					<ChoiceCardContent>
						<ChoiceCardTitle>Second</ChoiceCardTitle>
					</ChoiceCardContent>
				</ChoiceCard>
			) : (
				<ChoiceCard>
					<RadioGroupItem value="b" disabled />
					<ChoiceCardContent>
						<ChoiceCardTitle>Second</ChoiceCardTitle>
					</ChoiceCardContent>
				</ChoiceCard>
			)}
		</RadioGroup>,
	)
}

describe('ChoiceCard', () => {
	it('is a label around its radio, so a click anywhere picks it', () => {
		renderGroup()
		const cards = document.querySelectorAll('[data-slot="choice-card"]')
		expect(cards).toHaveLength(2)
		expect(cards[0]?.tagName).toBe('LABEL')
		expect(cards[0]?.querySelector('[role="radio"]')).toBeTruthy()
	})

	it('marks the chosen radio checked so the card can style itself from it', () => {
		renderGroup()
		const [first, second] = screen.getAllByRole('radio')
		expect(first?.getAttribute('aria-checked')).toBe('true')
		expect(first?.hasAttribute('data-checked')).toBe(true)
		expect(second?.getAttribute('aria-checked')).toBe('false')
	})

	it('exposes a disabled option to the card through data-disabled', () => {
		renderGroup()
		const [first, second] = screen.getAllByRole('radio')
		expect(second?.hasAttribute('data-disabled')).toBe(true)
		expect(first?.hasAttribute('data-disabled')).toBe(false)
	})

	it('keeps w-auto for chips and the full-width default otherwise', () => {
		renderGroup(true)
		const [full, chip] = document.querySelectorAll('[data-slot="choice-card"]')
		expect(full?.className).toContain('w-full')
		expect(chip?.className).toContain('w-auto')
		expect(chip?.className).not.toContain('w-full')
	})
})
