// @vitest-environment jsdom
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { SwitchField } from './switch-field.tsx'

describe('SwitchField', () => {
	it('never shrinks below its text inside a scrolling form column', () => {
		const { container } = renderStaff(
			<SwitchField
				label="Charged per guest"
				description="Off: one amount per booking."
				checked={false}
				onCheckedChange={() => {}}
			/>,
		)
		const row = container.firstElementChild as HTMLElement
		expect(row.className).toContain('shrink-0')
		expect(screen.getByRole('switch')).toBeTruthy()
	})
})
