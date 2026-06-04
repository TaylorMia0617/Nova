declare module "@xterm/xterm" {
  export class Terminal {
    constructor(options?: any);
    open(parent: HTMLElement): void;
    write(data: string): void;
    writeln(data: string): void;
    clear(): void;
    reset(): void;
    focus(): void;
    dispose(): void;
    loadAddon(addon: any): void;
    onData(callback: (data: string) => void): { dispose: () => void };
    onBinary(callback: (data: string) => void): { dispose: () => void };
    onResize(callback: (size: { cols: number; rows: number }) => void): { dispose: () => void };
    resize(cols: number, rows: number): void;
    cols: number;
    rows: number;
    element: HTMLElement | undefined;
  }
  export default Terminal;
}

declare module "@xterm/xterm/css/xterm.css" {
  const content: string;
  export default content;
}
