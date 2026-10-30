import { useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import { useAppSnapshot, useAppStore } from '../../lib/app/use-app'
import { Button, ErrorMessage, TextField } from '../ui'
import { FormCard } from './form-card'

/** Un-branded builds only: the customer types the site the app should load. */
export function ConnectSiteScreen() {
	const { t } = useLingui()
	const store = useAppStore()
	const { isConnecting, error } = useAppSnapshot()
	const [address, setAddress] = useState('')
	const canConnect = address.trim().length > 0 && !isConnecting
	const connect = () => {
		if (canConnect) void store.connect(address)
	}
	return (
		<FormCard
			title={t`Connect to your site`}
			subtitle={t`Enter your site address to load its branding.`}
		>
			<TextField
				label={t`Site address`}
				placeholder={t`acme or acme.example.com`}
				value={address}
				onChangeText={setAddress}
				autoCapitalize="none"
				autoCorrect={false}
				autoFocus
				keyboardType="url"
				textContentType="URL"
				returnKeyType="go"
				onSubmitEditing={connect}
			/>
			<ErrorMessage error={error} />
			<Button loading={isConnecting} disabled={!canConnect} onPress={connect}>
				{t`Connect`}
			</Button>
		</FormCard>
	)
}
