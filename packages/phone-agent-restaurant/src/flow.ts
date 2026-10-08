import { type FlowGraph, flowEdge, flowNode } from '@repo/phone-agent'

/**
 * The phone menu every restaurant starts with. `{business}` in a message is
 * replaced with the restaurant's name when the call plays it.
 */
export function createRestaurantFlowGraph(): FlowGraph {
	return {
		nodes: [
			flowNode('start', 'start', 0, 340, { label: 'Call comes in' }),
			flowNode('hours', 'hours_check', 380, 300, {
				label: 'Open right now?',
			}),
			flowNode('main_menu', 'keypad_menu', 760, 40, {
				label: 'Main menu',
				message:
					'Thanks for calling {business}. To place an order with our AI assistant, press 1. To get a text with our online ordering link, press 2. To speak with our team, press 3.',
				repeat: 2,
				options: [
					{
						key: '1',
						label: 'Order with the AI assistant',
						keywords: ['order', 'food', 'pickup', 'delivery', 'menu'],
					},
					{
						key: '2',
						label: 'Text me the ordering link',
						keywords: ['text', 'link', 'website', 'online'],
					},
					{
						key: '3',
						label: 'Speak with our team',
						keywords: ['person', 'staff', 'manager', 'someone', 'human'],
					},
				],
			}),
			flowNode('closed_menu', 'keypad_menu', 760, 560, {
				label: 'Closed menu',
				message:
					"Thanks for calling {business}. We're closed right now. To get a text with our online ordering link, press 1. To leave a message, press 2.",
				repeat: 2,
				options: [
					{
						key: '1',
						label: 'Text me the ordering link',
						keywords: ['text', 'link', 'website', 'online', 'order'],
					},
					{
						key: '2',
						label: 'Leave a message',
						keywords: ['message', 'voicemail', 'callback'],
					},
				],
			}),
			flowNode('ai', 'ai_agent', 1160, 0, { label: 'AI assistant' }),
			flowNode('text_link', 'text_link', 1160, 440, {
				label: 'Text the ordering link',
				message: 'We just sent you a text with a link to order online.',
			}),
			flowNode('staff', 'transfer', 1160, 200, {
				label: 'Transfer to the team',
				message: 'Please hold while we connect you.',
			}),
			flowNode('voicemail', 'voicemail', 1560, 680, {
				label: 'Take a message',
				message:
					'Please leave your name, number, and message after this, then press pound or hang up.',
			}),
			flowNode('goodbye', 'hang_up', 1960, 560, {
				label: 'Goodbye',
				message: 'Thanks for calling {business}. Goodbye!',
			}),
		],
		edges: [
			flowEdge('start', 'hours'),
			flowEdge('hours', 'main_menu', 'open'),
			flowEdge('hours', 'closed_menu', 'closed'),
			flowEdge('main_menu', 'ai', 'key_1'),
			flowEdge('main_menu', 'text_link', 'key_2'),
			flowEdge('main_menu', 'staff', 'key_3'),
			flowEdge('main_menu', 'staff', 'no_input'),
			flowEdge('closed_menu', 'text_link', 'key_1'),
			flowEdge('closed_menu', 'voicemail', 'key_2'),
			flowEdge('closed_menu', 'voicemail', 'no_input'),
			flowEdge('text_link', 'goodbye'),
			flowEdge('staff', 'voicemail', 'no_answer'),
			flowEdge('voicemail', 'goodbye'),
		],
	}
}
