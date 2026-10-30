import { I18nProvider } from '@lingui/react'
import { type ReactNode } from 'react'
import { LayoutDirection } from 'uniwind'
import { useAppLanguageSync } from '../../lib/app/use-app-language'
import { i18n } from '../../lib/i18n/lingui'
import { useApplySiteTheme } from '../../lib/theme/use-site-theme'
import { useThemePalette } from '../../lib/theme/use-theme-palette'
import { ThemedStatusBar } from '../ui'
import { AppShell } from './app-shell'

/**
 * Everything between the store and the navigator: the active catalog, the
 * organization's theme, the layout direction of the language (Arabic flips
 * the whole tree without a restart) and the branded shell.
 */
export function AppRoot({ children }: { children: ReactNode }) {
	const language = useAppLanguageSync()
	useApplySiteTheme()
	const palette = useThemePalette()
	return (
		<I18nProvider i18n={i18n}>
			<LayoutDirection rtl={language.isRtl}>
				<ThemedStatusBar scheme={palette.scheme} />
				<AppShell>{children}</AppShell>
			</LayoutDirection>
		</I18nProvider>
	)
}
