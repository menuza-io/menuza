import { Trans, useLingui } from '@lingui/react/macro'
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
} from '../../components/ui'
import { useCreateOrganization } from '../../lib/api/hooks/use-create-organization'
import { useOrganizations } from '../../lib/api/hooks/use-organizations'

function slugify(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, '')
		.replace(/[\s_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
}

export default function CreateOrganizationScreen() {
	const { t } = useLingui()
	const { createOrganization, isCreating, error, clearError } =
		useCreateOrganization()
	const { refetch } = useOrganizations()

	const [name, setName] = useState('')
	const [slug, setSlug] = useState('')
	const [description, setDescription] = useState('')
	const [slugManuallyEdited, setSlugManuallyEdited] = useState(false)

	const slugRef = useRef<TextInput>(null)
	const descriptionRef = useRef<TextInput>(null)

	// Auto-generate slug from name unless manually edited
	useEffect(() => {
		if (!slugManuallyEdited && name) {
			setSlug(slugify(name))
		}
	}, [name, slugManuallyEdited])

	const validateSlug = (value: string): string | null => {
		if (value.length < 2) {
			return t`Slug must be at least 2 characters`
		}
		if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value)) {
			return t`Slug can only contain lowercase letters, numbers, and hyphens`
		}
		return null
	}

	const handleCreate = async () => {
		// Validate name
		if (name.trim().length < 2) {
			Alert.alert(t`Error`, t`Organization name must be at least 2 characters`)
			return
		}

		// Validate slug
		const slugError = validateSlug(slug)
		if (slugError) {
			Alert.alert(t`Error`, slugError)
			return
		}

		clearError()

		const result = await createOrganization({
			name: name.trim(),
			slug: slug.trim(),
			description: description.trim() || undefined,
		})

		if (result.success) {
			await refetch()
			Alert.alert(
				t`Success`,
				t`Organization "${result.organization?.name}" created successfully!`,
				[
					{
						text: t`OK`,
						onPress: () => router.back(),
					},
				],
			)
		} else {
			Alert.alert(t`Error`, result.error || t`Failed to create organization`)
		}
	}

	const handleSlugChange = (value: string) => {
		setSlugManuallyEdited(true)
		// Only allow valid slug characters
		const sanitized = value.toLowerCase().replace(/[^a-z0-9-]/g, '')
		setSlug(sanitized)
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
					{/* Header */}
					<View className="mb-6">
						<Text className="text-foreground text-2xl font-bold">
							<Trans>Create Organization</Trans>
						</Text>
						<Text className="text-muted-foreground mt-1 text-sm">
							<Trans>Set up a new organization for your team</Trans>
						</Text>
					</View>

					{/* Form */}
					<Card className="mb-4">
						<CardHeader>
							<Text className="text-foreground text-lg">
								<Trans>Organization Details</Trans>
							</Text>
						</CardHeader>
						<CardContent>
							<View className="gap-4">
								<Input
									label={t`Organization Name *`}
									value={name}
									onChangeText={setName}
									placeholder={t`Enter organization name`}
									autoCapitalize="words"
									returnKeyType="next"
									onSubmitEditing={() => slugRef.current?.focus()}
								/>

								<View>
									<Input
										ref={slugRef}
										label={t`Slug *`}
										value={slug}
										onChangeText={handleSlugChange}
										placeholder={t`organization-slug`}
										autoCapitalize="none"
										autoCorrect={false}
										returnKeyType="next"
										onSubmitEditing={() => descriptionRef.current?.focus()}
									/>
									<Text className="text-muted-foreground mt-1 text-xs">
										<Trans>
											URL-friendly identifier (lowercase letters, numbers,
											hyphens only)
										</Trans>
									</Text>
								</View>

								<View>
									<Input
										ref={descriptionRef}
										label={t`Description (optional)`}
										value={description}
										onChangeText={setDescription}
										placeholder={t`Brief description of your organization`}
										multiline
										numberOfLines={3}
										returnKeyType="done"
										className="min-h-[80px]"
									/>
								</View>
							</View>

							{error && (
								<View className="bg-destructive/10 mt-3 rounded-lg p-3">
									<Text className="text-destructive text-sm">{error}</Text>
								</View>
							)}
						</CardContent>
					</Card>

					{/* Preview */}
					{slug && (
						<Card className="mb-4">
							<CardContent className="p-4">
								<Text className="text-muted-foreground mb-1 text-xs font-medium uppercase">
									<Trans>Organization URL Preview</Trans>
								</Text>
								<Text className="text-foreground text-sm">
									app.example.com/
									<Text className="text-primary">{slug}</Text>
								</Text>
							</CardContent>
						</Card>
					)}

					{/* Buttons */}
					<View className="gap-3">
						<Button
							onPress={handleCreate}
							loading={isCreating}
							disabled={isCreating || !name.trim() || !slug.trim()}
						>
							<Trans>Create Organization</Trans>
						</Button>
						<Button
							variant="outline"
							onPress={() => router.back()}
							disabled={isCreating}
						>
							<Trans>Cancel</Trans>
						</Button>
					</View>
				</ScrollView>
			</KeyboardAvoidingView>
		</Screen>
	)
}
