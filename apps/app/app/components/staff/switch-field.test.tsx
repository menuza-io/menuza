// @vitest-environment jsdom
import { screen } from '@testing-library/react'
import { Sheet } from '@repo/ui/sheet'
import { describe, expect, it } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { FilterSelect, SelectField } from './controls.tsx'
import { SheetForm } from './sheet-frame.tsx'
import { SwitchField } from './switch-field.tsx'

describe('SwitchField', () => {
	it('never shrinks below its text inside a scrolling form column', () => {
		const { container } = renderStaff(
			<SwitchField
				label="Send reminders"
				description="Off: nobody is reminded."
				checked={false}
				onCheckedChange={() => {}}
			/>,
		)
		const row = container.firstElementChild as HTMLElement
		expect(row.className).toContain('shrink-0')
		expect(screen.getByRole('switch')).toBeTruthy()
	})
})

describe('staff form kit', () => {
	it('keeps every direct child of a sheet form body from shrinking', () => {
		renderStaff(
			<Sheet>
				<SheetForm
					title="Edit"
					onSubmit={() => {}}
					footer={<button type="submit">Save</button>}
				>
					<p>Field</p>
				</SheetForm>
			</Sheet>,
		)
		const body = document.querySelector('form > div') as HTMLElement
		expect(body.className).toContain('*:shrink-0')
	})

	it('puts the optional id and testId on the select triggers', () => {
		renderStaff(
			<>
				<FilterSelect
					label="Status"
					id="status-filter"
					testId="status-filter-trigger"
					options={[{ value: 'a', label: 'A' }]}
					value="a"
					onValueChange={() => {}}
				/>
				<SelectField
					label="Role"
					id="role-field"
					testId="role-trigger"
					options={[{ value: 'b', label: 'B' }]}
					value="b"
					onValueChange={() => {}}
				/>
			</>,
		)
		expect(screen.getByTestId('status-filter-trigger').id).toBe('status-filter')
		expect(screen.getByTestId('role-trigger').id).toBe('role-field')
	})
})
