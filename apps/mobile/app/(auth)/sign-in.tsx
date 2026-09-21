import { zodResolver } from '@hookform/resolvers/zod'
import { Trans, useLingui } from '@lingui/react/macro'
import { MobileLoginFormSchema } from '@repo/validation'
import { useLocalSearchParams } from 'expo-router'
import React, { useState, useRef } from 'react'
import { useForm, Controller } from 'react-hook-form'
import {
	View,
	Text,
	Alert,
	TouchableOpacity,
	ScrollView,
	Pressable,
	type TextInput,
} from 'react-native'
import { type z } from 'zod'
import {
	Screen,
	Input,
	Button,
	ErrorText,
	Checkbox,
	Divider,
	SocialButton,
	LoadingOverlay,
	SuccessAnimation,
} from '../../components/ui'
import { useLogin } from '../../lib/auth/hooks/use-auth-actions'
import { useOAuthProviders } from '../../lib/auth/hooks/use-oauth'
import { triggerSuccessHaptic, triggerErrorHaptic } from '../../lib/haptics'
import { dismissKeyboard } from '../../lib/keyboard'
import { navigateToSignUp, navigateAfterAuth } from '../../lib/navigation'

type LoginFormData = z.infer<typeof MobileLoginFormSchema>

export default function SignInScreen() {
	const { t } = useLingui()
	const { banned, redirectTo } = useLocalSearchParams<{
		banned?: string
		redirectTo?: string
	}>()
	const isBanned = banned === 'true'

	const {
		login,
		isLoading: isLoginLoading,
		error: loginError,
		clearError,
	} = useLogin()
	const { configuredProviders } = useOAuthProviders()

	const [showPassword, setShowPassword] = useState(false)
	const [showSuccess, setShowSuccess] = useState(false)

	// Input refs for focus management
	const usernameRef = useRef<TextInput>(null)
	const passwordRef = useRef<TextInput>(null)

	const {
		control,
		handleSubmit,
		formState: { errors, isValid },
		reset,
	} = useForm<LoginFormData>({
		resolver: zodResolver(MobileLoginFormSchema),
		mode: 'onChange',
		defaultValues: {
			username: '',
			password: '',
			remember: false,
		},
	})

	const onSubmit = async (data: LoginFormData) => {
		try {
			// Clear any previous errors
			clearError()

			// Dismiss keyboard before submitting
			dismissKeyboard()

			await login({
				username: data.username,
				password: data.password,
				remember: data.remember,
				redirectTo: redirectTo || undefined,
			})

			// If we get here, login was successful (no error thrown)
			// Show success animation and haptic feedback
			await triggerSuccessHaptic()
			setShowSuccess(true)

			// Navigate after a brief delay to show success animation
			setTimeout(() => {
				setShowSuccess(false)
				navigateAfterAuth(redirectTo)
			}, 1500)

			// Reset form on success
			reset()
		} catch (error) {
			console.error('❌ Login submission error:', error)
			// Trigger error haptic feedback
			await triggerErrorHaptic()
			// Error will be displayed via the error state from useLogin
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

	const handleForgotPassword = () => {
		Alert.alert(
			t`Forgot Password`,
			t`Forgot password functionality will be available soon. Please contact support for assistance.`,
			[{ text: t`OK` }],
		)
	}

	const handleNavigateToSignUp = () => {
		navigateToSignUp(redirectTo)
	}

	const currentError = loginError
	const isLoading = isLoginLoading

	return (
		<Screen className="bg-background">
			<ScrollView
				contentContainerClassName="grow px-6 pt-16 pb-10"
				keyboardShouldPersistTaps="handled"
				showsVerticalScrollIndicator={false}
			>
				{/* Header */}
				<View className="mb-10 items-center">
					<Text className="text-foreground mb-3 text-center text-3xl font-bold">
						<Trans>Welcome back</Trans>
					</Text>
					<Text className="text-muted-foreground text-center text-base leading-6">
						<Trans>Sign in with your social account or username</Trans>
					</Text>
				</View>

				{/* Content */}
				<View className="flex-1">
					{/* Banned Account Warning */}
					{isBanned && (
						<View className="bg-destructive/10 border-destructive/30 mb-6 rounded-lg border p-4">
							<View className="mb-2 flex-row items-center">
								<Text className="mr-2 text-xl">🔒</Text>
								<Text className="text-destructive text-base">
									<Trans>Account Suspended</Trans>
								</Text>
							</View>
							<Text className="text-destructive/80 mb-3 text-sm leading-5">
								<Trans>
									Your account has been suspended. Please contact support if you
									believe this is an error.
								</Trans>
							</Text>
							<Pressable
								className="bg-destructive self-start rounded-md px-3 py-2"
								onPress={() =>
									Alert.alert(
										t`Contact Support`,
										t`Please email support@example.com for assistance.`,
									)
								}
								accessibilityRole="button"
								accessibilityLabel={t`Contact Support`}
							>
								<Text className="text-sm text-white">
									<Trans>Contact Support</Trans>
								</Text>
							</Pressable>
						</View>
					)}

					{/* Social Login Buttons */}
					<View className="mb-6 gap-2">
						{configuredProviders.map((provider) => (
							<SocialButton
								key={provider}
								provider={provider as 'github' | 'google'}
								type="login"
								disabled={isLoading || isBanned}
								redirectTo={redirectTo}
								onSuccess={handleSocialSuccess}
								onError={handleSocialError}
							/>
						))}
					</View>

					{/* Divider */}
					<Divider text={t`Or continue with username`} />

					{/* Error Display */}
					{currentError && (
						<ErrorText className="mb-4 text-center">{currentError}</ErrorText>
					)}

					{/* Login Form */}
					<View className="gap-4">
						<View className="gap-2">
							<Text className="text-foreground text-base">
								<Trans>Username</Trans>
							</Text>
							<Controller
								control={control}
								name="username"
								render={({ field: { onChange, onBlur, value } }) => (
									<Input
										ref={usernameRef}
										placeholder={t`Enter your username`}
										value={value}
										onChangeText={onChange}
										onBlur={onBlur}
										inputType="username"
										nextInputRef={passwordRef}
										editable={!isLoading && !isBanned}
										error={!!errors.username}
									/>
								)}
							/>
							{errors.username && (
								<ErrorText>{errors.username.message}</ErrorText>
							)}
						</View>

						<View className="gap-2">
							<View className="flex-row items-center justify-between">
								<Text className="text-foreground text-base">
									<Trans>Password</Trans>
								</Text>
								<TouchableOpacity
									onPress={handleForgotPassword}
									accessibilityRole="link"
								>
									<Text className="text-primary text-sm font-medium">
										<Trans>Forgot password?</Trans>
									</Text>
								</TouchableOpacity>
							</View>
							<Controller
								control={control}
								name="password"
								render={({ field: { onChange, onBlur, value } }) => (
									<Input
										ref={passwordRef}
										placeholder={t`Enter your password`}
										value={value}
										onChangeText={onChange}
										onBlur={onBlur}
										secureTextEntry={!showPassword}
										inputType="password"
										onSubmitEditing={handleSubmit(onSubmit)}
										editable={!isLoading && !isBanned}
										error={!!errors.password}
										rightIcon={
											<TouchableOpacity
												onPress={() => setShowPassword(!showPassword)}
												className="p-1"
												accessibilityLabel={
													showPassword ? t`Hide password` : t`Show password`
												}
											>
												<Text className="text-lg">
													{showPassword ? '🙈' : '👁️'}
												</Text>
											</TouchableOpacity>
										}
									/>
								)}
							/>
							{errors.password && (
								<ErrorText>{errors.password.message}</ErrorText>
							)}
						</View>

						{/* Remember Me Checkbox */}
						<View className="mt-2">
							<Controller
								control={control}
								name="remember"
								render={({ field: { onChange, value } }) => (
									<Checkbox
										checked={value}
										onCheckedChange={onChange}
										label={t`Remember me`}
										disabled={isLoading || isBanned}
									/>
								)}
							/>
						</View>

						{/* Submit Button */}
						<Button
							onPress={handleSubmit(onSubmit)}
							disabled={!isValid || isLoading || isBanned}
							loading={isLoginLoading}
							className="mt-2"
						>
							<Trans>Sign In</Trans>
						</Button>
					</View>
				</View>

				{/* Footer */}
				<View className="mt-auto flex-row items-center justify-center pt-8">
					<Text className="text-muted-foreground text-base">
						<Trans>Don't have an account?</Trans>{' '}
					</Text>
					<TouchableOpacity
						onPress={handleNavigateToSignUp}
						accessibilityRole="link"
					>
						<Text className="text-primary text-base">
							<Trans>Create account</Trans>
						</Text>
					</TouchableOpacity>
				</View>
			</ScrollView>

			{/* Loading Overlay */}
			<LoadingOverlay visible={isLoginLoading} message={t`Signing you in...`} />

			{/* Success Animation */}
			<SuccessAnimation
				visible={showSuccess}
				message={t`Welcome back!`}
				onComplete={() => setShowSuccess(false)}
			/>
		</Screen>
	)
}
