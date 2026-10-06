import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DropPreview, getDropPreviewState } from './drop-preview.tsx'

const NOW = new Date('2026-10-05T12:00:00.000Z')

describe('drop preview state', () => {
	it('keeps drafts private even when their order window is active', () => {
		expect(getDropPreviewState('draft', '', '', NOW)).toBe('draft')
	})

	it('shows upcoming for a future opening or an unscheduled scheduled drop', () => {
		expect(getDropPreviewState('live', '2026-10-06T12:00', '', NOW)).toBe(
			'upcoming',
		)
		expect(getDropPreviewState('scheduled', '', '', NOW)).toBe('upcoming')
	})

	it('shows open once the order window begins', () => {
		expect(
			getDropPreviewState(
				'scheduled',
				'2026-10-04T12:00:00.000Z',
				'2026-10-06T12:00:00.000Z',
				NOW,
			),
		).toBe('open')
	})

	it('shows ended after closing or completing a drop', () => {
		expect(getDropPreviewState('closed', '', '', NOW)).toBe('ended')
		expect(getDropPreviewState('completed', '', '', NOW)).toBe('ended')
		expect(
			getDropPreviewState('live', '', '2026-10-04T12:00:00.000Z', NOW),
		).toBe('ended')
	})

	it('renders only the public listing card content, without menu or pickup details', () => {
		const html = renderToStaticMarkup(
			createElement(
				I18nProvider,
				{ i18n: setupI18n({ locale: 'en', messages: { en: {} } }) },
				createElement(DropPreview, {
					title: 'Weekend drop',
					description: 'A limited batch',
					coverImageUrl: '/cover.jpg',
					ordersOpenAt: '2026-10-06T12:00:00.000Z',
					ordersCloseAt: '',
					status: 'scheduled',
					visibility: 'public',
					now: NOW,
				}),
			),
		)
		expect(html).toContain('aspect-[16/9]')
		expect(html).toContain('Weekend drop')
		expect(html).toContain('A limited batch')
		expect(html).toContain('Coming soon')
		expect(html).toContain('View drop')
		expect(html).not.toContain('Menu items')
		expect(html).not.toContain('Pickup:')
	})
})
