'use client'

import { Trans } from '@lingui/macro'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { useState } from 'react'
import {
	MenuDuplicateDialog,
	type MenuDuplicateEntity,
} from './menu-duplicate-dialog.tsx'

export type { MenuDuplicateEntity }

export function MenuDuplicateTrigger({
	orgSlug,
	entity,
	variant = 'outline',
	size = 'default',
	showIcon = true,
}: {
	orgSlug: string
	entity: MenuDuplicateEntity
	variant?: 'outline' | 'ghost' | 'secondary'
	size?: 'default' | 'sm' | 'icon-sm'
	showIcon?: boolean
}) {
	const [open, setOpen] = useState(false)

	return (
		<>
			<Button
				type="button"
				variant={variant}
				size={size}
				onClick={() => setOpen(true)}
			>
				{showIcon ? <Icon name="copy" className="mr-2 size-4" /> : null}
				<Trans>Duplicate</Trans>
			</Button>
			<MenuDuplicateDialog
				orgSlug={orgSlug}
				open={open}
				onOpenChange={setOpen}
				entity={open ? entity : null}
			/>
		</>
	)
}
