import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import TestRenderer, { act } from 'react-test-renderer'
import { appErrorMessage } from '../../lib/i18n/app-error-message'
import { Button } from './button'
import { ErrorMessage } from './error-message'
import { Text } from './text'

function render(element: React.ReactElement): TestRenderer.ReactTestRenderer {
	let renderer: TestRenderer.ReactTestRenderer | undefined
	act(() => {
		renderer = TestRenderer.create(element)
	})
	if (!renderer) throw new Error('render failed')
	return renderer
}

function withI18n(element: React.ReactElement) {
	const i18n = setupI18n({ locale: 'en', messages: { en: {} } })
	return <I18nProvider i18n={i18n}>{element}</I18nProvider>
}

describe('ErrorMessage', () => {
	it('renders nothing without an error', () => {
		const renderer = render(withI18n(<ErrorMessage error={null} />))
		expect(renderer.root.findAllByType(Text)).toHaveLength(0)
	})

	it('shows the mapped message for the error', () => {
		const renderer = render(
			withI18n(<ErrorMessage error={{ reason: 'invalidPhone' }} />),
		)
		const i18n = setupI18n({ locale: 'en', messages: { en: {} } })
		expect(
			renderer.root.findAllByType(Text).map((node) => node.props.children),
		).toContain(appErrorMessage(i18n, { reason: 'invalidPhone' }))
	})

	it('offers retry only with a handler', () => {
		const onRetry = jest.fn()
		const withRetry = render(
			withI18n(
				<ErrorMessage error={{ reason: 'network' }} onRetry={onRetry} />,
			),
		)
		act(() => {
			withRetry.root.findByType(Button).props.onPress({})
		})
		expect(onRetry).toHaveBeenCalledTimes(1)

		const bare = render(
			withI18n(<ErrorMessage error={{ reason: 'network' }} />),
		)
		expect(bare.root.findAllByType(Button)).toHaveLength(0)
	})
})
