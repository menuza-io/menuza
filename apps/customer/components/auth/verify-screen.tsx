import { useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import { View } from 'react-native'
import { useAppSnapshot, useAppStore } from '../../lib/app/use-app'
import {
	isCompleteOtp,
	OTP_LENGTH,
	otpDigits,
} from '../../lib/support/otp-code'
import { displayPhone } from '../../lib/support/phone-number'
import { Button, ErrorMessage, Text, TextField } from '../ui'
import { FormCard } from './form-card'

/** The one-time code step. */
export function VerifyScreen() {
	const { t } = useLingui()
	const store = useAppStore()
	const { isBusy, error, pendingPhone, didResendCode } = useAppSnapshot()
	const [code, setCode] = useState('')
	const phone = displayPhone(pendingPhone ?? '')
	const canVerify = isCompleteOtp(code) && !isBusy
	const verify = () => {
		if (canVerify) void store.verify(code)
	}
	return (
		<FormCard
			title={t`Enter your code`}
			subtitle={t`We sent a 6-digit code to ${phone}.`}
		>
			<TextField
				label={t`Verification code`}
				placeholder="123456"
				value={code}
				onChangeText={(value) => setCode(otpDigits(value))}
				maxLength={OTP_LENGTH}
				autoComplete="sms-otp"
				textContentType="oneTimeCode"
				keyboardType="number-pad"
				autoFocus
				onSubmitEditing={verify}
			/>
			<ErrorMessage error={error} />
			{didResendCode ? (
				<Text variant="muted" accessibilityLiveRegion="polite">
					{t`We sent you a new code.`}
				</Text>
			) : null}
			<Button loading={isBusy} disabled={!canVerify} onPress={verify}>
				{t`Verify`}
			</Button>
			{/* One code request at a time: resending or leaving mid-check would race it. */}
			<View className="flex-row flex-wrap gap-2">
				<Button
					variant="ghost"
					size="sm"
					disabled={isBusy}
					onPress={() => void store.resendCode()}
				>
					{t`Send a new code`}
				</Button>
				<Button
					variant="ghost"
					size="sm"
					disabled={isBusy}
					onPress={() => store.cancelVerification()}
				>
					{t`Use a different number`}
				</Button>
			</View>
		</FormCard>
	)
}
