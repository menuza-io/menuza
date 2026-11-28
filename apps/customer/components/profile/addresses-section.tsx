import { useLingui } from '@lingui/react/macro'
import {
	SAVED_ADDRESS_LIMIT,
	orderSavedAddresses,
	type SavedAddress,
} from '@repo/common/saved-addresses'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, View } from 'react-native'
import { ApiError } from '../../lib/api/api-error'
import { CustomerAccountClient } from '../../lib/api/customer-account'
import { useAppSnapshot } from '../../lib/app/use-app'
import { Badge, Button, Card, Text, TextField } from '../ui'

/**
 * Profile, Addresses (#113): the signed-in guest's saved delivery addresses,
 * with add, rename, make default and remove. An address is added only from a
 * successful geocode: the region checks it against every store and signs the
 * quote the save names. Each address is checked again whenever it is used at
 * checkout, so one that is out of the delivery area today is still listed.
 */
export function AddressesSection() {
	const { t } = useLingui()
	const { session, language } = useAppSnapshot()
	const client = useMemo(
		() => (session ? new CustomerAccountClient(session) : null),
		[session],
	)
	const [addresses, setAddresses] = useState<SavedAddress[]>([])
	const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>(
		'loading',
	)
	const [editing, setEditing] = useState<string | null>(null)
	const [message, setMessage] = useState<string | null>(null)
	const limit = SAVED_ADDRESS_LIMIT

	const load = useCallback(() => {
		if (!client) return
		void client
			.listAddresses()
			.then((list) => {
				setAddresses(orderSavedAddresses(list.addresses))
				setStatus('ready')
			})
			.catch(() => setStatus('failed'))
	}, [client])
	useEffect(() => load(), [load])

	const run = async (action: () => Promise<unknown>) => {
		setMessage(null)
		try {
			await action()
			load()
			setEditing(null)
		} catch (error) {
			setMessage(
				error instanceof ApiError && error.code === 'address_limit_reached'
					? t`You have ${limit} saved addresses. Remove one to add another.`
					: t`We could not change your addresses. Try again.`,
			)
		}
	}

	return (
		<Card className="gap-3" testID="addresses-section">
			<Text variant="heading" accessibilityRole="header">
				{t`Your addresses`}
			</Text>
			{status === 'failed' ? (
				<View className="items-start gap-2">
					<Text variant="error">{t`Your addresses could not be loaded.`}</Text>
					<Button variant="outline" onPress={load}>
						{t`Try again`}
					</Button>
				</View>
			) : null}
			{status === 'ready' && addresses.length === 0 ? (
				<Text variant="muted">{t`No saved addresses yet. Add one for quicker delivery.`}</Text>
			) : null}
			{addresses.map((address) =>
				editing === address.id ? (
					<EditAddress
						key={address.id}
						address={address}
						onCancel={() => setEditing(null)}
						onSave={(patch) =>
							run(() => client!.updateAddress(address.id, patch))
						}
					/>
				) : (
					<View key={address.id} className="border-border gap-1 border-t pt-3">
						<View className="flex-row flex-wrap items-center gap-2">
							<Text variant="label">{address.label}</Text>
							{address.isDefault ? <Badge>{t`Default`}</Badge> : null}
						</View>
						<Text variant="muted">
							{[address.formatted, address.unit].filter(Boolean).join(' · ')}
						</Text>
						{address.notes ? (
							<Text variant="caption">{address.notes}</Text>
						) : null}
						<View className="flex-row flex-wrap gap-2 pt-1">
							<Button variant="outline" onPress={() => setEditing(address.id)}>
								{t`Edit`}
							</Button>
							{address.isDefault ? null : (
								<Button
									variant="outline"
									onPress={() =>
										void run(() =>
											client!.updateAddress(address.id, { isDefault: true }),
										)
									}
								>
									{t`Make default`}
								</Button>
							)}
							<Button
								variant="outline"
								onPress={() =>
									// The web page asks first too: a removed address is gone.
									Alert.alert(t`Remove this address?`, address.label, [
										{ text: t`Cancel`, style: 'cancel' },
										{
											text: t`Remove`,
											style: 'destructive',
											onPress: () =>
												void run(() => client!.deleteAddress(address.id)),
										},
									])
								}
							>
								{t`Remove`}
							</Button>
						</View>
					</View>
				),
			)}
			{message ? <Text variant="error">{message}</Text> : null}
			{status === 'ready' && addresses.length < SAVED_ADDRESS_LIMIT ? (
				<AddAddress
					locale={language.code}
					client={client}
					onSaved={() => {
						setMessage(null)
						load()
					}}
					onError={(error) =>
						setMessage(
							error instanceof ApiError &&
								error.code === 'address_limit_reached'
								? t`You have ${limit} saved addresses. Remove one to add another.`
								: t`We could not save this address. Try again.`,
						)
					}
				/>
			) : null}
		</Card>
	)
}

