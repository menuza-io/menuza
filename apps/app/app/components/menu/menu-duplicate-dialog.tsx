import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Label } from '@repo/ui/label'
import { useEffect, useState } from 'react'
import { useFetcher, useNavigate } from 'react-router'

export type MenuDuplicateEntity =
	| { entityType: 'menu'; entityId: string; copyCategories?: boolean }
	| { entityType: 'category'; entityId: string }
	| { entityType: 'item'; entityId: string; copyModifierGroups?: boolean }
	| { entityType: 'modifier_group'; entityId: string }

type DuplicateEntity = MenuDuplicateEntity

export function MenuDuplicateDialog({
	orgSlug,
	open,
	onOpenChange,
	entity,
}: {
	orgSlug: string
	open: boolean
	onOpenChange: (open: boolean) => void
	entity: DuplicateEntity | null
}) {
	const { _ } = useLingui()
	const navigate = useNavigate()
	const fetcher = useFetcher<{ ok?: boolean; id?: string; error?: string }>()
	const [copyCategories, setCopyCategories] = useState(false)
	const [copyModifierGroups, setCopyModifierGroups] = useState(false)

	const pathFor = (type: DuplicateEntity['entityType'], id: string) => {
		const base = `/${orgSlug}/menu`
		switch (type) {
			case 'menu':
				return `${base}/menus/${id}`
			case 'category':
				return `${base}/categories/${id}`
			case 'item':
				return `${base}/items/${id}`
			case 'modifier_group':
				return `${base}/modifiers/${id}`
		}
	}

	const duplicate = () => {
		if (!entity) return
		const body =
			entity.entityType === 'menu'
				? { ...entity, copyCategories }
				: entity.entityType === 'item'
					? { ...entity, copyModifierGroups }
					: entity
		void fetcher.submit(JSON.stringify(body), {
			method: 'POST',
			action: `/${orgSlug}/menu/duplicate`,
			encType: 'application/json',
		})
	}

	useEffect(() => {
		if (fetcher.data?.ok && fetcher.data.id && entity) {
			onOpenChange(false)
			void navigate(pathFor(entity.entityType, fetcher.data.id))
		}
	}, [entity, fetcher.data, navigate, onOpenChange])

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						<Trans>Duplicate</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							The copy starts unavailable and is named “(copy)”. POS links and
							location overrides are not copied.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3">
				{entity?.entityType === 'menu' ? (
					<div className="flex items-center gap-2 rounded-lg border p-3">
						<Checkbox
							id="copy-categories"
							checked={copyCategories}
							onCheckedChange={(value) => setCopyCategories(value === true)}
						/>
						<Label htmlFor="copy-categories">
							<Trans>Copy categories as new categories</Trans>
						</Label>
					</div>
				) : null}

				{entity?.entityType === 'item' ? (
					<div className="flex items-center gap-2 rounded-lg border p-3">
						<Checkbox
							id="copy-modifier-groups"
							checked={copyModifierGroups}
							onCheckedChange={(value) => setCopyModifierGroups(value === true)}
						/>
						<Label htmlFor="copy-modifier-groups">
							<Trans>Copy modifier groups as new groups</Trans>
						</Label>
					</div>
				) : null}
				</div>

				{fetcher.data?.error ? (
					<p className="text-destructive text-sm">{fetcher.data.error}</p>
				) : null}

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						onClick={duplicate}
						disabled={fetcher.state !== 'idle'}
						aria-label={_(t`Confirm duplicate`)}
					>
						<Trans>Duplicate</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
