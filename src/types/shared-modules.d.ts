declare module "*.js" {
  export function parseChineseNumber(input: string): number | null;
  export function extractSortableNumber(name: string): number | null;
  export function compareNodeNames(leftName: string, rightName: string): number;
}

declare module "*.png" {
  const value: string;
  export default value;
}

declare module "*.jpg" {
  const value: string;
  export default value;
}

declare module "*.jpeg" {
  const value: string;
  export default value;
}

declare module "*.svg" {
  const value: string;
  export default value;
}

declare module "*.gif" {
  const value: string;
  export default value;
}
