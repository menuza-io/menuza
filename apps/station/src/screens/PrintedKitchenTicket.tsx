import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { createPortal } from 'react-dom'
import { orderHasAlcohol } from '~/lib/alcohol.ts'
import { type PosOrder } from '~/lib/db.ts'
import { menuText } from '~/lib/menu-text.ts'
import { usePos } from '~/lib/store.ts'
import { fieldOf, useTickets, type KitchenTicketPlan } from '~/lib/tickets.ts'
import { cn } from '~/ui/primitives.tsx'

/**
 * The kitchen station ticket for an order rung up at the till (#363), shown
 * only by `window.print()`. Which fields print follows the location's ticket
 * settings; a cancelled order prints a cancellation slip and an adjusted one
 * only its changes, when the owner asked for it.
 */
export function PrintedKitchenTicket({
	order,
	plan,
}: {
	order: PosOrder
	plan: KitchenTicketPlan
}) {
	const { _, i18n } = useLingui()
	const tickets = useTickets()
	const items = usePos((state) => state.recordItems)
	const checkId = orderHasAlcohol(order.lines, items)
	const f = (key: string) => fieldOf(tickets, 'kitchen', key)
	const when = new Date(plan.at).toLocaleString(i18n.locale)
	const table = order.tableLabel ? <bdi>{order.tableLabel}</bdi> : null
	return createPortal(
		<div
			id="receipt"
			className="hidden print:block"
			aria-hidden
			data-kitchen-ticket=""
			data-ticket-kind={plan.kind}
			data-order-type={order.orderType}
		>
			{f('ticketTitle').show ? (
				<div className={cn('text-center font-semibold', f('ticketTitle').cls)}>
					{plan.kind === 'cancelled' ? (
						<Trans>CANCELLED</Trans>
					) : plan.kind === 'changes' ? (
						<Trans>Kitchen ticket: changes only</Trans>
					) : (
						<Trans>Kitchen ticket</Trans>
					)}
				</div>
			) : null}
			{f('dateTime').show ? (
				<div className={cn('text-center', f('dateTime').cls)}>{when}</div>
			) : null}
			{f('orderNumber').show ? (
				<div
					className={cn(
						'my-1.5 text-center text-base font-semibold',
						f('orderNumber').cls,
					)}
				>
					#{order.number}
				</div>
			) : null}
			{f('orderType').show ? (
				<div className={cn('text-center', f('orderType').cls)}>
					{order.orderType === 'dine_in' ? (
						<>
							{_(t`Dine in`)}
							{table ? (
								<>
									{' · '}
									<Trans>Table {table}</Trans>
								</>
							) : null}
						</>
					) : order.orderType === 'drive_through' ? (
						_(t`Drive-through`)
					) : (
						<>
							{_(t`Takeaway`)}
							{order.customerName ? (
								<>
									{' · '}
									<bdi>{order.customerName}</bdi>
								</>
							) : null}
						</>
					)}
				</div>
			) : null}
			{checkId ? (
				<div
					className="my-1 border-2 px-1.5 text-center font-semibold"
					data-check-id
				>
					<Trans>Check ID</Trans>
				</div>
			) : null}
			<hr className="my-1.5 border-dashed border-black" />
			{plan.lines.map((line) => (
				<div
					key={line.id}
					data-served={line.servedAt ? '' : undefined}
					className={cn(
						'mb-1',
						f('items').cls,
						// Dishes already served are struck through when the owner asks.
						tickets.strikeCompleted && line.servedAt && 'line-through',
					)}
				>
					<div>
						{line.quantity}× {menuText(line.kitchenName || line.name)}
						{line.variantLabel ? ` · ${line.variantLabel}` : ''}
					</div>
					{(f('itemOptions').show ? line.options : []).map((option) => (
						<div
							key={option.groupId + option.optionId}
							className={cn('ps-3', f('itemOptions').cls)}
						>
							+ {option.quantity > 1 ? `${option.quantity} × ` : ''}
							{menuText(option.kitchenName || option.optionName)}
						</div>
					))}
					{line.instructions && f('itemNotes').show ? (
						<div className={cn('ps-3', f('itemNotes').cls)}>
							<bdi>{line.instructions}</bdi>
						</div>
					) : null}
				</div>
			))}
			{plan.kind === 'changes' && plan.removed.length > 0 ? (
				<>
					<hr className="my-1.5 border-dashed border-black" />
					<div className="font-semibold">
						<Trans>Taken off</Trans>
					</div>
					{plan.removed.map((removed) => (
						<div key={removed.id} className="line-through">
							{removed.quantity}× {menuText(removed.name)}
						</div>
					))}
				</>
			) : null}
		</div>,
		document.body,
	)
}
