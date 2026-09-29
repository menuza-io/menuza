import { zodResolver } from '@hookform/resolvers/zod'
import { Trans, useLingui } from '@lingui/react/macro'
import { useLocalSearchParams, router } from 'expo-router'
import React, { useState } from 'react'
import { useForm, Controller } from 'react-hook-form'
import {
	View,
	Text,
	ScrollView,
	TouchableOpacity,
	Alert,
	TextInput,
} from 'react-native'
import { z } from 'zod'
import { Screen, Button, ErrorText, LoadingOverlay } from '../../components/ui'
import { useVerify } from '../../lib/auth/hooks'
import {
	triggerSuccessHaptic,
	triggerErrorHaptic,
} from '../../lib/haptics/haptic-utils'
import { dismissKeyboard } from '../../lib/keyboard/keyboard-utils'
import { navigateToSignIn } from '../../lib/navigation'

const VerifyCodeSchema = z.object({
	code: z
		.string()
		.min(6, 'Code must be 6 characters')
		.max(6, 'Code must be 6 characters')
		.regex(/^[A-Za-z0-9]{6}$/, 'Code must contain only letters and numbers'),
})

type VerifyCodeFormData = z.infer<typeof VerifyCodeSchema>

export default function VerifyCodeScreen() {
	const { t } = useLingui()
	const {
		email,
		type = 'onboarding',
		redirectTo,
	} = useLocalSearchParams<{
		email?: string
		type?: string
		redirectTo?: string
	}>()

	const { verify, isLoading, error, clearError } = useVerify()
	const [isResending, setIsResending] = useState(false)

	const {
		control,
		handleSubmit,
		formState: { errors },
		reset,
		watch,
	} = useForm<VerifyCodeFormData>({
		resolver: zodResolver(VerifyCodeSchema),
		mode: 'onChange',
		defaultValues: {
			code: '',
		},
	})

	const codeValue = watch('code')

	// Auto-submit when code is complete (disabled for debugging)
	// useEffect(() => {
	//   if (codeValue && codeValue.length === 6) {
	//     handleSubmit(onSubmit)()
	//   }
	// }, [codeValue, handleSubmit])

	const onSubmit = async (data: VerifyCodeFormData) => {
		if (!email) {
			Alert.alert(t`Error`, t`No email address provided for verification.`)
			return
		}

		try {
			// Dismiss keyboard before submitting
			dismissKeyboard()

			await verify({
				code: data.code,
				type: type as 'onboarding',
				target: email,
				redirectTo,
			})

			// Show success haptic feedback
			await triggerSuccessHaptic()

			// Navigate to onboarding screen with verification token
			router.push({
				pathname: '/(auth)/onboarding',
				params: {
					email,
					verified: 'true', // Flag to indicate email was verified
					...(redirectTo && { redirectTo }),
				},
			})
		} catch {
			// Trigger error haptic feedback
			await triggerErrorHaptic()
		}
	}

	const handleResendCode = async () => {
		if (!email) {
			Alert.alert(t`Error`, t`No email address provided for resending code.`)
			return
		}

		setIsResending(true)
		try {
			// TODO: Implement resend verification code API call

			// Clear any existing errors
			if (error) {
				clearError()
			}

			// Reset the form
			reset()

			Alert.alert(
				t`Code Sent`,
				t`We've sent a new verification code to your email address.`,
				[{ text: t`OK` }],
			)
		} catch {
			Alert.alert(
				t`Error`,
				t`Failed to resend verification code. Please try again later.`,
			)
		} finally {
			setIsResending(false)
		}
	}

	const handleBackToSignUp = () => {
		router.back()
	}

	const handleGoToSignIn = () => {
		navigateToSignIn(redirectTo)
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
						<Trans>Enter verification code</Trans>
					</Text>
					<Text className="text-muted-foreground text-center text-base leading-6">
						{email
							? t`We've sent a 6-character code to ${email}. Enter it below to verify your account.`
							: t`Enter the 6-character verification code sent to your email.`}
					</Text>
				</View>

				{/* Content */}
				<View className="flex-1">
					<View className="gap-5">
						<Controller
							control={control}
							name="code"
							render={({ field: { onChange, value } }) => (
								<View className="mb-2 items-center">
									<Text className="text-foreground mb-3 text-center text-base">
										<Trans>Enter 6-character code:</Trans>
									</Text>
									<TextInput
										className={`bg-background text-foreground h-16 w-full rounded-xl border-2 text-center text-2xl tracking-widest ${
											errors.code
												? 'border-destructive bg-destructive/5'
												: isLoading
													? 'bg-muted text-muted-foreground'
													: 'border-border'
										}`}
										value={value}
										onChangeText={(text) => {
											// Allow alphanumeric characters and limit to 6 characters
											const code = text
												.replace(/[^A-Za-z0-9]/g, '')
												.slice(0, 6)
												.toUpperCase()
											onChange(code)
										}}
										placeholder={t`ABC123`}
										keyboardType="default"
										maxLength={6}
										editable={!isLoading}
										autoFocus={true}
										selectTextOnFocus={true}
										returnKeyType="done"
										accessibilityLabel={t`Verification code`}
										onSubmitEditing={() => {
											if (value.length === 6) {
												void handleSubmit(onSubmit)()
											}
										}}
									/>
								</View>
							)}
						/>

						{errors.code && (
							<ErrorText className="mt-2 text-center">
								{errors.code.message}
							</ErrorText>
						)}

						{error && (
							<ErrorText className="mt-2 text-center">{error}</ErrorText>
						)}

						<View className="mt-6 items-center gap-4">
							<Button
								onPress={handleSubmit(onSubmit)}
								disabled={isLoading || !codeValue || codeValue.length !== 6}
								className="w-full"
							>
								{isLoading ? t`Verifying...` : t`Verify Code`}
							</Button>

							<Text className="text-muted-foreground text-center text-sm leading-5">
								<Trans>
									Didn't receive the code? Check your spam folder or request a
									new one.
								</Trans>
							</Text>

							<Button
								onPress={handleResendCode}
								variant="outline"
								className="w-full"
								disabled={isResending}
							>
								{isResending ? t`Sending...` : t`Resend code`}
							</Button>
						</View>
					</View>
				</View>

				{/* Footer */}
				<View className="mt-auto flex-row items-center justify-center gap-2 pt-8">
					<TouchableOpacity
						onPress={handleBackToSignUp}
						accessibilityRole="link"
					>
						<Text className="text-primary text-base">
							<Trans>Back to sign up</Trans>
						</Text>
					</TouchableOpacity>

					<Text className="text-muted-foreground text-base">•</Text>

					<TouchableOpacity onPress={handleGoToSignIn} accessibilityRole="link">
						<Text className="text-primary text-base">
							<Trans>Already have an account?</Trans>
						</Text>
					</TouchableOpacity>
				</View>
			</ScrollView>

			{isLoading && (
				<LoadingOverlay visible={isLoading} message={t`Verifying code...`} />
			)}
		</Screen>
	)
}
