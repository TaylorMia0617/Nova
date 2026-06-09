import React, { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Minus, Square, X, FilePlus, FolderOpen, SaveAll, FileDown, LogOut, Undo2, Redo2, Scissors, Copy, ClipboardPaste, TextSelect, Search, Replace, LayoutGrid, Plus } from "lucide-react";
import { useTranslation } from "../hooks/useTranslation";
import { useFileStore } from "../stores/fileStore";
import { getFloatingPosition, type FloatingPositionResult } from "../utils/floatingPosition";
import icon from "../assets/icon.png";
import "./MenuBar.css";

interface MenuItem {
  id: string;
  label: string;
  shortcut?: string;
  icon?: React.ReactNode;
  action?: () => void;
  disabled?: boolean;
  separator?: boolean;
}

const MenuBar: React.FC = () => {
  const { t } = useTranslation();
  const { openWorkspace, saveAllFiles, getOpenTabs } = useFileStore();
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<Pick<FloatingPositionResult, "left" | "top" | "maxHeight"> | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const dirtyCount = getOpenTabs().filter((tab) => tab.isDirty).length;

  const handleMinimize = () => window.novelHost?.minimize();
  const handleMaximize = () => window.novelHost?.maximize();
  const handleClose = () => window.novelHost?.close();

  const closeMenu = useCallback(() => {
    setActiveMenu(null);
    setMenuPosition(null);
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
        !dropdownRef.current?.contains(target)
      ) {
        closeMenu();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [closeMenu]);

  const setMenuAnchor = (target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    setMenuPosition(getFloatingPosition(
      { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      {
        width: 260,
        height: 360,
        offset: 2,
        padding: 8,
        minHeight: 120,
        preferVertical: "bottom",
        preferHorizontal: "right",
      }
    ));
  };

  const handleMenuClick = (menuId: string, event: React.MouseEvent<HTMLElement>) => {
    if (activeMenu === menuId) {
      closeMenu();
      return;
    }

    setMenuAnchor(event.currentTarget);
    setActiveMenu(menuId);
  };

  const handleMenuHover = (menuId: string, event: React.MouseEvent<HTMLElement>) => {
    if (!activeMenu) return;
    setMenuAnchor(event.currentTarget);
    setActiveMenu(menuId);
  };

  const handleItemClick = (action?: () => void) => {
    closeMenu();
    action?.();
  };

  const fileMenuItems: MenuItem[] = [
    {
      id: "newFile",
      label: t("menubar.file.newFile"),
      shortcut: "Ctrl+N",
      icon: <FilePlus size={14} />,
      action: () => {
        // TODO: 实现新建文件功能
      },
    },
    { id: "sep1", label: "", separator: true },
    {
      id: "newWorkspace",
      label: t("menubar.file.newWorkspace"),
      icon: <FolderOpen size={14} />,
      action: () => void openWorkspace(),
    },
    {
      id: "openWorkspace",
      label: t("menubar.file.openWorkspace"),
      shortcut: "Ctrl+O",
      icon: <FolderOpen size={14} />,
      action: () => void openWorkspace(),
    },
    { id: "sep2", label: "", separator: true },
    {
      id: "saveAll",
      label: t("menubar.file.saveAll"),
      shortcut: "Ctrl+Shift+S",
      icon: <SaveAll size={14} />,
      action: () => void saveAllFiles(),
      disabled: dirtyCount === 0,
    },
    {
      id: "saveAs",
      label: t("menubar.file.saveAs"),
      shortcut: "Ctrl+Shift+A",
      icon: <FileDown size={14} />,
      action: () => {
        // TODO: 实现另存为功能
      },
    },
    { id: "sep3", label: "", separator: true },
    {
      id: "exit",
      label: t("menubar.file.exit"),
      icon: <LogOut size={14} />,
      action: () => window.novelHost?.close(),
    },
  ];

  const editMenuItems: MenuItem[] = [
    {
      id: "undo",
      label: t("menubar.edit.undo"),
      shortcut: "Ctrl+Z",
      icon: <Undo2 size={14} />,
      action: () => document.execCommand("undo"),
    },
    {
      id: "redo",
      label: t("menubar.edit.redo"),
      shortcut: "Ctrl+Y",
      icon: <Redo2 size={14} />,
      action: () => document.execCommand("redo"),
    },
    { id: "sep1", label: "", separator: true },
    {
      id: "cut",
      label: t("menubar.edit.cut"),
      shortcut: "Ctrl+X",
      icon: <Scissors size={14} />,
      action: () => document.execCommand("cut"),
    },
    {
      id: "copy",
      label: t("menubar.edit.copy"),
      shortcut: "Ctrl+C",
      icon: <Copy size={14} />,
      action: () => document.execCommand("copy"),
    },
    {
      id: "paste",
      label: t("menubar.edit.paste"),
      shortcut: "Ctrl+V",
      icon: <ClipboardPaste size={14} />,
      action: () => document.execCommand("paste"),
    },
    { id: "sep2", label: "", separator: true },
    {
      id: "selectAll",
      label: t("menubar.edit.selectAll"),
      shortcut: "Ctrl+A",
      icon: <TextSelect size={14} />,
      action: () => document.execCommand("selectAll"),
    },
    { id: "sep3", label: "", separator: true },
    {
      id: "find",
      label: t("menubar.edit.find"),
      shortcut: "Ctrl+F",
      icon: <Search size={14} />,
      action: () => {
        // TODO: 实现查找功能
      },
    },
    {
      id: "replace",
      label: t("menubar.edit.replace"),
      shortcut: "Ctrl+H",
      icon: <Replace size={14} />,
      action: () => {
        // TODO: 实现替换功能
      },
    },
  ];

  const windowMenuItems: MenuItem[] = [
    {
      id: "newWindow",
      label: t("menubar.window.newWindow"),
      shortcut: "Ctrl+Shift+N",
      icon: <Plus size={14} />,
      action: () => window.novelHost?.createNewWindow(),
    },
    { id: "sep0", label: "", separator: true },
    {
      id: "editor",
      label: t("menubar.window.editor"),
      icon: <LayoutGrid size={14} />,
      action: () => {
        // TODO: 切换到编辑器面板
      },
    },
    {
      id: "copilot",
      label: t("menubar.window.copilot"),
      icon: <LayoutGrid size={14} />,
      action: () => {
        // TODO: 切换到AI助手面板
      },
    },
    {
      id: "assets",
      label: t("menubar.window.assets"),
      icon: <LayoutGrid size={14} />,
      action: () => {
        // TODO: 切换到资源管理器面板
      },
    },
    { id: "sep1", label: "", separator: true },
    {
      id: "closePanel",
      label: t("menubar.window.closePanel"),
      shortcut: "Ctrl+W",
      icon: <X size={14} />,
      action: () => {
        // TODO: 关闭当前面板
      },
    },
  ];

  const renderDropdown = (items: MenuItem[]) => {
    if (!menuPosition) return null;

    return createPortal(
      <div
        ref={dropdownRef}
        className="dropdown-menu menubar-dropdown-portal"
        style={{ left: menuPosition.left, top: menuPosition.top, maxHeight: menuPosition.maxHeight }}
      >
        {items.map((item) =>
          item.separator ? (
            <div key={item.id} className="dropdown-separator" />
          ) : (
            <button
              key={item.id}
              className="dropdown-item"
              onClick={() => handleItemClick(item.action)}
              disabled={item.disabled}
            >
              <span style={{ display: "flex", alignItems: "center" }}>
                {item.icon && <span className="item-icon">{item.icon}</span>}
                {item.label}
              </span>
              {item.shortcut && <span className="shortcut">{item.shortcut}</span>}
            </button>
          )
        )}
      </div>,
      document.body
    );
  };

  return (
    <div className="menubar" ref={menuRef}>
      <div className="menubar-left">
        <div className="menubar-logo">
          <img src={icon} alt="Nova" />
        </div>
        <div
          className={`menubar-item ${activeMenu === "file" ? "active" : ""}`}
          onClick={(event) => handleMenuClick("file", event)}
          onMouseEnter={(event) => handleMenuHover("file", event)}
        >
          {t("menubar.file.title")}
          {activeMenu === "file" && renderDropdown(fileMenuItems)}
        </div>

        <div
          className={`menubar-item ${activeMenu === "edit" ? "active" : ""}`}
          onClick={(event) => handleMenuClick("edit", event)}
          onMouseEnter={(event) => handleMenuHover("edit", event)}
        >
          {t("menubar.edit.title")}
          {activeMenu === "edit" && renderDropdown(editMenuItems)}
        </div>

        <div
          className={`menubar-item ${activeMenu === "window" ? "active" : ""}`}
          onClick={(event) => handleMenuClick("window", event)}
          onMouseEnter={(event) => handleMenuHover("window", event)}
        >
          {t("menubar.window.title")}
          {activeMenu === "window" && renderDropdown(windowMenuItems)}
        </div>
      </div>

      <div className="menubar-right">
        <div className="window-controls">
          <button className="window-control-btn" onClick={handleMinimize}>
            <Minus size={14} />
          </button>
          <button className="window-control-btn" onClick={handleMaximize}>
            <Square size={14} />
          </button>
          <button className="window-control-btn close" onClick={handleClose}>
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default MenuBar;
