import { useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import { useAppSnapshot, useAppStore } from '../../lib/app/use-app'
import { isValidPhone } from '../../lib/support/phone-number'
import { Button, ErrorMessage, TextField } from '../ui'
import { FormCard } from './form-card'

/** Phone sign-in, the same flow as Sites `/login`, straight to the regional tenant-api. */
export function LoginScreen() {
	const { t } = useLingui()
	const store = useAppStore()
	const { isBusy, error } = useAppSnapshot()
	const [phone, setPhone] = useState('')
	const canSend = isValidPhone(phone) && !isBusy
	const send = () => {
		if (canSend) void store.sendCode(phone)
	}
	return (
		<FormCard
			title={t`Sign in`}
			subtitle={t`Enter your phone number. We'll send a verification code.`}
		>
			<TextField
				label={t`Phone number`}
				placeholder={t`+1 555 000 0000`}
				value={phone}
				onChangeText={setPhone}
				autoComplete="tel"
				textContentType="telephoneNumber"
				keyboardType="phone-pad"
				autoFocus
				returnKeyType="send"
				onSubmitEditing={send}
			/>
			<ErrorMessage error={error} />
			<Button loading={isBusy} disabled={!canSend} onPress={send}>
				{t`Send code`}
			</Button>
		</FormCard>
	)
}