function EditAddress({
	address,
	onSave,
	onCancel,
}: {
	address: SavedAddress
	onSave: (patch: {
		label: string
		unit: string | null
		notes: string | null
	}) => void
	onCancel: () => void
}) {
	const { t } = useLingui()
	const [label, setLabel] = useState(address.label)
	const [unit, setUnit] = useState(address.unit ?? '')
	const [notes, setNotes] = useState(address.notes ?? '')
	return (
		<View className="border-border gap-3 border-t pt-3">
			<TextField
				label={t`Name`}
				value={label}
				onChangeText={setLabel}
				maxLength={40}
			/>
			<TextField
				label={t`Apt, suite or floor`}
				value={unit}
				onChangeText={setUnit}
				maxLength={50}
			/>
			<TextField
				label={t`Gate code or delivery note`}
				value={notes}
				onChangeText={setNotes}
				maxLength={280}
			/>
			<View className="flex-row gap-2">
				<Button
					disabled={label.trim() === ''}
					onPress={() =>
						onSave({
							label: label.trim(),
							unit: unit.trim() || null,
							notes: notes.trim() || null,
						})
					}
				>
					{t`Save changes`}
				</Button>
				<Button variant="outline" onPress={onCancel}>
					{t`Cancel`}
				</Button>
			</View>
		</View>
	)
}

function AddAddress({
	client,
	locale,
	onSaved,
	onError,
}: {
	client: CustomerAccountClient | null
	locale: string
	onSaved: () => void
	onError: (error: unknown) => void
}) {
	const { t } = useLingui()
	const [open, setOpen] = useState(false)
	const [address, setAddress] = useState('')
	const [unit, setUnit] = useState('')
	const [label, setLabel] = useState('')
	const [notes, setNotes] = useState('')
	const [busy, setBusy] = useState(false)
	const [problem, setProblem] = useState<string | null>(null)

	if (!open) {
		return (
			<Button variant="outline" onPress={() => setOpen(true)}>
				{t`Add an address`}
			</Button>
		)
	}
	const canSave = address.trim().length >= 3 && label.trim() !== '' && !busy
	const save = async () => {
		if (!client || !canSave) return
		setBusy(true)
		setProblem(null)
		try {
			const check = await client.checkAddress({
				address: address.trim(),
				unit: unit.trim() || undefined,
				locale,
			})
			if (check.status === 'not_found') {
				setProblem(t`We couldn't find that address.`)
				return
			}
			if (check.status !== 'deliverable') {
				setProblem(
					t`We don't deliver to this address yet, so it can't be saved.`,
				)
				return
			}
			await client.createAddress({
				locationId: check.locationId,
				quoteToken: check.quoteToken,
				label: label.trim(),
				...(notes.trim() ? { notes: notes.trim() } : {}),
			})
			setOpen(false)
			setAddress('')
			setUnit('')
			setLabel('')
			setNotes('')
			onSaved()
		} catch (error) {
			onError(error)
		} finally {
			setBusy(false)
		}
	}
	return (
		<View className="border-border gap-3 border-t pt-3">
			<TextField
				label={t`Street address`}
				value={address}
				onChangeText={setAddress}
				autoComplete="street-address"
				textContentType="fullStreetAddress"
			/>
			<TextField
				label={t`Apt, suite or floor`}
				value={unit}
				onChangeText={setUnit}
				maxLength={50}
			/>
			<TextField
				label={t`Name this address`}
				placeholder={t`Home, Work…`}
				value={label}
				onChangeText={setLabel}
				maxLength={40}
			/>
			<TextField
				label={t`Gate code or delivery note`}
				value={notes}
				onChangeText={setNotes}
				maxLength={280}
			/>
			{problem ? <Text variant="error">{problem}</Text> : null}
			<View className="flex-row gap-2">
				<Button loading={busy} disabled={!canSave} onPress={() => void save()}>
					{t`Save address`}
				</Button>
				<Button variant="outline" onPress={() => setOpen(false)}>
					{t`Cancel`}
				</Button>
			</View>
		</View>
	)
}
