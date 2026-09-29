import React, { useState } from 'react'
import { View, Text, Alert } from 'react-native'
import { useAuth } from '../lib/auth/hooks/use-auth'
import { useOAuth, useOAuthProviders } from '../lib/auth/hooks/use-oauth'
import { SocialButton, Button, ErrorText } from './ui'

/**
 * Demo component showing OAuth authentication flow
 * This demonstrates how to integrate OAuth in mobile screens
 */
export function OAuthDemo() {
	const [selectedProvider, setSelectedProvider] = useState<string | null>(null)
	const { user, isAuthenticated, logout } = useAuth()
	const { configuredProviders, getProviderInfo } = useOAuthProviders()

	const { authenticate, isLoading, error, clearError } = useOAuth({
		onSuccess: (_result) => {
			Alert.alert(
				'OAuth Success',
				`Successfully authenticated with ${selectedProvider}!`,
				[{ text: 'OK', onPress: () => setSelectedProvider(null) }],
			)
		},
		onError: (error) => {
			Alert.alert('OAuth Error', error, [{ text: 'OK', onPress: clearError }])
		},
	})

	const handleOAuthLogin = async (provider: string) => {
		setSelectedProvider(provider)
		clearError()
		void authenticate(provider)
	}

	const handleLogout = async () => {
		Alert.alert('Logout', 'Are you sure you want to logout?', [
			{ text: 'Cancel', style: 'cancel' },
			{
				text: 'Logout',
				style: 'destructive',
				onPress: logout,
			},
		])
	}

	if (isAuthenticated && user) {
		return (
			<View className="flex-1 justify-center p-5">
				<Text className="text-foreground mb-2 text-center text-2xl font-bold">
					Welcome!
				</Text>
				<Text className="text-muted-foreground mb-8 text-center text-base">
					You are logged in as:
				</Text>

				<View className="bg-secondary mb-6 items-center rounded-lg p-5">
					<Text className="text-foreground mb-1 text-lg">{user.email}</Text>
					<Text className="text-muted-foreground mb-1 text-base">
						@{user.username}
					</Text>
					{user.name && (
						<Text className="text-foreground text-base">{user.name}</Text>
					)}
				</View>

				<Button onPress={handleLogout} variant="outline" className="mt-4">
					Logout
				</Button>
			</View>
		)
	}

	return (
		<View className="flex-1 justify-center p-5">
			<Text className="text-foreground mb-2 text-center text-2xl font-bold">
				OAuth Demo
			</Text>
			<Text className="text-muted-foreground mb-8 text-center text-base">
				Choose a provider to authenticate with:
			</Text>

			{error && <ErrorText className="mb-4 text-center">{error}</ErrorText>}

			<View className="mb-8">
				{configuredProviders.length > 0 ? (
					configuredProviders.map((provider) => {
						return (
							<SocialButton
								key={provider}
								provider={provider as 'github' | 'google'}
								type="login"
								onPress={() => handleOAuthLogin(provider)}
								disabled={isLoading}
								loading={isLoading && selectedProvider === provider}
							/>
						)
					})
				) : (
					<View className="rounded-lg border border-yellow-500 bg-yellow-100 p-5">
						<Text className="mb-2 text-center text-base text-yellow-800">
							No OAuth providers configured
						</Text>
						<Text className="text-center text-sm leading-5 text-yellow-800">
							Please set EXPO_PUBLIC_GITHUB_CLIENT_ID or
							EXPO_PUBLIC_GOOGLE_CLIENT_ID in your environment variables
						</Text>
					</View>
				)}
			</View>

			<View className="border-border bg-card rounded-lg border p-4">
				<Text className="text-foreground mb-2 text-sm">
					Available Providers:
				</Text>
				{configuredProviders.map((provider) => {
					const info = getProviderInfo(provider)
					return (
						<Text key={provider} className="text-muted-foreground mb-1 text-xs">
							• {info?.displayName} {info?.isConfigured ? '✅' : '❌'}
						</Text>
					)
				})}
			</View>
		</View>
	)
}

/**
 * Example usage in a screen:
 *
 * ```tsx
 * import { OAuthDemo } from '../components/oauth-demo'
 *
 * export default function OAuthTestScreen() {
 *   return <OAuthDemo />
 * }
 * ```
 */
