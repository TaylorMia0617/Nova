export type FloatingVerticalPlacement = "top" | "bottom";
export type FloatingHorizontalPlacement = "left" | "right";

export type FloatingAnchor =
  | { x: number; y: number }
  | { left: number; top: number; right: number; bottom: number };

export interface FloatingPositionOptions {
  width: number;
  height: number;
  offset?: number;
  padding?: number;
  minHeight?: number;
  preferVertical?: FloatingVerticalPlacement;
  preferHorizontal?: FloatingHorizontalPlacement;
}

export interface FloatingPositionResult {
  left: number;
  top: number;
  maxHeight: number;
  placementY: FloatingVerticalPlacement;
  placementX: FloatingHorizontalPlacement;
}

const toAnchorRect = (anchor: FloatingAnchor) => {
  if ("x" in anchor) {
    return {
      left: anchor.x,
      right: anchor.x,
      top: anchor.y,
      bottom: anchor.y,
    };
  }
  return anchor;
};

const clamp = (value: number, min: number, max: number) => {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
};

export const getFloatingPosition = (
  anchor: FloatingAnchor,
  {
    width,
    height,
    offset = 6,
    padding = 12,
    minHeight = 96,
    preferVertical = "bottom",
    preferHorizontal = "right",
  }: FloatingPositionOptions
): FloatingPositionResult => {
  const rect = toAnchorRect(anchor);
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const actualWidth = Math.min(width, Math.max(0, viewportWidth - padding * 2));
  const desiredHeight = Math.min(height, Math.max(0, viewportHeight - padding * 2));

  const spaceBelow = viewportHeight - rect.bottom - padding - offset;
  const spaceAbove = rect.top - padding - offset;
  const preferredSpace = preferVertical === "bottom" ? spaceBelow : spaceAbove;
  const fallbackSpace = preferVertical === "bottom" ? spaceAbove : spaceBelow;
  const placementY: FloatingVerticalPlacement =
    preferredSpace >= desiredHeight || preferredSpace >= fallbackSpace
      ? preferVertical
      : preferVertical === "bottom"
        ? "top"
        : "bottom";
  const verticalSpace = placementY === "bottom" ? spaceBelow : spaceAbove;
  const maxHeight = Math.min(
    desiredHeight,
    Math.max(Math.min(minHeight, viewportHeight - padding * 2), verticalSpace)
  );
  const rawTop = placementY === "bottom"
    ? rect.bottom + offset
    : rect.top - maxHeight - offset;
  const top = clamp(rawTop, padding, viewportHeight - maxHeight - padding);

  const rightSpace = viewportWidth - rect.left - padding;
  const leftSpace = rect.right - padding;
  const preferredHorizontalSpace = preferHorizontal === "right" ? rightSpace : leftSpace;
  const fallbackHorizontalSpace = preferHorizontal === "right" ? leftSpace : rightSpace;
  const placementX: FloatingHorizontalPlacement =
    preferredHorizontalSpace >= actualWidth || preferredHorizontalSpace >= fallbackHorizontalSpace
      ? preferHorizontal
      : preferHorizontal === "right"
        ? "left"
        : "right";
  const rawLeft = placementX === "right"
    ? rect.left
    : rect.right - actualWidth;
  const left = clamp(rawLeft, padding, viewportWidth - actualWidth - padding);

  return { left, top, maxHeight, placementY, placementX };
};
