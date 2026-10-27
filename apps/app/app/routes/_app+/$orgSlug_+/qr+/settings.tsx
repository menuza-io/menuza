import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { QR_PER_TABLE_LIMIT_MAX } from '@repo/common/qr-ordering'
import { Button } from '@repo/ui/button'
import { Card, CardContent } from '@repo/ui/card'
import { Field, FieldDescription, FieldLabel } from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import { Switch } from '@repo/ui/switch'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { toast } from 'sonner'
import { z } from 'zod'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { useQrClient } from '#app/hooks/use-qr-client.ts'
import { requireQrOrderingAccess } from '#app/utils/qr/access.server.ts'
import { qrSettingsSchema, type QrSettings } from '#app/utils/qr/qr-model.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requireQrOrderingAccess(request, params.orgSlug)
	return {
		orgSlug: access.organization.slug,
		canWrite: access.canWrite,
		online: access.features.online,
	}
}

export default function QrSettingsRoute() {
	const { _ } = useLingui()
	const { orgSlug, canWrite, online } = useLoaderData<typeof loader>()
	const request = useQrClient(orgSlug)
	const [settings, setSettings] = useState<QrSettings | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [saving, setSaving] = useState(false)

	useEffect(() => {
		let active = true
		request('/settings')
			.then((body) => {
				if (active) {
					setSettings(
						z.object({ settings: qrSettingsSchema }).parse(body).settings,
					)
				}
			})
			.catch(
				() => active && setError(_(msg`Unable to load settings. Try again.`)),
			)
		return () => {
			active = false
		}
	}, [request, _])

	const save = async (event: FormEvent) => {
		event.preventDefault()
		if (!settings) return
		setSaving(true)
		try {
			const body = await request('/settings', {
				method: 'PATCH',
				body: JSON.stringify(settings),
			})
			setSettings(z.object({ settings: qrSettingsSchema }).parse(body).settings)
			toast.success(_(msg`Settings saved`))
		} catch (cause) {
			toast.error(
				cause instanceof OperatorRequestError
					? cause.message
					: _(msg`That did not work. Try again.`),
			)
		} finally {
			setSaving(false)
		}
	}

	const toggle =
		(key: 'requireGuestName' | 'requireGuestPhone' | 'allowOnlineTabPay') =>
		(checked: boolean) =>
			setSettings((current) =>
				current ? { ...current, [key]: checked } : current,
			)

	return (
		<div className="space-y-8">
			<PageHeader
				title={_(msg`QR ordering settings`)}
				description={_(
					msg`What guests are asked for when they order at the table.`,
				)}
				actions={
					<Button
						variant="outline"
						render={<Link to={`/${orgSlug}/qr/tables`} />}
					>
						{_(msg`Tables`)}
					</Button>
				}
			/>
			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : !settings ? (
				<p role="status">{_(msg`Loading settings…`)}</p>
			) : (
				<form onSubmit={save} className="max-w-xl space-y-6">
					<Card>
						<CardContent className="space-y-5 pt-6">
							<Label className="flex min-h-11 items-start gap-3">
								<Switch
									checked={settings.requireGuestName}
									onCheckedChange={toggle('requireGuestName')}
									disabled={!canWrite}
								/>
								<span className="flex flex-col gap-1">
									{_(msg`Ask for the guest’s name`)}
									<span className="text-muted-foreground text-sm font-normal">
										{_(msg`Asked once, on the first order of a tab.`)}
									</span>
								</span>
							</Label>
							<Label className="flex min-h-11 items-start gap-3">
								<Switch
									checked={settings.requireGuestPhone}
									onCheckedChange={toggle('requireGuestPhone')}
									disabled={!canWrite}
								/>
								<span className="flex flex-col gap-1">
									{_(msg`Ask for the guest’s phone number`)}
									<span className="text-muted-foreground text-sm font-normal">
										{_(
											msg`Paying from the phone always asks for a name and phone number.`,
										)}
									</span>
								</span>
							</Label>
							{online ? (
								<Label className="flex min-h-11 items-start gap-3">
									<Switch
										checked={settings.allowOnlineTabPay}
										onCheckedChange={toggle('allowOnlineTabPay')}
										disabled={!canWrite}
									/>
									<span className="flex flex-col gap-1">
										{_(msg`Let guests pay the tab from their phone`)}
										<span className="text-muted-foreground text-sm font-normal">
											{_(
												msg`Needs online payments to be set up. Guests can always pay at the counter.`,
											)}
										</span>
									</span>
								</Label>
							) : null}
							<Field>
								<FieldLabel htmlFor="qr-limit">
									{_(msg`Orders per table per hour`)}
								</FieldLabel>
								<Input
									id="qr-limit"
									type="number"
									inputMode="numeric"
									min={1}
									max={QR_PER_TABLE_LIMIT_MAX}
									value={settings.perTableLimitPerHour}
									disabled={!canWrite}
									onChange={(event) =>
										setSettings({
											...settings,
											perTableLimitPerHour: Math.min(
												QR_PER_TABLE_LIMIT_MAX,
												Math.max(1, Number(event.target.value) || 1),
											),
										})
									}
									className="w-32"
								/>
								<FieldDescription>
									{_(msg`A safety limit against misuse of a table code.`)}
								</FieldDescription>
							</Field>
						</CardContent>
					</Card>
					{canWrite ? (
						<Button type="submit" disabled={saving}>
							{_(msg`Save`)}
						</Button>
					) : null}
				</form>
			)}
		</div>
	)
}
