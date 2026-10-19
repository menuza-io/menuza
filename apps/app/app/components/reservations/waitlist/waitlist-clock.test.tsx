// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { UpdatedAgo, useSlowLoad } from './waitlist-clock.tsx'

function Slow({ active }: { active: boolean }) {
	const slow = useSlowLoad(active, 10_000)
	return <span data-testid="slow">{slow ? 'slow' : 'fast'}</span>
}

describe('waitlist clock helpers', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('flags a load that outlasts ten seconds, and clears when it ends', () => {
		const { rerender } = render(<Slow active />)
		expect(screen.getByTestId('slow')).toHaveTextContent('fast')
		act(() => {
			vi.advanceTimersByTime(10_001)
		})
		expect(screen.getByTestId('slow')).toHaveTextContent('slow')
		rerender(<Slow active={false} />)
		expect(screen.getByTestId('slow')).toHaveTextContent('fast')
	})

	it('says how long ago the list was updated, in words', () => {
		renderStaff(<UpdatedAgo at={Date.now() - 42_000} />)
		expect(screen.getByTestId('waitlist-updated-ago')).toHaveTextContent(
			/Updated .*(second|ago)/,
		)
	})

	it('renders nothing before the first update', () => {
		renderStaff(<UpdatedAgo at={null} />)
		expect(screen.queryByTestId('waitlist-updated-ago')).toBeNull()
	})
})
