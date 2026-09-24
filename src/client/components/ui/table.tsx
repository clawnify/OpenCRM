import * as React from "react";
import { cn } from "@/lib/utils";

// Pinning: a `sticky` header stays put while the rows scroll under it, and a
// `pinned` head + cells hold the first column while the rest scroll sideways.
// Both need the table's own box to be the scroller, so a table that pins gives
// that box its height with `containerClassName` rather than sitting inside
// another scrolling div. Rules use the lighter `--rule` tone. Pinned cells
// are painted (they cover what scrolls under them) and carry their rules as
// inset shadows, because a collapsed border stays with the row instead of the
// sticky cell. A grid draws every column rule that way, sticky or not: a
// collapsed border sits on the cell boundary, 1px right of an inset shadow, so
// mixing the two misaligns the header's rules with the body's.
//
// Grid (`grid` on Table): the dense record grid. 13px text and 32px rows
// (44px in agent mode, DESIGN.md's tap target), every column at the width its head is given,
// a rule between columns, and a head with `onResize` grows a drag handle on
// its right edge. A grid is as wide as its container or its columns, whichever
// is more: give it a last, widthless column and that column takes the slack,
// so the columns sit at their widths from the left and the row rules run on to
// the edge. The last column never draws a right rule.
const pinnedCell = "sticky left-0 z-10 bg-background shadow-[inset_-1px_0_0_var(--rule)]";
const columnRule = "shadow-[inset_-1px_0_0_var(--rule)] last:shadow-none";
const StickyHeader = React.createContext(false);
const Grid = React.createContext(false);

// Row height: 32px in the grid, the agent-mode tap target when an agent drives it.
const gridRow = "h-8 py-0 [[data-agent]_&]:h-11";

/** Narrowest a column can be dragged to. */
export const MIN_COLUMN_WIDTH = 104;

const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement> & { containerClassName?: string; grid?: boolean }>(
  ({ className, containerClassName, grid = false, ...props }, ref) => (
    <Grid.Provider value={grid}>
      <div className={cn("relative w-full overflow-auto", containerClassName)}>
        <table ref={ref} className={cn("w-full caption-bottom text-sm", grid && "table-fixed text-[0.8125rem]", className)} {...props} />
      </div>
    </Grid.Provider>
  ),
);
Table.displayName = "Table";

const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement> & { sticky?: boolean }>(
  ({ className, sticky = false, ...props }, ref) => (
    <StickyHeader.Provider value={sticky}>
      <thead ref={ref} className={cn("[&_tr]:border-b", className)} {...props} />
    </StickyHeader.Provider>
  ),
);
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => <tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props} />,
);
TableBody.displayName = "TableBody";

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => {
    const grid = React.useContext(Grid);
    return (
      <tr
        ref={ref}
        className={cn("group border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted", grid && "border-rule", className)}
        {...props}
      />
    );
  },
);
TableRow.displayName = "TableRow";

type HeadProps = React.ThHTMLAttributes<HTMLTableCellElement> & {
  pinned?: boolean;
  /** Column width in px; in a `grid` table the column holds it. */
  width?: number;
  /** Makes the column resizable: called with the new width while dragging. */
  onResize?: (width: number) => void;
  /** Called once with the final width when a resize ends: the moment to save it. */
  onResizeEnd?: (width: number) => void;
};

