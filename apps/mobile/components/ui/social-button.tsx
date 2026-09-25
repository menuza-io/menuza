import { Ionicons } from '@expo/vector-icons'
import { useLingui } from '@lingui/react/macro'
import React from 'react'
import { TouchableOpacity, Text, View, ActivityIndicator } from 'react-native'
import { useOAuth } from '../../lib/auth/hooks/use-oauth'

export interface SocialButtonProps {
	provider: 'github' | 'google'
	onPress?: () => void
	disabled?: boolean
	loading?: boolean
	type?: 'login' | 'signup'
	redirectTo?: string
	onSuccess?: () => void
	onError?: (error: string) => void
	className?: string
}

const providerConfig = {
	github: {
		label: 'GitHub',
		icon: 'logo-github' as const,
		bgClass: 'bg-gray-800',
		textColor: '#ffffff',
	},
	google: {
		label: 'Google',
		icon: 'logo-google' as const,
		bgClass: 'bg-blue-500',
		textColor: '#ffffff',
	},
}

export function SocialButton({
	provider,
	onPress,
	disabled = false,
	loading: externalLoading = false,
	type = 'login',
	redirectTo,
	onSuccess,
	onError,
	className,
}: SocialButtonProps) {
	const { t } = useLingui()
	const config = providerConfig[provider]

	const getButtonText = () => {
		if (provider === 'github') {
			return type === 'signup'
				? t`Sign up with GitHub`
				: t`Continue with GitHub`
		}
		return type === 'signup' ? t`Sign up with Google` : t`Continue with Google`
	}

	const {
		authenticate,
		isLoading: oauthLoading,
		isProviderConfigured,
	} = useOAuth({
		onSuccess,
		onError,
		redirectTo,
	})

	const handlePress = () => {
		if (isDisabled || isLoading) return

		if (onPress) {
			onPress()
		} else {
			void authenticate(provider)
		}
	}

	const isLoading = externalLoading || oauthLoading
	const isDisabled = disabled || !isProviderConfigured(provider)

	return (
		<TouchableOpacity
			className={`my-1 rounded-lg px-4 py-3 ${config.bgClass} ${isDisabled ? 'opacity-60' : ''} ${className ?? ''}`}
			onPress={handlePress}
			disabled={isDisabled || isLoading}
			activeOpacity={0.8}
			accessibilityRole="button"
			accessibilityState={{ disabled: isDisabled || isLoading }}
		>
			<View className="flex-row items-center justify-center gap-2">
				{isLoading ? (
					<ActivityIndicator size="small" color={config.textColor} />
				) : (
					<Ionicons name={config.icon} size={20} color={config.textColor} />
				)}
				<Text className="text-base text-white">
					{getButtonText()}
				</Text>
			</View>
		</TouchableOpacity>
	)
}
