import { zodResolver } from '@hookform/resolvers/zod'
import { PasswordSchema } from '@repo/validation'
import { useLocalSearchParams, router } from 'expo-router'
import React, { useState, useRef } from 'react'
import { useForm, Controller } from 'react-hook-form'
import {
	View,
	Text,
	ScrollView,
	TouchableOpacity,
	type TextInput,
} from 'react-native'
import { z } from 'zod'
import {
	Screen,
	Input,
	Button,
	ErrorText,
	Checkbox,
	LoadingOverlay,
	SuccessAnimation,
} from '../../components/ui'
import { useOnboarding } from '../../lib/auth/hooks'
import {
	triggerSuccessHaptic,
	triggerErrorHaptic,
} from '../../lib/haptics/haptic-utils'
import { dismissKeyboard } from '../../lib/keyboard/keyboard-utils'
import { navigateAfterAuth } from '../../lib/navigation'

const OnboardingSchema = z
	.object({
		username: z
			.string()
			.min(3, 'Username must be at least 3 characters')
			.max(20, 'Username must be less than 20 characters')
			.regex(
				/^[a-zA-Z0-9_]+$/,
				'Username can only contain letters, numbers, and underscores',
			),
		name: z
			.string()
			.min(3, 'Name must be at least 3 characters')
			.max(40, 'Name must be less than 40 characters'),
		password: PasswordSchema,
		confirmPassword: PasswordSchema,
		agreeToTermsOfServiceAndPrivacyPolicy: z
			.boolean()
			.refine((val) => val === true, {
				message: 'You must agree to the terms of service and privacy policy',
			}),
		remember: z.boolean().optional(),
	})
	.refine((data) => data.password === data.confirmPassword, {
		message: 'Passwords do not match',
		path: ['confirmPassword'],
	})

type OnboardingFormData = z.infer<typeof OnboardingSchema>

