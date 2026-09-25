import { zodResolver } from '@hookform/resolvers/zod'
import { useLingui } from '@lingui/react/macro'
import { useLocalSearchParams } from 'expo-router'
import React from 'react'
import { useForm, Controller } from 'react-hook-form'
import { View, Text, ScrollView, TouchableOpacity } from 'react-native'
import { z } from 'zod'
import { Screen, Input, Button, ErrorText } from '../../components/ui'
import { navigateToSignIn } from '../../lib/navigation'

const ForgotPasswordSchema = z.object({
	email: z.string().email('Please enter a valid email address'),
})

type ForgotPasswordFormData = z.infer<typeof ForgotPasswordSchema>

export default function ForgotPasswordScreen() {
	const { t } = useLingui()
	const { redirectTo } = useLocalSearchParams<{
		redirectTo?: string
	}>()

	const {
		control,
		handleSubmit,
		formState: { errors, isValid },
		reset,
	} = useForm<ForgotPasswordFormData>({
		resolver: zodResolver(ForgotPasswordSchema),
		mode: 'onBlur',
		defaultValues: {
			email: '',
		},
	})

	const onSubmit = async (_data: ForgotPasswordFormData) => {
		// TODO: Implement forgot password API call
		// For now, just show a success message
		alert(
			t`If an account with that email exists, we've sent you a password reset link.`,
		)
		reset()
	}

	const handleBackToSignIn = () => {
		navigateToSignIn(redirectTo)
	}

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
						Reset your password
					</Text>
					<Text className="text-muted-foreground text-center text-base leading-6">
						Enter your email address and we'll send you a link to reset your
						password.
					</Text>
				</View>

				{/* Content */}
				<View className="flex-1">
					<View className="gap-4">
						<View className="gap-2">
							<Text className="text-foreground text-base">
								Email
							</Text>
							<Controller
								control={control}
								name="email"
								render={({ field: { onChange, onBlur, value } }) => (
									<Input
										placeholder="m@example.com"
										value={value}
										onChangeText={onChange}
										onBlur={onBlur}
										autoCapitalize="none"
										autoCorrect={false}
										autoComplete="email"
										keyboardType="email-address"
										returnKeyType="done"
										onSubmitEditing={handleSubmit(onSubmit)}
										error={!!errors.email}
										autoFocus
									/>
								)}
							/>
							{errors.email && <ErrorText>{errors.email.message}</ErrorText>}
						</View>

						<Button
							onPress={handleSubmit(onSubmit)}
							disabled={!isValid}
							className="mt-2"
						>
							Send reset link
						</Button>
					</View>
				</View>

				{/* Footer */}
				<View className="mt-auto flex-row items-center justify-center pt-8">
					<Text className="text-muted-foreground text-base">
						Remember your password?{' '}
					</Text>
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
