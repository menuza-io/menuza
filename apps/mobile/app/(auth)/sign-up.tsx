import { zodResolver } from '@hookform/resolvers/zod'
import { Trans, useLingui } from '@lingui/react/macro'
import { MobileSignupSchema } from '@repo/validation'
import { useLocalSearchParams, router } from 'expo-router'
import * as WebBrowser from 'expo-web-browser'
import React, { useState, useRef } from 'react'
import { useForm, Controller } from 'react-hook-form'
import {
	View,
	Text,
	ScrollView,
	Alert,
	TouchableOpacity,
	type TextInput,
} from 'react-native'
import { type z } from 'zod'
import {
	Screen,
	Input,
	Button,
	ErrorText,
	Divider,
	SocialButton,
	LoadingOverlay,
	SuccessAnimation,
} from '../../components/ui'
import { useSignup } from '../../lib/auth/hooks/use-auth-actions'
import { useOAuthProviders } from '../../lib/auth/hooks/use-oauth'
import { triggerSuccessHaptic, triggerErrorHaptic } from '../../lib/haptics'
import { dismissKeyboard } from '../../lib/keyboard'
import { navigateToSignIn, navigateAfterAuth } from '../../lib/navigation'

type SignupFormData = z.infer<typeof MobileSignupSchema>

