import { useState } from "react";
import type { DragEvent } from "react";
import {
  experimental_SidebarNavigationIcon,
  experimental_useSidebarNavigation,
  experimental_useSidebarNavigationSplit,
} from "@get-bb/plugin-sdk/app";
import type {
  ExperimentalSidebarNavigationItem,
  ExperimentalSidebarNavigationTarget,
} from "@get-bb/plugin-sdk/app";

import {
  ContextMenu,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { RAIL_ITEM_DRAG_MIME } from "@/lib/folders";

import { cn } from "../lib/utils";
import { ItemContextMenu, type ItemMenuActions } from "./ItemContextMenu";

// The SDK exports the icon component under a lowercase experimental_ name,
// which JSX would read as an intrinsic element, so it needs an alias.
const SidebarNavigationIcon = experimental_SidebarNavigationIcon;

/** Accessible name for an item, with its badge label folded in. */
export function railItemLabel(item: ExperimentalSidebarNavigationItem): string {
  return item.badge === null || item.badge.label === ""
    ? item.label
    : `${item.label}, ${item.badge.label}`;
}

export function targetForClick(event: {
  metaKey: boolean;
  ctrlKey: boolean;
}): ExperimentalSidebarNavigationTarget {
  return event.metaKey || event.ctrlKey ? "split" : "current";
}

/**
 * One row inside a folder popover or the "Ещё" overflow menu. The wrapper is
 * draggable so a member can be pulled out onto the rail; the button keeps the
 * same split-drag affordance and context menu as the rail icon, engaged only
 * once a drag leaves the row so a click still activates.
 */
export function RailMenuRow({
  item,
  isActive,
  showShortcut,
  onActivate,
  onClose,
  menu,
}: {
  item: ExperimentalSidebarNavigationItem;
  isActive: boolean;
  showShortcut: boolean;
  onActivate: (
    item: ExperimentalSidebarNavigationItem,
    target: ExperimentalSidebarNavigationTarget,
  ) => void;
  /** Closes the popover the row lives in, so a drag never covers the page. */
  onClose: () => void;
  menu: ItemMenuActions;
}) {
  const { actions } = experimental_useSidebarNavigation();
  const split = experimental_useSidebarNavigationSplit(item.id, {
    activation: "distance",
    onDragStart: onClose,
  });
  const [dragging, setDragging] = useState(false);
  const unavailable = item.isDisabled || item.isLoading;

  return (
    <div
      draggable
      data-rail-menu-row={item.id}
      data-rail-dragging={dragging ? "" : undefined}
      onDragStart={(event: DragEvent<HTMLDivElement>) => {
        event.stopPropagation();
        event.dataTransfer.setData(RAIL_ITEM_DRAG_MIME, item.id);
        event.dataTransfer.effectAllowed = "move";
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      className={cn(
        "w-full rounded-sm transition",
        dragging && "opacity-40",
      )}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            aria-label={railItemLabel(item)}
            aria-keyshortcuts={item.shortcut?.ariaKeyShortcuts}
            aria-current={isActive ? "page" : undefined}
            disabled={unavailable}
            {...split.splitProps}
            onClick={(event) => {
              if (unavailable) return;
              onActivate(item, targetForClick(event));
            }}
            className={cn(
              "flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none",
              "hover:bg-state-hover focus-visible:bg-state-hover aria-[current=page]:bg-state-active",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
          >
            <SidebarNavigationIcon icon={item.icon} className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.badge === null ? null : (
              <span
                aria-hidden="true"
                className="shrink-0 rounded-full bg-primary px-1 text-[9px] font-medium leading-4 text-primary-foreground"
              >
                {item.badge.text ?? item.badge.count}
              </span>
            )}
            {showShortcut && item.shortcut !== null ? (
              <kbd
                data-rail-shortcut=""
                className="shrink-0 text-[10px] text-muted-foreground"
              >
                {item.shortcut.label}
              </kbd>
            ) : null}
          </button>
        </ContextMenuTrigger>
        <ItemContextMenu item={item} actions={actions} menu={menu} />
      </ContextMenu>
    </div>
  );
}
