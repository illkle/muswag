import { Menu as MenuPrimitive } from "@base-ui/react/menu";

import { cn } from "#/lib/utils";

function Menu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="menu" {...props} />;
}

function MenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="menu-trigger" {...props} />;
}

function MenuContent({
  className,
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  ...props
}: MenuPrimitive.Popup.Props & Pick<MenuPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner align={align} alignOffset={alignOffset} side={side} sideOffset={sideOffset} className="isolate z-50">
        <MenuPrimitive.Popup
          data-slot="menu-content"
          className={cn(
            "z-50 max-h-80 min-w-56 origin-(--transform-origin) overflow-y-auto rounded-md bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function MenuItem({ className, ...props }: MenuPrimitive.Item.Props) {
  return (
    <MenuPrimitive.Item
      data-slot="menu-item"
      className={cn(
        "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 outline-hidden select-none",
        "data-highlighted:bg-accent data-highlighted:text-accent-foreground",
        "data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function MenuGroup({ ...props }: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="menu-group" {...props} />;
}

function MenuRadioGroup({ ...props }: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="menu-radio-group" {...props} />;
}

function MenuRadioItem({ className, ...props }: MenuPrimitive.RadioItem.Props) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="menu-radio-item"
      className={cn(
        "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 outline-hidden select-none",
        "data-highlighted:bg-accent data-highlighted:text-accent-foreground",
        "data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function MenuRadioItemIndicator({ ...props }: MenuPrimitive.RadioItemIndicator.Props) {
  return <MenuPrimitive.RadioItemIndicator data-slot="menu-radio-item-indicator" {...props} />;
}

/** Must be rendered inside a `MenuGroup`; Base UI reads the group context. */
function MenuGroupLabel({ className, ...props }: MenuPrimitive.GroupLabel.Props) {
  return <MenuPrimitive.GroupLabel data-slot="menu-group-label" className={cn("px-2 py-1.5 text-xs font-medium text-muted-foreground", className)} {...props} />;
}

function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return <MenuPrimitive.Separator data-slot="menu-separator" className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}

export { Menu, MenuContent, MenuGroup, MenuGroupLabel, MenuItem, MenuRadioGroup, MenuRadioItem, MenuRadioItemIndicator, MenuSeparator, MenuTrigger };
