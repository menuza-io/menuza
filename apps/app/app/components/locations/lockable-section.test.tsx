// @vitest-environment jsdom
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import {
	LocationPolicyProvider,
	LockableSection,
	type LocationPolicyView,
} from './lockable-section.tsx'

function show(policy: LocationPolicyView | undefined) {
	renderStaff(
		<LocationPolicyProvider policy={policy} orgSlug="acme" locationId="loc_1">
			<LockableSection settings={['prepTime', 'largeOrder']}>
				<input aria-label="Prep minutes" defaultValue="15" />
			</LockableSection>
		</LocationPolicyProvider>,
	)
}

describe('LockableSection (#417)', () => {
	it('shows a locked setting read-only with the reason', () => {
		show({
			locked: [{ settingId: 'prepTime', reason: 'Set by the chain' }],
			overrides: [],
		})
		expect(screen.getByTestId('locked-setting-note')).toHaveTextContent(
			'Locked by head office',
		)
		expect(screen.getByTestId('locked-setting-note')).toHaveTextContent(
			'Set by the chain',
		)
		expect(
			(screen.getByLabelText('Prep minutes') as HTMLInputElement).closest(
				'fieldset',
			),
		).toHaveProperty('disabled', true)
	})

	it('shows an override as an override and keeps the field editable', () => {
		show({ locked: [], overrides: ['prepTime'] })
		expect(screen.getByTestId('override-note')).toHaveTextContent(
			'Overrides the chain default',
		)
		expect(
			(screen.getByLabelText('Prep minutes') as HTMLInputElement).closest(
				'fieldset',
			),
		).toHaveProperty('disabled', false)
		expect(
			screen.getByRole('link', { name: 'Use the default again' }),
		).toHaveAttribute(
			'href',
			'/acme/settings/locations/compare?setting=prepTime&locations=loc_1',
		)
	})

	it('adds nothing for a setting without a default, or for another setting', () => {
		show(undefined)
		expect(screen.queryByTestId('lockable-section')).toBeNull()
		expect(screen.getByLabelText('Prep minutes')).toBeEnabled()
	})

	it('ignores policy for settings this section does not edit', () => {
		show({ locked: [{ settingId: 'tips', reason: null }], overrides: ['tips'] })
		expect(screen.queryByTestId('locked-setting-note')).toBeNull()
		expect(screen.getByLabelText('Prep minutes')).toBeEnabled()
	})
})
