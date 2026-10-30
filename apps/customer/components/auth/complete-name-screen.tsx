import { useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import { useAppSnapshot, useAppStore } from '../../lib/app/use-app'
import { Button, ErrorMessage, TextField } from '../ui'
import { FormCard } from './form-card'

/** tenant-api accepts a name of two characters or more. */
export function isAcceptableName(name: string): boolean {
	return Array.from(name.trim()).length >= 2
}

/** New customers choose the name the business greets them by. */
export function CompleteNameScreen() {
	const { t } = useLingui()
	const store = useAppStore()
	const { isBusy, error } = useAppSnapshot()
	const [name, setName] = useState('')
	const canSave = isAcceptableName(name) && !isBusy
	const save = () => {
		if (canSave) void store.completeName(name)
	}
	return (
		<FormCard title={t`Your name`} subtitle={t`Tell us what to call you.`}>
			<TextField
				label={t`Name`}
				placeholder={t`Jane Doe`}
				value={name}
				onChangeText={setName}
				autoComplete="name"
				textContentType="name"
				autoCapitalize="words"
				autoFocus
				returnKeyType="done"
				onSubmitEditing={save}
			/>
			<ErrorMessage error={error} />
			<Button loading={isBusy} disabled={!canSave} onPress={save}>
				{t`Continue`}
			</Button>
		</FormCard>
	)
}
