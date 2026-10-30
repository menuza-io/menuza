import { useEffect } from 'react'
import { useSiteTheme } from '../app/use-app'
import { applySiteTheme, type UniwindThemeRuntime } from './apply-theme'

/**
 * Pushes the organization's branding into Uniwind's CSS variables whenever it
 * changes (site load, language-independent). Render-time reads of the tokens
 * (`bg-primary`, `text-muted-foreground`, …) follow automatically.
 */
export function useApplySiteTheme(runtime?: UniwindThemeRuntime): void {
	const theme = useSiteTheme()
	useEffect(() => {
		applySiteTheme(theme, runtime)
	}, [theme, runtime])
}