const TableHead = React.forwardRef<HTMLTableCellElement, HeadProps>(
  ({ className, pinned, width, onResize, onResizeEnd, style, children, ...props }, ref) => {
    const sticky = React.useContext(StickyHeader);
    const grid = React.useContext(Grid);
    // A sticky cell carries its rules as inset shadows (see top); a static one
    // in a grid uses a plain border. The last head gets no right rule.
    const right = grid || pinned;
    const shadow = sticky
      ? right ? "shadow-[inset_-1px_-1px_0_var(--rule)] last:shadow-[inset_0_-1px_0_var(--rule)]" : "shadow-[inset_0_-1px_0_var(--rule)]"
      : pinned ? "shadow-[inset_-1px_0_0_var(--rule)]" : undefined;
    return (
      <th
        ref={ref}
        style={width === undefined ? style : { width, ...style }}
        className={cn(
          "h-11 whitespace-nowrap px-3 text-left align-middle text-[0.8125rem] font-medium text-muted-foreground",
          sticky && "sticky top-0 z-20 bg-background",
          pinned && pinnedCell,
          // The corner: above both the header row and the pinned column.
          sticky && pinned && "z-30",
          shadow,
          grid && !sticky && !pinned && columnRule,
          grid && cn("overflow-hidden", gridRow),
          // The handle's anchor. A sticky head already is one, and `relative`
          // here would override its `sticky`.
          onResize && !sticky && !pinned && "relative",
          className,
        )}
        {...props}
      >
        {children}
        {onResize && width !== undefined && <ResizeHandle width={width} onResize={onResize} onResizeEnd={onResizeEnd} />}
      </th>
    );
  },
);
TableHead.displayName = "TableHead";

/**
 * The drag strip on a column's right edge: a col-resize cursor on hover and an
 * accent line while dragging. Also a focusable separator, so the arrow keys
 * resize it for anyone not using a pointer. Widths move live while dragging;
 * `onResizeEnd` fires once, on release, with the final width: the one to save.
 */
function ResizeHandle({ width, onResize, onResizeEnd }: { width: number; onResize: (width: number) => void; onResizeEnd?: (width: number) => void }) {
  const [dragging, setDragging] = React.useState(false);
  const clamp = (w: number) => Math.max(MIN_COLUMN_WIDTH, Math.round(w));

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const startX = e.clientX;
    const startWidth = width;
    el.setPointerCapture(e.pointerId);
    setDragging(true);
    let last = startWidth;
    const move = (ev: PointerEvent) => {
      last = clamp(startWidth + ev.clientX - startX);
      onResize(last);
    };
    const end = () => {
      setDragging(false);
      if (last !== startWidth) onResizeEnd?.(last);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    let next: number;
    if (e.key === "ArrowLeft") next = clamp(width - step);
    else if (e.key === "ArrowRight") next = clamp(width + step);
    else return;
    e.preventDefault();
    onResize(next);
    onResizeEnd?.(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize column"
      aria-valuenow={width}
      aria-valuemin={MIN_COLUMN_WIDTH}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      // Swallow the click the drag ends with, so it doesn't sort the column.
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "absolute inset-y-0 right-0 z-10 w-2.5 cursor-col-resize touch-none outline-none",
        "after:absolute after:inset-y-0 after:right-0 after:w-0.5 after:bg-ring after:opacity-0 focus-visible:after:opacity-100",
        dragging && "after:opacity-100",
      )}
    />
  );
}

// Cells cap column width and clip to a single line: the column grows to fit
// its content up to `max-w`, then truncates. Keeps rows one line tall even
// when a cell holds a long summary or many tags. Override `max-w-*` per cell
// when a column needs to be wider/narrower. In a grid the head's width rules
// instead, and the cell clips to it.
const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement> & { pinned?: boolean }>(
  ({ className, pinned, ...props }, ref) => {
    const grid = React.useContext(Grid);
    return (
      <td
        ref={ref}
        className={cn(
          "h-11 max-w-[16rem] truncate px-3 py-2 align-middle",
          grid && cn("max-w-none", gridRow),
          grid && !pinned && columnRule,
          // Painted, so it takes the row's hover and selected tone itself.
          pinned && cn(pinnedCell, "group-hover:bg-secondary group-data-[state=selected]:bg-muted"),
          className,
        )}
        {...props}
      />
    );
  },
);
TableCell.displayName = "TableCell";

export { Table, TableHeader, TableBody, TableHead, TableRow, TableCell };
