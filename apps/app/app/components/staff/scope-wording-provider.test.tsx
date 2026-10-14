// @vitest-environment jsdom

import { setupI18n } from '@lingui/core'
import { I18nProvider, useLingui } from '@lingui/react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
	ScopeWordingProvider,
	useScopeLabel,
} from './scope-wording-provider.tsx'

const i18n = setupI18n({
	locale: 'en',
	messages: { en: { pick: 'Choose a workplace' } },
})

function Probe() {
	const { _ } = useLingui()
	const { wording, isLocation } = useScopeLabel()
	return (
		<p>
			{_('pick')} / {wording} / {String(isLocation)}
		</p>
	)
}

function renderWith(wording: 'location' | 'workplace') {
	render(
		<I18nProvider i18n={i18n}>
			<ScopeWordingProvider wording={wording}>
				<Probe />
			</ScopeWordingProvider>
		</I18nProvider>,
	)
}

describe('ScopeWordingProvider', () => {
	it('leaves the generic wording alone', () => {
		renderWith('workplace')
		expect(
			screen.getByText('Choose a workplace / workplace / false'),
		).toBeTruthy()
	})

	it('says location for an organization with locations', () => {
		renderWith('location')
		expect(screen.getByText('Choose a location / location / true')).toBeTruthy()
	})
})
