import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { getFloatingPosition } from "../utils/floatingPosition";
import "./ContextMenu.css";

export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  action: () => void;
  disabled?: boolean;
  separator?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const estimatedHeight = items.reduce((total, item) => total + (item.separator ? 9 : 36), 8);
  const position = getFloatingPosition(
    { x, y },
    {
      width: 220,
      height: estimatedHeight,
      offset: 0,
      padding: 12,
      minHeight: 88,
      preferVertical: "bottom",
      preferHorizontal: "right",
    }
  );

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className={`context-menu placement-${position.placementY}`}
      style={{ left: position.left, top: position.top, maxHeight: position.maxHeight }}
    >
      {items.map((item, index) =>
        item.separator ? (
          <div key={index} className="context-menu-separator" />
        ) : (
          <button
            key={index}
            className="context-menu-item"
            onClick={() => {
              item.action();
              onClose();
            }}
            disabled={item.disabled}
          >
            {item.icon && <span className="context-menu-icon">{item.icon}</span>}
            {item.label}
          </button>
        )
      )}
    </div>,
    document.body
  );
};
