import { type OrderMessageCopy } from './types.ts'

export const ZH: OrderMessageCopy = {
	kinds: {
		receipt: {
			subject: '您在{r}的订单 {number}',
			heading: '感谢您的订购',
			lead: '我们已收到您的订单 {number}，详情如下。',
		},
		accepted: {
			subject: '您的订单 {number} 已被接受',
			heading: '您的订单已被接受',
			lead: '{r}已接受您的订单 {number}。',
		},
		ready: {
			subject: '您的订单 {number} 已备好',
			heading: '您的订单已备好',
			lead: '您的订单 {number} 已备好，请到{location}取餐。',
			leadDelivery: '您的订单 {number} 已备好，即将出发配送。',
		},
		out_for_delivery: {
			subject: '您的订单 {number} 正在配送',
			heading: '您的订单正在配送',
			lead: '您在{r}的订单 {number} 正在配送中。',
		},
		cancelled: {
			subject: '您的订单 {number} 已取消',
			heading: '您的订单已取消',
			lead: '{r}已取消您的订单 {number}。如有疑问，请联系餐厅。',
		},
		eta_changed: {
			subject: '您的订单 {number} 时间已更新',
			heading: '您的订单时间已更新',
			lead: '{r}更新了您的订单 {number} 的时间。',
		},
	},
	sms: {
		ready: '您在{r}的订单 {number} 已备好。',
		eta_changed: '您在{r}的订单 {number} 新时间：{time}。',
	},
	labels: {
		order: '订单',
		location: '门店',
		items: '菜品',
		subtotal: '小计',
		discount: '折扣',
		reward: '奖励',
		deliveryFee: '配送费',
		tip: '小费',
		tax: '税费',
		total: '合计',
		refunded: '已退款',
		pickupTime: '取餐时间',
		deliveryTime: '送达时间',
		asap: '尽快',
		readyAround: '约 {time} 备好',
		arriving: '{from} 至 {to} 送达',
		arrivingAround: '约 {time} 送达',
		viewOrder: '查看您的订单',
		footer: '这是一条关于您订单的服务消息。',
	},
}
