import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render } from '@testing-library/react'
import { type ReactElement, type ReactNode } from 'react'
import { MemoryRouter } from 'react-router'

/** Renders a Staff component with an English Lingui catalog and a router. */
export function renderStaff(
	ui: ReactElement,
	options: {
		route?: string
		wrapper?: (children: ReactNode) => ReactNode
	} = {},
) {
	i18n.load('en', {})
	i18n.activate('en')
	const wrap = options.wrapper ?? ((children: ReactNode) => children)
	return render(
		<I18nProvider i18n={i18n}>
			<MemoryRouter initialEntries={[options.route ?? '/']}>
				{wrap(ui)}
			</MemoryRouter>
		</I18nProvider>,
	)
}
