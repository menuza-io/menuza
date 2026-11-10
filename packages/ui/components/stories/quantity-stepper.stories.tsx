import { type Meta, type StoryObj } from '@storybook/react'
import * as React from 'react'
import { QuantityStepper } from '../ui/quantity-stepper'

const meta = {
	title: 'Components/QuantityStepper',
	component: QuantityStepper,

	tags: ['autodocs'],
} satisfies Meta<typeof QuantityStepper>

export default meta
type Story = StoryObj<typeof meta>

function Controlled(
	props: Partial<React.ComponentProps<typeof QuantityStepper>>,
) {
	const [value, setValue] = React.useState<number | null>(2)
	return (
		<QuantityStepper
			decrementLabel="Less"
			incrementLabel="More"
			aria-label="Amount"
			{...props}
			value={value}
			onValueChange={setValue}
		/>
	)
}

export const Default: Story = {
	args: {
		value: 2,
		onValueChange: () => {},
		decrementLabel: 'Less',
		incrementLabel: 'More',
	},
	render: () => <Controlled />,
}

export const WithFractions: Story = {
	args: {
		value: 2,
		onValueChange: () => {},
		decrementLabel: 'Less',
		incrementLabel: 'More',
	},
	render: () => <Controlled fractions />,
}

export const RightToLeft: Story = {
	args: {
		value: 2,
		onValueChange: () => {},
		decrementLabel: 'Less',
		incrementLabel: 'More',
	},
	render: () => (
		<div dir="rtl">
			<Controlled fractions />
		</div>
	),
}
