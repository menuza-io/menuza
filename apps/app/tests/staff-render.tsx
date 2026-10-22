import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render } from '@testing-library/react'
import { type ReactElement, type ReactNode } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { SaveBar } from '#app/components/save-bar.tsx'

/**
 * Renders a Staff component with an English Lingui catalog, a data router
 * (forms that register with the save bar need one for `useBlocker`) and the
 * global save bar.
 */
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
	const router = createMemoryRouter([{ path: '*', element: wrap(ui) }], {
		initialEntries: [options.route ?? '/'],
	})
	return render(
		<I18nProvider i18n={i18n}>
			<RouterProvider router={router} />
			<SaveBar />
		</I18nProvider>,
	)
}
