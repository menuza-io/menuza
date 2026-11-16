import { Trans, useLingui } from '@lingui/react/macro'
import {
	GIFT_CARD_DESIGN_KEYS,
	GIFT_CARD_PERMISSIONS,
	type GiftCardDesignKey,
	type GiftCardSettings,
} from '@repo/common/gift-cards'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Frame } from '@repo/ui/frame'
import { useState } from 'react'
import { Form, useActionData, useLoaderData, useNavigation, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { TextField } from '#app/components/staff/controls.tsx'
import { requireGiftCardAccess } from '#app/utils/gift-cards/access.server.ts'
import {
	loadGiftCardSettings,
	saveGiftCardSettings,
} from '#app/utils/gift-cards/settings.server.ts'
import { currencyExponent, minorToMajorText, parseMoneyToMinor, parseWholeNumber } from '#app/utils/money-input.ts'

const DESIGN_LABELS: Record<GiftCardDesignKey, string> = {
	classic: 'Classic',
	birthday: 'Happy birthday',
	holidays: 'Happy holidays',
	thank_you: 'Thank you',
	eid: 'Eid',
	ramadan: 'Ramadan',
	national_day: 'National Day',
	custom: 'Your own image',
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requireGiftCardAccess(request, params.orgSlug, {
		requireAll: [GIFT_CARD_PERMISSIONS.UPDATE_GIFT_CARD],
	})
	return {
		currency: access.currency,
		settings: await loadGiftCardSettings(access.organizationId),
	}
}

/** Saves the settings: presets, bounds, expiry, designs and purchase limits. Never a card or a guest. */
export async function action({ request, params }: ActionFunctionArgs) {
	const access = await requireGiftCardAccess(request, params.orgSlug, {
		requireAll: [GIFT_CARD_PERMISSIONS.UPDATE_GIFT_CARD],
	})
	if (access.impersonated) throw new Response('Forbidden', { status: 403 })
	const form = await request.formData()
	const raw = form.get('settings')
	let parsed: unknown = null
	try {
		parsed = typeof raw === 'string' ? JSON.parse(raw) : null
	} catch {
		parsed = null
	}
	const result = await saveGiftCardSettings({
		organizationId: access.organizationId,
		userId: access.userId,
		settings: parsed,
	})
	return result.ok
		? { ok: true as const }
		: { ok: false as const, error: result.error }
}

const ERROR_CODES = new Set([
	'invalid_settings',
	'min_above_max',
	'preset_out_of_range',
	'duplicate_preset',
	'no_design',
	'custom_design_needs_image',
	'purchase_above_card',
])

export default function GiftCardSettingsRoute() {
	const { currency, settings: initial } = useLoaderData<typeof loader>()
	const { t } = useLingui()
	const result = useActionData<typeof action>()
	const navigation = useNavigation()
	const major = (minor: number) => minorToMajorText(minor, currency)
	const [presets, setPresets] = useState(initial.presetsMinor.map(major).join(', '))
	const [min, setMin] = useState(major(initial.minAmountMinor))
	const [max, setMax] = useState(major(initial.maxAmountMinor))
	const [custom, setCustom] = useState(initial.allowCustomAmount)
	const [expiry, setExpiry] = useState(initial.expiryMonths ? String(initial.expiryMonths) : '')
	const [enabled, setEnabled] = useState<Set<GiftCardDesignKey>>(
		new Set(initial.designs.filter((d) => d.enabled).map((d) => d.key)),
	)
	const [defaultDesign, setDefaultDesign] = useState<GiftCardDesignKey>(initial.defaultDesign)
	const [imageKey, setImageKey] = useState(
		initial.designs.find((d) => d.key === 'custom')?.imageKey ?? '',
	)
	const [limits, setLimits] = useState({ ...initial.limits })
	const [formError, setFormError] = useState<string | null>(null)

	function build(): GiftCardSettings | null {
		const presetValues = presets
			.split(/[,\n]/)
			.map((value) => value.trim())
			.filter(Boolean)
			.map((value) => parseMoneyToMinor(value, { currency, min: 1 }))
		if (presetValues.some((value) => value === null)) return null
		const minMinor = parseMoneyToMinor(min, { currency, min: 1 })
		const maxMinor = parseMoneyToMinor(max, { currency, min: 1 })
		if (minMinor === null || maxMinor === null) return null
		const months = expiry.trim() ? parseWholeNumber(expiry, { min: 1, max: 120 }) : null
		if (expiry.trim() && months === null) return null
		return {
			presetsMinor: presetValues as number[],
			minAmountMinor: minMinor,
			maxAmountMinor: maxMinor,
			allowCustomAmount: custom,
			expiryMonths: months,
			designs: GIFT_CARD_DESIGN_KEYS.map((key) => ({
				key,
				enabled: enabled.has(key),
				imageKey: key === 'custom' ? imageKey.trim() || null : null,
			})),
			defaultDesign,
			defaultLocationId: initial.defaultLocationId,
			limits,
		}
	}

	const limitField = (
		key: keyof typeof limits,
		label: string,
		hint?: string,
	) => (
		<TextField
			label={label}
			hint={hint}
			inputMode="numeric"
			value={String(limits[key])}
			onChange={(event) => {
				const value = parseWholeNumber(event.target.value, { min: 1, max: 100_000 })
				if (value !== null) setLimits((current) => ({ ...current, [key]: value }))
			}}
		/>
	)
	void currencyExponent

	return (
		<Form
			method="post"
			className="grid max-w-2xl gap-6"
			onSubmit={(event) => {
				const built = build()
				if (!built) {
					event.preventDefault()
					setFormError(t`Check the amounts: each must be a number above zero.`)
					return
				}
				setFormError(null)
				const field = event.currentTarget.elements.namedItem('settings') as HTMLInputElement
				field.value = JSON.stringify(built)
			}}
		>
			<input type="hidden" name="settings" defaultValue="" />

			<Frame className="grid gap-4 p-4">
				<h3 className="font-medium"><Trans>Amounts</Trans></h3>
				<TextField
					label={t`Preset amounts`}
					hint={t`Separate with commas, for example 25, 50, 100.`}
					value={presets}
					onChange={(event) => setPresets(event.target.value)}
				/>
				<div className="grid gap-4 sm:grid-cols-2">
					<TextField label={t`Smallest card`} value={min} onChange={(e) => setMin(e.target.value)} />
					<TextField label={t`Largest card`} value={max} onChange={(e) => setMax(e.target.value)} />
				</div>
				<label className="flex items-center gap-2 text-sm">
					<input type="checkbox" checked={custom} onChange={(e) => setCustom(e.target.checked)} />
					<Trans>Let guests type their own amount</Trans>
				</label>
				<TextField
					label={t`Expires after (months)`}
					hint={t`Leave empty for cards that never expire (the default).`}
					inputMode="numeric"
					value={expiry}
					onChange={(event) => setExpiry(event.target.value)}
				/>
			</Frame>

			<Frame className="grid gap-3 p-4">
				<h3 className="font-medium"><Trans>Designs guests can choose</Trans></h3>
				<div className="grid gap-2 sm:grid-cols-2">
					{GIFT_CARD_DESIGN_KEYS.map((key) => (
						<label key={key} className="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								checked={enabled.has(key)}
								onChange={(event) => {
									const next = new Set(enabled)
									if (event.target.checked) next.add(key)
									else next.delete(key)
									setEnabled(next)
								}}
							/>
							{DESIGN_LABELS[key]}
						</label>
					))}
				</div>
				{enabled.has('custom') ? (
					<TextField
						label={t`Image from your media library`}
						hint={t`The path of a PNG, JPEG or WebP image up to 2 MB.`}
						value={imageKey}
						onChange={(event) => setImageKey(event.target.value)}
					/>
				) : null}
				<label className="grid gap-1 text-sm">
					<span><Trans>Default design</Trans></span>
					<select
						className="border-input h-9 rounded-md border bg-transparent px-2"
						value={defaultDesign}
						onChange={(event) => setDefaultDesign(event.target.value as GiftCardDesignKey)}
					>
						{GIFT_CARD_DESIGN_KEYS.filter((key) => enabled.has(key)).map((key) => (
							<option key={key} value={key}>
								{DESIGN_LABELS[key]}
							</option>
						))}
					</select>
				</label>
			</Frame>

			<Frame className="grid gap-4 p-4">
				<h3 className="font-medium"><Trans>Protect online sales</Trans></h3>
				<p className="text-muted-foreground text-sm">
					<Trans>
						These limits are checked before a guest pays, and a refusal never says which limit was hit. Cards sold at the
						till and top-ups are never limited or delayed.
					</Trans>
				</p>
				<div className="grid gap-4 sm:grid-cols-2">
					{limitField('maxCardMajor', t`Largest card`, t`In whole units of your currency.`)}
					{limitField('maxPerPurchaseMajor', t`Most in one purchase`)}
					{limitField('maxPurchasesPer24h', t`Purchases per payment card, email and device in 24 hours`)}
					{limitField('holdThresholdMajor', t`Hold a first-time buyer's card at or above`)}
					{limitField('holdHours', t`Hold for (hours)`)}
					{limitField('burstPerHour', t`Alert managers at this many purchases from one device in an hour`)}
				</div>
			</Frame>

			{formError || (result && !result.ok) ? (
				<Alert variant="destructive">
					<AlertDescription>
						{formError ??
							(result && !result.ok && ERROR_CODES.has(result.error)
								? t`Those settings do not fit together. Check the amounts, the designs and the limits.`
								: t`The settings could not be saved.`)}
					</AlertDescription>
				</Alert>
			) : null}
			{result?.ok ? (
				<p role="status" className="text-sm"><Trans>Saved.</Trans></p>
			) : null}
			<div>
				<Button type="submit" disabled={navigation.state !== 'idle'}>
					<Trans>Save settings</Trans>
				</Button>
			</div>
		</Form>
	)
}
