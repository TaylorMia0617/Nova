import { Extension, type CommandProps } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    lineHeight: {
      setLineHeight: (height: string) => ReturnType;
      unsetLineHeight: () => ReturnType;
    };
  }
}

function updateSelectedLineHeight(
  { state, dispatch }: CommandProps,
  types: string[],
  lineHeight: string | null
) {
  const { doc, selection, tr } = state;
  const attrsFor = (attrs: Record<string, unknown>) => ({ ...attrs, lineHeight });
  let changed = false;

  const updateNode = (pos: number, node: { type: { name: string }; attrs: Record<string, unknown> }) => {
    if (!types.includes(node.type.name)) return;
    tr.setNodeMarkup(pos, undefined, attrsFor(node.attrs));
    changed = true;
  };

  if (selection.empty) {
    for (let depth = selection.$from.depth; depth > 0; depth -= 1) {
      const node = selection.$from.node(depth);
      if (types.includes(node.type.name)) {
        updateNode(selection.$from.before(depth), node);
        break;
      }
    }
  } else {
    doc.nodesBetween(selection.from, selection.to, (node, pos) => {
      updateNode(pos, node);
    });
  }

  if (changed && dispatch) {
    dispatch(tr);
  }

  return changed;
}

export const LineHeight = Extension.create({
  name: "lineHeight",

  addOptions() {
    return {
      types: ["heading", "paragraph"],
      defaultLineHeight: "1.7",
    };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          lineHeight: {
            default: this.options.defaultLineHeight,
            parseHTML: (element) => element.style.lineHeight || this.options.defaultLineHeight,
            renderHTML: (attributes) => {
              if (!attributes.lineHeight) return {};
              return { style: `line-height: ${attributes.lineHeight}` };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setLineHeight:
        (height: string) =>
        (props) => {
          return updateSelectedLineHeight(props, this.options.types, height);
        },
      unsetLineHeight:
        () =>
        (props) => {
          return updateSelectedLineHeight(props, this.options.types, null);
        },
    };
  },
});
