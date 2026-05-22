declare module "*.js" {
  export function parseChineseNumber(input: string): number | null;
  export function extractSortableNumber(name: string): number | null;
  export function compareNodeNames(leftName: string, rightName: string): number;
}
