import * as HoverCardPrimitive from "@radix-ui/react-hover-card";
import { cn } from "@renderer/lib/utils";
import { cloneElement, type ReactElement, type ReactNode } from "react";

function HoverCard({ openDelay = 350, closeDelay = 120, ...props }: HoverCardPrimitive.HoverCardProps) {
	return <HoverCardPrimitive.Root openDelay={openDelay} closeDelay={closeDelay} {...props} />;
}

/** Keeps the trigger API aligned with the other local Radix wrappers. */
function HoverCardTrigger({
	render,
	children,
}: {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any host element to merge children into
	render: ReactElement<any>;
	children?: ReactNode;
}) {
	return (
		<HoverCardPrimitive.Trigger asChild>
			{children === undefined ? render : cloneElement(render, undefined, children)}
		</HoverCardPrimitive.Trigger>
	);
}

function HoverCardContent({
	className,
	side = "right",
	sideOffset = 8,
	align = "start",
	collisionPadding = 8,
	...props
}: HoverCardPrimitive.HoverCardContentProps) {
	return (
		<HoverCardPrimitive.Portal>
			<HoverCardPrimitive.Content
				data-slot="hover-card-content"
				side={side}
				sideOffset={sideOffset}
				align={align}
				collisionPadding={collisionPadding}
				updatePositionStrategy="always"
				className={cn(
					"origin-[--radix-hover-card-content-transform-origin] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 motion-reduce:animate-none",
					"z-50 w-80 max-w-[calc(100vw-1rem)] rounded-control border border-border-subtle bg-surface p-2.5 text-text-primary shadow-lg outline-none duration-100",
					className,
				)}
				{...props}
			/>
		</HoverCardPrimitive.Portal>
	);
}

export { HoverCard, HoverCardContent, HoverCardTrigger };
