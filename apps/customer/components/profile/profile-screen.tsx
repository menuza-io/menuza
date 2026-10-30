import { useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'
import { Pressable, View } from 'react-native'
import { useAppSnapshot, useAppStore } from '../../lib/app/use-app'
import { localeLabel } from '../../lib/i18n/site-locale'
import { displayPhone } from '../../lib/support/phone-number'
import { isAcceptableName } from '../auth/complete-name-screen'
import {
	Button,
	Card,
	ErrorMessage,
	LoadingView,
	Screen,
	Text,
	TextField,
} from '../ui'

/**
 * The signed-in customer's details. Name and email are editable; the phone
 * number is the verified identity and stays read-only, as on Sites. An
 * un-branded install can leave the site from here, which also signs out.
 */
export function ProfileScreen() {
	const { t } = useLingui()
	const store = useAppStore()
	const {
		profile,
		profileStatus,
		isSavingProfile,
		didSaveProfile,
		error,
		canChangeSite,
	} = useAppSnapshot()
	const [name, setName] = useState(profile?.name ?? '')
	const [email, setEmail] = useState(profile?.email ?? '')

	// A fresh copy from the server (load, save) replaces what the fields show.
	useEffect(() => {
		if (!profile) return
		setName(profile.name ?? '')
		setEmail(profile.email ?? '')
	}, [profile])

	// "Saved" and the last error describe what the fields held; typing replaces both.
	const edit = (setter: (value: string) => void) => (value: string) => {
		setter(value)
		store.clearTransientMessages()
	}

	if (!profile) {
		if (profileStatus === 'failed') {
			return (
				<Screen>
					<View className="flex-1 justify-center">
						<ErrorMessage
							error={error}
							onRetry={() => void store.loadProfile()}
						/>
					</View>
				</Screen>
			)
		}
		return <LoadingView label={t`Loading your profile…`} />
	}

	const canSave = isAcceptableName(name) && !isSavingProfile
	const save = () => {
		if (canSave) void store.saveProfile(name, email)
	}

	return (
		<Screen scroll>
			<View className="gap-5 py-5">
				<Card className="gap-4">
					<View className="gap-1.5">
						<Text variant="heading" accessibilityRole="header">
							{t`Your profile`}
						</Text>
						<Text variant="muted">{t`Update your basic details below.`}</Text>
					</View>
					<TextField
						label={t`Name`}
						placeholder={t`Jane Doe`}
						value={name}
						onChangeText={edit(setName)}
						autoComplete="name"
						textContentType="name"
						autoCapitalize="words"
					/>
					<TextField
						label={t`Email`}
						placeholder="jane@example.com"
						value={email}
						onChangeText={edit(setEmail)}
						autoComplete="email"
						textContentType="emailAddress"
						keyboardType="email-address"
						autoCapitalize="none"
						autoCorrect={false}
					/>
					<TextField
						label={t`Phone number`}
						value={displayPhone(profile.phone ?? '')}
						editable={false}
						hint={t`Your phone number can't be changed here.`}
					/>
					<ErrorMessage error={error} />
					{didSaveProfile ? (
						<Text variant="muted" accessibilityLiveRegion="polite">
							{t`Profile saved.`}
						</Text>
					) : null}
					<Button loading={isSavingProfile} disabled={!canSave} onPress={save}>
						{t`Save changes`}
					</Button>
				</Card>

				<LanguagePicker />

				<Button variant="outline" onPress={() => void store.signOut()}>
					{t`Sign out`}
				</Button>
				{canChangeSite ? (
					<Button variant="ghost" onPress={() => void store.leaveSite()}>
						{t`Use a different site`}
					</Button>
				) : null}
			</View>
		</Screen>
	)
}

/** System default first, then every language this build ships, in its own name. */
export function LanguagePicker() {
	const { t } = useLingui()
	const store = useAppStore()
	const { languageOverride, availableLanguages } = useAppSnapshot()
	const options: Array<{ code: string | null; label: string }> = [
		{ code: null, label: t`System default` },
		...availableLanguages.map((code) => ({ code, label: localeLabel(code) })),
	]
	return (
		<Card className="gap-2">
			<Text
				variant="label"
				accessibilityRole="header"
				nativeID="language-label"
			>
				{t`Language`}
			</Text>
			<View
				accessibilityRole="radiogroup"
				accessibilityLabelledBy="language-label"
			>
				{options.map((option) => {
					const selected = option.code === languageOverride
					return (
						<Pressable
							key={option.code ?? 'system'}
							accessibilityRole="radio"
							accessibilityState={{ checked: selected }}
							accessibilityLabel={option.label}
							onPress={() => void store.setLanguageOverride(option.code)}
							className="flex-row items-center justify-between rounded-md px-1 py-3"
						>
							<Text>{option.label}</Text>
							<View
								className={`h-5 w-5 rounded-full border-2 ${selected ? 'border-primary bg-primary' : 'border-input'}`}
							/>
						</Pressable>
					)
				})}
			</View>
		</Card>
	)
}
