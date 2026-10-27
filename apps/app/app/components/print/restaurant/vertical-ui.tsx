import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { isTableTarget } from '@repo/common/print-shop-restaurant'
import { Checkbox } from '@repo/ui/checkbox'
import { Field, FieldLabel, FieldSet } from '@repo/ui/field'
import { Label } from '@repo/ui/label'
import { Switch } from '@repo/ui/switch'
import { useState } from 'react'
import { Link } from 'react-router'
import {
	type PrintQrTargetFieldsProps,
	type PrintShopUiVertical,
} from '../vertical-ui-types.ts'

/**
 * The restaurant print vertical's UI: table QR cards and tents, codes that
 * open ordering at a table, order-ahead or booking, menu dishes as featured
 * items and locations as scopes. Server side:
 * `utils/print/restaurant/vertical.server.ts`.
 */

type TableChoice = { id: string; label: string; locationId: string }

function TableFields({ target, data }: PrintQrTargetFieldsProps) {
	const { _ } = useLingui()
	const editorData = data as {
		tables?: TableChoice[]
		setupHref?: string
	} | null
	const tables = editorData?.tables ?? []
	const chosen = isTableTarget(target) ? target.tableIds : ['all']
	const [allTables, setAllTables] = useState(chosen.includes('all'))
	if (tables.length === 0) {
		return (
			<div className="space-y-2">
				<p className="text-muted-foreground text-sm">
					{_(
						msg`You have no QR tables yet. Add them in Settings, then come back: each table gets its own card.`,
					)}
				</p>
				{editorData?.setupHref ? (
					<Link
						to={editorData.setupHref}
						className="text-primary inline-flex min-h-11 items-center text-sm font-medium underline-offset-4 hover:underline"
					>
						{_(msg`Set up QR tables`)}
					</Link>
				) : null}
			</div>
		)
	}
	return (
		<FieldSet>
			<Label className="flex min-h-11 items-center gap-3">
				<Switch
					name="allTables"
					checked={allTables}
					onCheckedChange={setAllTables}
				/>
				{_(msg`Every table (new tables are added when you approve)`)}
			</Label>
			{!allTables ? (
				<div className="grid max-h-80 gap-2 overflow-y-auto sm:grid-cols-3">
					{tables.map((table) => (
						<Label key={table.id} className="flex min-h-11 items-center gap-3">
							<Checkbox
								name="tableIds"
								value={table.id}
								defaultChecked={chosen.includes(table.id)}
							/>
							<bdi className="wrap-anywhere">{table.label}</bdi>
						</Label>
					))}
				</div>
			) : null}
		</FieldSet>
	)
}

/** Order-ahead and booking codes point at one location. */
function LocationFields({ target, scopes }: PrintQrTargetFieldsProps) {
	const { _ } = useLingui()
	const current =
		typeof target.locationId === 'string'
			? target.locationId
			: (scopes[0]?.id ?? '')
	if (scopes.length > 1) {
		return (
			<Field>
				<FieldLabel htmlFor="qr-location">{_(msg`Location`)}</FieldLabel>
				<select
					id="qr-location"
					name="qrLocationId"
					defaultValue={current}
					className="border-input bg-background h-11 rounded-md border px-3 text-sm"
				>
					{scopes.map((scope) => (
						<option key={scope.id} value={scope.id}>
							{scope.name}
						</option>
					))}
				</select>
			</Field>
		)
	}
	return scopes[0] ? (
		<input type="hidden" name="qrLocationId" value={scopes[0].id} />
	) : null
}

export const restaurantPrintUi: PrintShopUiVertical = {
	products: {
		table_card: {
			name: msg`Table QR cards`,
			description: msg`One card per table, so guests order and pay from their phone.`,
		},
		table_tent: {
			name: msg`Table tent`,
			description: msg`A folded card that stands on the table. Print it yourself.`,
		},
		poster: {
			name: msg`Poster`,
			description: msg`A large print for windows and walls, with featured dishes.`,
		},
	},
	qrTargets: {
		table: {
			label: msg`Order at the table`,
			empty: msg`Choose at least one table for the cards.`,
			hidden: msg`Table cards carry each table's ordering code, so only people who can edit the menu can see the proof and download it.`,
			Fields: TableFields,
		},
		menu: { label: msg`Order ahead (menu)`, Fields: LocationFields },
		reservations: { label: msg`Book a table`, Fields: LocationFields },
	},
	featuredItems: {
		title: msg`Featured dishes`,
		description: msg`Pick up to 4 dishes. Names, prices and photos come from your menu.`,
		empty: msg`Your menu has no dishes to feature yet.`,
	},
	scope: { label: msg`Location`, source: msg`Address and prices from` },
	copy: {
		intro: msg`Design branded table cards, posters and flyers, and download a print-ready PDF for free.`,
		introWithShipping: msg`Design branded table cards, posters and flyers. Download a print-ready PDF for free, or have them printed and shipped.`,
		empty: msg`Start with table QR cards so guests can order from their phone.`,
		nothingToShip: msg`Approve a table card, poster or flyer first. Only approved prints in a shippable size can be ordered.`,
	},
}
