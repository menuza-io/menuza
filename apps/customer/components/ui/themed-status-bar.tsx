import { StatusBar } from 'expo-status-bar'
import { type SiteColorScheme } from '../../lib/theme/site-theme-tokens'

/** Status bar text that stays readable on the organization's background. */
export function ThemedStatusBar({ scheme }: { scheme: SiteColorScheme }) {
	return <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
}
