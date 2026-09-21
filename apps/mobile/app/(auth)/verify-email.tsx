import { useLocalSearchParams } from 'expo-router'
import React, { useEffect, useState } from 'react'
import { View, Text, ScrollView, TouchableOpacity, Alert } from 'react-native'
import { Screen, Button, ErrorText } from '../../components/ui'
import { navigateToSignIn } from '../../lib/navigation'

export default function VerifyEmailScreen() {
	const { token, email, redirectTo } = useLocalSearchParams<{
		token?: string
		email?: string
		redirectTo?: string
	}>()

	const [isVerifying, setIsVerifying] = useState(false)
	const [verificationError, setVerificationError] = useState<string | null>(
		null,
	)
	const [isVerified, setIsVerified] = useState(false)

	const handleVerifyEmail = React.useCallback(
		async (_verificationToken: string) => {
			setIsVerifying(true)
			setVerificationError(null)

			try {
				// TODO: Implement email verification API call
				// Simulate API call
				await new Promise((resolve) => setTimeout(resolve, 2000))

				// For now, just mark as verified
				setIsVerified(true)

				Alert.alert(
					'Email Verified!',
					'Your email has been successfully verified. You can now sign in to your account.',
					[
						{
							text: 'Continue to Sign In',
							onPress: () => {
								navigateToSignIn(redirectTo)
							},
						},
					],
				)
			} catch (error) {
				setVerificationError(
					error instanceof Error ? error.message : 'Email verification failed',
				)
			} finally {
				setIsVerifying(false)
			}
		},
		[redirectTo],
	)

	useEffect(() => {
		// If we have a token, automatically attempt verification
		if (token) {
			void handleVerifyEmail(token)
		}
	}, [token, handleVerifyEmail])

	const handleResendVerification = async () => {
		if (!email) {
			Alert.alert(
				'Error',
				'No email address provided for resending verification.',
			)
			return
		}

		try {
			// TODO: Implement resend verification API call
			Alert.alert(
				'Verification Email Sent',
				"We've sent another verification email to your inbox. Please check your email and click the verification link.",
				[{ text: 'OK' }],
			)
		} catch {
			Alert.alert(
				'Error',
				'Failed to resend verification email. Please try again later.',
			)
		}
	}

	const handleBackToSignIn = () => {
		navigateToSignIn(redirectTo)
	}

	if (isVerifying) {
		return (
			<Screen className="bg-background">
				<View className="flex-1 items-center justify-center px-6">
					<View className="items-center py-5">
						<Text className="mb-4 text-5xl" accessibilityLabel="Loading">
							⏳
						</Text>
						<Text className="text-foreground mb-3 text-center text-3xl font-bold">
							Verifying your email...
						</Text>
						<Text className="text-muted-foreground text-center text-base leading-6">
							Please wait while we verify your email address.
						</Text>
					</View>
				</View>
			</Screen>
		)
	}

	if (isVerified) {
		return (
			<Screen className="bg-background">
				<View className="flex-1 items-center justify-center px-6">
					<View className="items-center py-5">
						<Text className="mb-4 text-5xl" accessibilityLabel="Success">
							✅
						</Text>
						<Text className="text-foreground mb-3 text-center text-3xl font-bold">
							Email Verified!
						</Text>
						<Text className="text-muted-foreground text-center text-base leading-6">
							Your email has been successfully verified. You can now sign in to
							your account.
						</Text>

						<Button onPress={handleBackToSignIn} className="mt-2 w-full">
							Continue to Sign In
						</Button>
					</View>
				</View>
			</Screen>
		)
	}

	return (
		<Screen className="bg-background">
			<ScrollView
				contentContainerClassName="grow px-6 pt-16 pb-10"
				showsVerticalScrollIndicator={false}
			>
				{/* Header */}
				<View className="mb-10 items-center">
					<Text className="text-foreground mb-3 text-center text-3xl font-bold">
						Verify your email
					</Text>
					<Text className="text-muted-foreground text-center text-base leading-6">
						{email
							? `We've sent a verification link to ${email}. Click the link in your email to verify your account.`
							: 'Check your email for a verification link to complete your account setup.'}
					</Text>
				</View>

				{/* Content */}
				<View className="flex-1">
					{verificationError && (
						<ErrorText className="mb-4 text-center">
							{verificationError}
						</ErrorText>
					)}

					<View className="items-center gap-4">
						<Text className="text-muted-foreground text-center text-sm leading-5">
							Didn't receive the email? Check your spam folder or request a new
							one.
						</Text>

						{email && (
							<Button
								onPress={handleResendVerification}
								variant="outline"
								className="mt-2 w-full"
							>
								Resend verification email
							</Button>
						)}
					</View>
				</View>

				{/* Footer */}
				<View className="mt-auto items-center pt-8">
					<TouchableOpacity
						onPress={handleBackToSignIn}
						accessibilityRole="link"
					>
						<Text className="text-primary text-base">
							Back to sign in
						</Text>
					</TouchableOpacity>
				</View>
			</ScrollView>
		</Screen>
	)
}
