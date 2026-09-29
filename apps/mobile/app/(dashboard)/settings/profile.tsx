import { useLingui } from '@lingui/react/macro'
import { router } from 'expo-router'
import React, { useState, useRef, useEffect } from 'react'
import {
	View,
	Text,
	ScrollView,
	type TextInput,
	Alert,
	KeyboardAvoidingView,
	Platform,
} from 'react-native'
import {
	Screen,
	Card,
	CardHeader,
	CardContent,
	Button,
	Input,
} from '../../../components/ui'
import { useProfile } from '../../../lib/api/hooks/use-profile'
import { useAuth } from '../../../lib/auth/hooks/use-auth'

export default function ProfileEditScreen() {
	const { t } = useLingui()
	const { user, refreshTokens } = useAuth()
	const { updateProfile, isUpdating, error, clearError } = useProfile()

	const [name, setName] = useState(user?.name || '')
	const [username, setUsername] = useState(user?.username || '')
	const [hasChanges, setHasChanges] = useState(false)

	const usernameRef = useRef<TextInput>(null)

	useEffect(() => {
		const nameChanged = name !== (user?.name || '')
		const usernameChanged = username !== (user?.username || '')
		setHasChanges(nameChanged || usernameChanged)
	}, [name, username, user])

	const handleSave = async () => {
		if (!username.trim()) {
			Alert.alert(t`Error`, t`Username is required`)
			return
		}

		clearError()
		const result = await updateProfile({
			name: name.trim() || undefined,
			username: username.trim(),
		})

		if (result.success) {
			Alert.alert(t`Success`, t`Profile updated successfully`, [
				{
					text: t`OK`,
					onPress: () => {
						void refreshTokens()
						router.back()
					},
				},
			])
		} else {
			Alert.alert(t`Error`, result.error || t`Failed to update profile`)
		}
	}

	return (
		<Screen>
			<KeyboardAvoidingView
				behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
				className="flex-1"
			>
				<ScrollView
					contentContainerClassName="grow p-4"
					showsVerticalScrollIndicator={false}
					keyboardShouldPersistTaps="handled"
				>
					{/* Profile Avatar */}
					<View className="mb-6 items-center">
						<View className="bg-primary h-24 w-24 items-center justify-center rounded-full">
							<Text className="text-primary-foreground text-3xl font-bold">
								{(name || username || 'U').charAt(0).toUpperCase()}
							</Text>
						</View>
					</View>

					{/* Form */}
					<Card className="mb-4">
						<CardHeader>
							<Text className="text-foreground text-lg">
								Profile Information
							</Text>
						</CardHeader>
						<CardContent>
							<View className="gap-4">
								<Input
									label="Name"
									value={name}
									onChangeText={setName}
									placeholder="Enter your name"
									autoCapitalize="words"
									returnKeyType="next"
									onSubmitEditing={() => usernameRef.current?.focus()}
								/>

								<Input
									ref={usernameRef}
									label="Username"
									value={username}
									onChangeText={setUsername}
									placeholder="Enter your username"
									autoCapitalize="none"
									autoCorrect={false}
									returnKeyType="done"
								/>

								<View className="bg-muted rounded-lg p-3">
									<Text className="text-muted-foreground text-sm">
										Email: {user?.email}
									</Text>
									<Text className="text-muted-foreground mt-1 text-xs italic">
										Email cannot be changed here
									</Text>
								</View>
							</View>

							{error && (
								<Text className="text-destructive mt-3 text-sm">{error}</Text>
							)}
						</CardContent>
					</Card>

					{/* Save Button */}
					<Button
						onPress={handleSave}
						loading={isUpdating}
						disabled={!hasChanges || isUpdating}
						className="mt-2"
					>
						Save Changes
					</Button>
				</ScrollView>
			</KeyboardAvoidingView>
		</Screen>
	)
}
