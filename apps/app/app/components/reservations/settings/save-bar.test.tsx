// @vitest-environment jsdom
import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { SettingsSaveBar } from './save-bar.tsx'

describe('SettingsSaveBar', () => {
	it('renders nothing while the form is clean', () => {
		renderStaff(<SettingsSaveBar dirty={false} onDiscard={vi.fn()} />)
		expect(screen.queryByTestId('settings-save-bar')).toBeNull()
	})

	it('appears once the form is dirty', () => {
		renderStaff(<SettingsSaveBar dirty onDiscard={vi.fn()} />)
		expect(screen.getByTestId('settings-save-bar')).toBeTruthy()
	})

	it('appears for a conflict even when clean', () => {
		renderStaff(
			<SettingsSaveBar dirty={false} conflict="Changed" onDiscard={vi.fn()} />,
		)
		expect(screen.getByTestId('settings-save-bar')).toBeTruthy()
	})
})
