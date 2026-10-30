import { useLingui } from '@lingui/react/macro'
import { View } from 'react-native'
import { appErrorMessage } from '../../lib/i18n/app-error-message'
import { type AppError } from '../../lib/state/app-error'
import { Button } from './button'
import { Text } from './text'

/**
 * An AppError in words, with an optional retry. Renders nothing without an
 * error so screens can keep it mounted.
 */
export function ErrorMessage({
	error,
	onRetry,
}: {
	error: AppError | null
	onRetry?: () => void
}) {
	const { i18n, t } = useLingui()
	if (!error) return null
	return (
		<View className="items-start gap-2">
			<Text variant="error" accessibilityLiveRegion="polite">
				{appErrorMessage(i18n, error)}
			</Text>
			{onRetry ? (
				<Button variant="outline" size="sm" onPress={onRetry}>
					{t`Try again`}
				</Button>
			) : null}
		</View>
	)
}
