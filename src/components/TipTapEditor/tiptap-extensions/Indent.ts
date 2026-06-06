import { Extension } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    indent: {
      indent: () => ReturnType;
      outdent: () => ReturnType;
    };
  }
}

export const Indent = Extension.create({
  name: "indent",

  addOptions() {
    return {
      types: ["heading", "paragraph"],
      minLevel: 0,
      maxLevel: 8,
    };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          indent: {
            default: 0,
            parseHTML: (element) => {
              const level = parseInt(element.style.textIndent || "0", 10);
              return Math.max(this.options.minLevel, Math.min(this.options.maxLevel, level));
            },
            renderHTML: (attributes) => {
              if (!attributes.indent) return {};
              return { style: `text-indent: ${attributes.indent * 2}em` };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      indent:
        () =>
        ({ tr, dispatch }) => {
          const { selection } = tr;
          const pos = selection.$from;
          const node = pos.node(pos.depth === 0 ? 0 : pos.depth);

          if (!node) return false;

          const currentIndent = node.attrs.indent || 0;
          if (currentIndent >= this.options.maxLevel) return false;

          if (dispatch) {
            tr.setNodeMarkup(pos.before(pos.depth === 0 ? 1 : pos.depth), undefined, {
              ...node.attrs,
              indent: currentIndent + 1,
            });
            dispatch(tr);
          }
          return true;
        },
      outdent:
        () =>
        ({ tr, dispatch }) => {
          const { selection } = tr;
          const pos = selection.$from;
          const node = pos.node(pos.depth === 0 ? 0 : pos.depth);

          if (!node) return false;

          const currentIndent = node.attrs.indent || 0;
          if (currentIndent <= this.options.minLevel) return false;

          if (dispatch) {
            tr.setNodeMarkup(pos.before(pos.depth === 0 ? 1 : pos.depth), undefined, {
              ...node.attrs,
              indent: currentIndent - 1,
            });
            dispatch(tr);
          }
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      Tab: () => this.editor.commands.indent(),
      "Shift-Tab": () => this.editor.commands.outdent(),
    };
  },
});
