// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TileFreshness } from './tile-freshness.tsx'

describe('TileFreshness', () => {
	beforeEach(() => {
		i18n.load('en', {})
		i18n.activate('en')
	})

	it('shows update time on every tile', () => {
		const updatedAt = Date.now() - 60_000
		render(
			<I18nProvider i18n={i18n}>
				<TileFreshness updatedAt={updatedAt} timeZone="America/New_York" />
			</I18nProvider>,
		)
		const el = screen.getByTestId('tile-freshness')
		expect(el).toHaveAttribute('data-updated-at', String(updatedAt))
		expect(el).toHaveTextContent('Updated')
	})

	it('refreshing updates when handler runs', () => {
		const onRefresh = vi.fn()
		render(
			<I18nProvider i18n={i18n}>
				<TileFreshness
					updatedAt={Date.now()}
					timeZone="UTC"
					onRefresh={onRefresh}
				/>
			</I18nProvider>,
		)
		fireEvent.click(screen.getByTestId('tile-refresh'))
		expect(onRefresh).toHaveBeenCalledTimes(1)
	})
})
