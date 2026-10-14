// @vitest-environment jsdom

import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { reviewDrafts } from '#app/utils/staffing/staff-import.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { ReviewRows } from './review-rows.tsx'

const drafts = [
	{
		id: 'a',
		firstName: 'Dana',
		lastName: 'Lee',
		email: 'dana@example.com',
		phone: '',
	},
	{ id: 'b', firstName: 'Cher', lastName: '', email: '', phone: '' },
]

describe('ReviewRows', () => {
	it('writes each row problem next to the row and marks its fields invalid', () => {
		renderStaff(
			<ReviewRows
				rows={reviewDrafts(drafts)}
				editable={['name', 'contact']}
				onChange={() => {}}
				onRemove={() => {}}
			/>,
		)
		expect(
			screen.getByText('Add a last name. Add a phone number or an email.'),
		).toBeTruthy()
		expect(
			screen.getByLabelText('Row 2: Last name').getAttribute('aria-invalid'),
		).toBe('true')
		expect(
			screen.getByLabelText('Row 1: Last name').getAttribute('aria-invalid'),
		).toBeNull()
	})

	it('reports edits and removals by row id', () => {
		const onChange = vi.fn()
		const onRemove = vi.fn()
		renderStaff(
			<ReviewRows
				rows={reviewDrafts(drafts)}
				editable={['name', 'contact']}
				onChange={onChange}
				onRemove={onRemove}
			/>,
		)
		fireEvent.change(screen.getByLabelText('Row 2: Last name'), {
			target: { value: 'Smith' },
		})
		expect(onChange).toHaveBeenCalledWith('b', { lastName: 'Smith' })
		fireEvent.click(screen.getByRole('button', { name: 'Remove Row 1' }))
		expect(onRemove).toHaveBeenCalledWith('a')
	})

	it('keeps contact fields read-only when only names are editable', () => {
		renderStaff(
			<ReviewRows
				rows={reviewDrafts(drafts)}
				editable={['name']}
				onChange={() => {}}
				onRemove={() => {}}
			/>,
		)
		expect(
			(screen.getByLabelText('Row 1: Email') as HTMLInputElement).readOnly,
		).toBe(true)
		expect(
			(screen.getByLabelText('Row 1: First name') as HTMLInputElement).readOnly,
		).toBe(false)
	})
})
