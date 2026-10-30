import { useMemo } from 'react'
import { useColorScheme } from 'react-native'
import { useSiteTheme } from '../app/use-app'
import { resolveThemePalette, type ThemePalette } from './theme-palette'

/**
 * The organization's colors as plain strings, for the few places a class name
 * cannot reach (tab bar, status bar, icon tints).
 */
export function useThemePalette(): ThemePalette {
	const theme = useSiteTheme()
	const systemScheme = useColorScheme()
	return useMemo(
		() => resolveThemePalette(theme, systemScheme === 'dark'),
		[theme, systemScheme],
	)
}