export default function SignUpScreen() {
	const { t } = useLingui()
	const { redirectTo, inviteToken } = useLocalSearchParams<{
		redirectTo?: string
		inviteToken?: string
	}>()

	const {
		signup,
		isLoading: isSignupLoading,
		error: signupError,
		clearError,
	} = useSignup()
	const { configuredProviders } = useOAuthProviders()

	const [showSuccess, setShowSuccess] = useState(false)

	// Input ref for focus management
	const emailRef = useRef<TextInput>(null)

	const {
		control,
		handleSubmit,
		formState: { errors, isValid },
		reset,
	} = useForm<SignupFormData>({
		resolver: zodResolver(MobileSignupSchema),
		mode: 'onChange',
		defaultValues: {
			email: '',
		},
	})

	const onSubmit = async (data: SignupFormData) => {
		try {
			// Clear any previous errors
			clearError()

			// Dismiss keyboard before submitting
			dismissKeyboard()

			await signup(data.email)

			// Show success alert
			Alert.alert(
				t`Check your email`,
				t`We've sent you a verification link to complete your signup.`,
				[
					{
						text: t`OK`,
						onPress: () => {
							// Navigate to verification screen with email parameter
							router.push({
								pathname: '/(auth)/verify-code',
								params: {
									email: data.email,
									type: 'onboarding',
									...(redirectTo && { redirectTo }),
								},
							})
						},
					},
				],
			)

			// Show success animation and haptic feedback
			await triggerSuccessHaptic()
			setShowSuccess(true)

			// Reset form on success
			reset()
		} catch (error) {
			// Trigger error haptic feedback
			await triggerErrorHaptic()
			console.error('Signup submission error:', error)
		}
	}

	const handleSocialSuccess = async () => {
		// Show success animation and haptic feedback
		await triggerSuccessHaptic()
		setShowSuccess(true)

		// Navigate after a brief delay to show success animation
		setTimeout(() => {
			setShowSuccess(false)
			navigateAfterAuth(redirectTo)
		}, 1500)

		clearError()
	}

	const handleSocialError = async (error: string) => {
		await triggerErrorHaptic()
		Alert.alert(t`Authentication Error`, error)
	}

	const handleNavigateToSignIn = () => {
		navigateToSignIn(redirectTo)
	}

	const currentError = signupError
	const isLoading = isSignupLoading

	// Determine if this is an organization invite signup
	const isInviteSignup = !!inviteToken

	return (
		<Screen className="bg-zinc-900">
			<ScrollView
				contentContainerClassName="grow px-6 pt-16 pb-10"
				keyboardShouldPersistTaps="handled"
				showsVerticalScrollIndicator={false}
			>
				{/* Header */}
				<View className="mb-10 items-center">
					<Text className="mb-3 text-center text-3xl font-bold text-zinc-100">
						{isInviteSignup ? (
							<Trans>Join organization</Trans>
						) : (
							<Trans>Create an account</Trans>
						)}
					</Text>
					<Text className="text-center text-base leading-6 text-zinc-400">
						{isInviteSignup ? (
							<Trans>Complete your signup to join the organization</Trans>
						) : (
							<Trans>Sign up with your social account or email</Trans>
						)}
					</Text>
				</View>

				{/* Content */}
				<View className="flex-1">
					{/* Organization Invite Message */}
					{isInviteSignup && (
						<View className="bg-primary/10 border-primary/30 mb-6 rounded-lg border p-4">
							<View className="mb-2 flex-row items-center">
								<Text className="mr-2 text-xl">📧</Text>
								<Text className="text-primary text-base">
									<Trans>Organization Invite</Trans>
								</Text>
							</View>
							<Text className="text-primary/80 text-sm leading-5">
								<Trans>
									You've been invited to join an organization. Complete your
									signup to get started.
								</Trans>
							</Text>
						</View>
					)}

					{/* Social Signup Buttons */}
					<View className="mb-6 gap-2">
						{configuredProviders.map((provider) => (
							<SocialButton
								key={provider}
								provider={provider as 'github' | 'google'}
								type="signup"
								disabled={isLoading}
								redirectTo={redirectTo}
								onSuccess={handleSocialSuccess}
								onError={handleSocialError}
							/>
						))}
					</View>

					{/* Divider */}
					<Divider text={t`Or continue with email`} />

					{/* Error Display */}
					{currentError && (
						<ErrorText className="mb-4 text-center">{currentError}</ErrorText>
					)}

					{/* Signup Form */}
					<View className="gap-4">
						<View className="gap-2">
							<Text className="text-foreground text-base">
								<Trans>Email</Trans>
							</Text>
							<Controller
								control={control}
								name="email"
								render={({ field: { onChange, onBlur, value } }) => (
									<Input
										ref={emailRef}
										placeholder={t`m@example.com`}
										value={value}
										onChangeText={onChange}
										onBlur={onBlur}
										inputType="email"
										onSubmitEditing={handleSubmit(onSubmit)}
										editable={!isLoading}
										error={!!errors.email}
										autoFocus
									/>
								)}
							/>
							{errors.email && <ErrorText>{errors.email.message}</ErrorText>}
						</View>

						{/* Submit Button */}
						<Button
							onPress={handleSubmit(onSubmit)}
							disabled={!isValid || isLoading}
							loading={isSignupLoading}
							className="mt-2"
						>
							<Trans>Sign up</Trans>
						</Button>
					</View>

					{/* Terms and Privacy */}
					<Text className="text-muted-foreground mt-4 text-center text-xs leading-5">
						<Trans>By signing up, you agree to our</Trans>{' '}
						<Text
							className="text-primary font-medium"
							onPress={() => WebBrowser.openBrowserAsync('https://google.com')}
						>
							<Trans>Terms of Service</Trans>
						</Text>{' '}
						<Trans>and</Trans>{' '}
						<Text
							className="text-primary font-medium"
							onPress={() => WebBrowser.openBrowserAsync('https://google.com')}
						>
							<Trans>Privacy Policy</Trans>
						</Text>
						.
					</Text>
				</View>

				{/* Footer */}
				<View className="mt-auto flex-row items-center justify-center pt-8">
					<Text className="text-muted-foreground text-base">
						<Trans>Already have an account?</Trans>{' '}
					</Text>
					<TouchableOpacity
						onPress={handleNavigateToSignIn}
						accessibilityRole="link"
					>
						<Text className="text-primary text-base">
							<Trans>Sign in</Trans>
						</Text>
					</TouchableOpacity>
				</View>
			</ScrollView>

			{/* Loading Overlay */}
			<LoadingOverlay
				visible={isSignupLoading}
				message={t`Creating your account...`}
			/>

			{/* Success Animation */}
			<SuccessAnimation
				visible={showSuccess}
				message={t`Account created!`}
				onComplete={() => setShowSuccess(false)}
			/>
		</Screen>
	)
}
