CREATE TABLE `PrintDesign` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`createdById` text,
	`name` text NOT NULL,
	`product` text NOT NULL,
	`sizeKey` text NOT NULL,
	`style` text NOT NULL,
	`templateVersion` integer NOT NULL,
	`content` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`snapshot` text,
	`snapshotHash` text,
	`approvedAt` integer,
	`approvedById` text,
	`archivedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`approvedById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `PrintDesign_organizationId_updatedAt_idx` ON `PrintDesign` (`organizationId`,`updatedAt`);--> statement-breakpoint
CREATE TABLE `PrintOrder` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`placedById` text,
	`status` text DEFAULT 'quote' NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`itemsCents` integer NOT NULL,
	`shippingCents` integer NOT NULL,
	`taxCents` integer DEFAULT 0 NOT NULL,
	`totalCents` integer NOT NULL,
	`wholesaleCents` integer NOT NULL,
	`markupBp` integer NOT NULL,
	`quoteExpiresAt` integer NOT NULL,
	`scopeId` text,
	`recipientName` text NOT NULL,
	`recipientPhone` text NOT NULL,
	`addressLine1` text NOT NULL,
	`addressLine2` text,
	`city` text NOT NULL,
	`state` text NOT NULL,
	`postalCode` text NOT NULL,
	`country` text DEFAULT 'US' NOT NULL,
	`stripeCheckoutSessionId` text,
	`stripePaymentIntentId` text,
	`holdReason` text,
	`failureReason` text,
	`refundCents` integer DEFAULT 0 NOT NULL,
	`paidAt` integer,
	`cancelledAt` integer,
	`refundedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`placedById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `PrintOrder_organizationId_createdAt_idx` ON `PrintOrder` (`organizationId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `PrintOrder_status_updatedAt_idx` ON `PrintOrder` (`status`,`updatedAt`);--> statement-breakpoint
CREATE UNIQUE INDEX `PrintOrder_stripeCheckoutSessionId_key` ON `PrintOrder` (`stripeCheckoutSessionId`);--> statement-breakpoint
CREATE TABLE `PrintOrderItem` (
	`id` text PRIMARY KEY NOT NULL,
	`orderId` text NOT NULL,
	`vendorOrderId` text,
	`designId` text NOT NULL,
	`snapshotHash` text NOT NULL,
	`snapshot` text NOT NULL,
	`product` text NOT NULL,
	`sizeKey` text NOT NULL,
	`vendor` text NOT NULL,
	`vendorSku` text NOT NULL,
	`quantity` integer NOT NULL,
	`pieces` integer NOT NULL,
	`wholesaleCents` integer NOT NULL,
	`retailCents` integer NOT NULL,
	`pdfObjectKey` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`orderId`) REFERENCES `PrintOrder`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`vendorOrderId`) REFERENCES `PrintVendorOrder`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`designId`) REFERENCES `PrintDesign`(`id`) ON UPDATE cascade ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `PrintOrderItem_orderId_idx` ON `PrintOrderItem` (`orderId`);--> statement-breakpoint
CREATE TABLE `PrintRender` (
	`organizationId` text NOT NULL,
	`hash` text NOT NULL,
	`objectKey` text NOT NULL,
	`byteLength` integer DEFAULT 0 NOT NULL,
	`countsTowardLimit` integer DEFAULT true NOT NULL,
	`createdAt` integer NOT NULL,
	PRIMARY KEY(`organizationId`, `hash`),
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `PrintRender_organizationId_createdAt_idx` ON `PrintRender` (`organizationId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `PrintSettings` (
	`id` text PRIMARY KEY NOT NULL,
	`markupBp` integer DEFAULT 3000 NOT NULL,
	`driftHoldBp` integer DEFAULT 1000 NOT NULL,
	`quoteTtlMinutes` integer DEFAULT 30 NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `PrintVendorEvent` (
	`id` text PRIMARY KEY NOT NULL,
	`vendor` text NOT NULL,
	`receivedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `PrintVendorOrder` (
	`id` text PRIMARY KEY NOT NULL,
	`orderId` text NOT NULL,
	`vendor` text NOT NULL,
	`vendorOrderId` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`shippingMethod` text,
	`wholesaleItemsCents` integer NOT NULL,
	`wholesaleShippingCents` integer NOT NULL,
	`carrier` text,
	`trackingNumber` text,
	`trackingUrl` text,
	`error` text,
	`submittedAt` integer,
	`shippedAt` integer,
	`deliveredAt` integer,
	`lastEventAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`orderId`) REFERENCES `PrintOrder`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `PrintVendorOrder_orderId_idx` ON `PrintVendorOrder` (`orderId`);--> statement-breakpoint
CREATE UNIQUE INDEX `PrintVendorOrder_vendor_vendorOrderId_key` ON `PrintVendorOrder` (`vendor`,`vendorOrderId`);--> statement-breakpoint
CREATE TABLE `PrintVendorProduct` (
	`id` text PRIMARY KEY NOT NULL,
	`product` text NOT NULL,
	`sizeKey` text NOT NULL,
	`vendor` text NOT NULL,
	`vendorSku` text NOT NULL,
	`bleedMm` integer DEFAULT 3 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `PrintVendorProduct_product_size_active_key` ON `PrintVendorProduct` (`product`,`sizeKey`) WHERE "PrintVendorProduct"."active" = 1;