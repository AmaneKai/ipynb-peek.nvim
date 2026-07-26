export declare const DELIM: string

export declare function sign(parts: string[], key: string): string

export declare function buildMessage(
  msgType: string,
  content: any,
  msgId: string,
  key: string,
  session: string,
  parentHeader?: any,
): string[]

export type ParsedFrame = {
  header: any
  parent_header: any
  content: any
}

export declare function parseFrames(frames: (Buffer | Uint8Array)[]): ParsedFrame | null
