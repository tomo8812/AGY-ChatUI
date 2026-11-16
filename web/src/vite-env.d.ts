/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __APP_COMMIT_SHA__: string;

declare module 'mammoth' {
  export function convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<{
    value: string;
    messages: Array<{ type: string; message: string }>;
  }>;
}
