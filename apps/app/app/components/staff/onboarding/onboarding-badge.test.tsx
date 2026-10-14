// @vitest-environment jsdom

import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { OnboardingBadge } from './onboarding-badge.tsx'

afterEach(cleanup)

describe('OnboardingBadge', () => {
	it('renders nothing when there is nothing left to do', () => {
		const { container } = renderStaff(
			<OnboardingBadge progress={{ kind: 'none' }} />,
		)
		expect(container.textContent).toBe('')
	})

	it('shows progress as words and numbers', () => {
		renderStaff(
			<OnboardingBadge
				progress={{ kind: 'open', complete: 3, total: 5, overdue: false }}
			/>,
		)
		expect(screen.getByText('Onboarding 3/5')).toBeTruthy()
	})

	it('adds "late" in words, with an icon, when overdue', () => {
		const { container } = renderStaff(
			<OnboardingBadge
				progress={{ kind: 'open', complete: 1, total: 5, overdue: true }}
			/>,
		)
		expect(screen.getByText('Onboarding 1/5, late')).toBeTruthy()
		expect(container.querySelector('svg')).not.toBeNull()
	})
})