export default function OnboardingScreen() {
	const { email, redirectTo } = useLocalSearchParams<{
		email?: string
		verified?: string
		redirectTo?: string
	}>()

	const { onboarding, isLoading, error, clearError } = useOnboarding()
	const [showPassword, setShowPassword] = useState(false)
	const [showConfirmPassword, setShowConfirmPassword] = useState(false)
	const [showSuccess, setShowSuccess] = useState(false)

	// Input refs for focus management
	const usernameRef = useRef<TextInput>(null)
	const nameRef = useRef<TextInput>(null)
	const passwordRef = useRef<TextInput>(null)
	const confirmPasswordRef = useRef<TextInput>(null)

	const {
		control,
		handleSubmit,
		formState: { errors, isValid },
	} = useForm<OnboardingFormData>({
		resolver: zodResolver(OnboardingSchema),
		mode: 'onBlur',
		defaultValues: {
			username: '',
			name: '',
			password: '',
			confirmPassword: '',
			agreeToTermsOfServiceAndPrivacyPolicy: false,
			remember: false,
		},
	})

	const onSubmit = async (data: OnboardingFormData) => {
		try {
			// Dismiss keyboard before submitting
			dismissKeyboard()

			// Clear any previous errors
			if (error) {
				clearError()
			}

			await onboarding({
				email: email || '', // Pass the email from verification
				username: data.username,
				name: data.name,
				password: data.password,
				confirmPassword: data.confirmPassword,
				agreeToTermsOfServiceAndPrivacyPolicy:
					data.agreeToTermsOfServiceAndPrivacyPolicy,
				remember: data.remember,
				redirectTo,
			})

			// Show success animation and haptic feedback
			await triggerSuccessHaptic()
			setShowSuccess(true)

			// Navigate after success animation
			setTimeout(() => {
				setShowSuccess(false)
				navigateAfterAuth(redirectTo)
			}, 2000)
		} catch (error) {
			// Trigger error haptic feedback
			await triggerErrorHaptic()
			console.error('Onboarding error:', error)
		}
	}

	const handleBackToVerification = () => {
		router.back()
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
						Complete your profile
					</Text>
					<Text className="text-muted-foreground text-center text-base leading-6">
						{email
							? `Almost done! Create your profile for ${email}`
							: 'Just a few more details to complete your account setup.'}
					</Text>
				</View>

				{/* Content */}
				<View className="flex-1">
					<View className="gap-5">
						<View className="gap-2">
							<Text className="text-foreground mb-1 text-base">
								Username
							</Text>
							<Controller
								control={control}
								name="username"
								render={({ field: { onChange, onBlur, value } }) => (
									<Input
										ref={usernameRef}
										placeholder="Enter your username"
										value={value}
										onChangeText={onChange}
										onBlur={onBlur}
										autoCapitalize="none"
										autoCorrect={false}
										returnKeyType="next"
										onSubmitEditing={() => nameRef.current?.focus()}
										error={!!errors.username}
									/>
								)}
							/>
							{errors.username && (
								<ErrorText>{errors.username.message}</ErrorText>
							)}
						</View>

						<View className="gap-2">
							<Text className="text-foreground mb-1 text-base">
								Full Name
							</Text>
							<Controller
								control={control}
								name="name"
								render={({ field: { onChange, onBlur, value } }) => (
									<Input
										ref={nameRef}
										placeholder="Enter your full name"
										value={value}
										onChangeText={onChange}
										onBlur={onBlur}
										autoCapitalize="words"
										returnKeyType="next"
										onSubmitEditing={() => passwordRef.current?.focus()}
										error={!!errors.name}
									/>
								)}
							/>
							{errors.name && <ErrorText>{errors.name.message}</ErrorText>}
						</View>

						<View className="gap-2">
							<Text className="text-foreground mb-1 text-base">
								Password
							</Text>
							<Controller
								control={control}
								name="password"
								render={({ field: { onChange, onBlur, value } }) => (
									<Input
										ref={passwordRef}
										placeholder="Create a password"
										value={value}
										onChangeText={onChange}
										onBlur={onBlur}
										secureTextEntry={!showPassword}
										autoCapitalize="none"
										autoCorrect={false}
										returnKeyType="next"
										onSubmitEditing={() => confirmPasswordRef.current?.focus()}
										error={!!errors.password}
										rightIcon={
											<TouchableOpacity
												onPress={() => setShowPassword(!showPassword)}
												className="p-1"
												accessibilityLabel={
													showPassword ? 'Hide password' : 'Show password'
												}
												accessibilityRole="button"
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

						<View className="gap-2">
							<Text className="text-foreground mb-1 text-base">
								Confirm Password
							</Text>
							<Controller
								control={control}
								name="confirmPassword"
								render={({ field: { onChange, onBlur, value } }) => (
									<Input
										ref={confirmPasswordRef}
										placeholder="Confirm your password"
										value={value}
										onChangeText={onChange}
										onBlur={onBlur}
										secureTextEntry={!showConfirmPassword}
										autoCapitalize="none"
										autoCorrect={false}
										returnKeyType="done"
										onSubmitEditing={handleSubmit(onSubmit)}
										error={!!errors.confirmPassword}
										rightIcon={
											<TouchableOpacity
												onPress={() =>
													setShowConfirmPassword(!showConfirmPassword)
												}
												className="p-1"
												accessibilityLabel={
													showConfirmPassword
														? 'Hide confirm password'
														: 'Show confirm password'
												}
												accessibilityRole="button"
											>
												<Text className="text-lg">
													{showConfirmPassword ? '🙈' : '👁️'}
												</Text>
											</TouchableOpacity>
										}
									/>
								)}
							/>
							{errors.confirmPassword && (
								<ErrorText>{errors.confirmPassword.message}</ErrorText>
							)}
						</View>

						<View className="gap-2">
							<Controller
								control={control}
								name="agreeToTermsOfServiceAndPrivacyPolicy"
								render={({ field: { onChange, value } }) => (
									<Checkbox
										checked={value}
										onCheckedChange={onChange}
										label="I agree to the Terms of Service and Privacy Policy"
										error={!!errors.agreeToTermsOfServiceAndPrivacyPolicy}
									/>
								)}
							/>
							{errors.agreeToTermsOfServiceAndPrivacyPolicy && (
								<ErrorText className="mt-1">
									{errors.agreeToTermsOfServiceAndPrivacyPolicy.message}
								</ErrorText>
							)}
						</View>

						<View className="gap-2">
							<Controller
								control={control}
								name="remember"
								render={({ field: { onChange, value } }) => (
									<Checkbox
										checked={value}
										onCheckedChange={onChange}
										label="Keep me signed in"
									/>
								)}
							/>
						</View>

						{error && (
							<ErrorText className="mt-2 text-center">{error}</ErrorText>
						)}

						<Button
							onPress={handleSubmit(onSubmit)}
							disabled={!isValid || isLoading}
							className="mt-2"
						>
							{isLoading ? 'Creating account...' : 'Create account'}
						</Button>
					</View>
				</View>

				{/* Footer */}
				<View className="mt-auto items-center pt-8">
					<TouchableOpacity
						onPress={handleBackToVerification}
						accessibilityRole="link"
					>
						<Text className="text-primary text-base">
							Back to verification
						</Text>
					</TouchableOpacity>
				</View>
			</ScrollView>

			{isLoading && (
				<LoadingOverlay visible={isLoading} message="Creating account..." />
			)}
			{showSuccess && (
				<SuccessAnimation visible={showSuccess} message="Account created!" />
			)}
		</Screen>
	)
}
