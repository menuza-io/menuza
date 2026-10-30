import { useLingui } from '@lingui/react/macro'
import { View } from 'react-native'
import { useAppSnapshot, useAppStore } from '../../lib/app/use-app'
import { appErrorMessage } from '../../lib/i18n/app-error-message'
import { type AppError } from '../../lib/state/app-error'
import { Button, Text } from '../ui'

/**
 * The site did not load (offline, removed, region not served by this build).
 * An un-branded install can also leave it for another site.
 */
export function SiteUnavailableScreen({ error }: { error: AppError }) {
	const { i18n, t } = useLingui()
	const store = useAppStore()
	const { canChangeSite } = useAppSnapshot()
	return (
		<View className="flex-1 items-center justify-center gap-4 p-6">
			<Text
				variant="muted"
				className="text-center"
				accessibilityLiveRegion="polite"
			>
				{appErrorMessage(i18n, error)}
			</Text>
			<Button className="min-w-48" onPress={() => void store.retry()}>
				{t`Try again`}
			</Button>
			{canChangeSite ? (
				<Button
					variant="outline"
					className="min-w-48"
					onPress={() => void store.leaveSite()}
				>
					{t`Use a different site`}
				</Button>
			) : null}
		</View>
	)
}
