import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import { useState } from 'react'
import { GiftCardSheet } from './GiftCardSheet.tsx'
import { usePos } from '~/lib/store.ts'
import { Button } from '~/ui/primitives.tsx'

/**
 * The entry to selling, topping up and checking gift cards. Hidden for a till
 * that is not paired (nothing to talk to) or in the demo.
 */
export function GiftCardsButton({ money }: { money: (minor: number) => string }) {
	const { _ } = useLingui()
	const [open, setOpen] = useState(false)
	const paired = usePos((s) => Boolean(s.settings.deviceToken && s.settings.tenantApiUrl))
	if (!paired) return null
	return (
		<>
			<Button variant="outline" size="md" className="w-full" onClick={() => setOpen(true)}>
				<Icon name="credit-card" className="size-4" />
				{_(t`Gift cards`)}
			</Button>
			<GiftCardSheet open={open} onClose={() => setOpen(false)} money={money} />
		</>
	)
}
