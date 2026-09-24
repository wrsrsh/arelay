import { HttpError, type JsonObject } from "../types.js";

export interface SSEEvent {
  event: string;
  data: JsonObject;
}
const MAX_FRAME = 8 * 1024 * 1024;

export function encodeSSE(event: SSEEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  let frameSize = 0;
  const line = (value: string): SSEEvent | undefined => {
    if (value === "") {
      const payload = data.join("\n");
      const name = event;
      event = "message";
      data = [];
      frameSize = 0;
      if (!payload || payload === "[DONE]") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        throw new HttpError(502, "Upstream returned invalid SSE JSON");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new HttpError(502, "Upstream SSE data must be an object");
      return { event: name, data: parsed as JsonObject };
    }
    frameSize += value.length;
    if (frameSize > MAX_FRAME)
      throw new HttpError(502, "Upstream SSE frame is too large");
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const key = colon < 0 ? value : value.slice(0, colon);
    const content = colon < 0 ? "" : value.slice(colon + 1).replace(/^ /, "");
    if (key === "event") event = content;
    if (key === "data") data.push(content);
    return;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r\n|\r|\n/.exec(buffer))) {
        // A trailing CR may be the first half of CRLF in the next chunk.
        if (!done && match[0] === "\r" && match.index === buffer.length - 1)
          break;
        const result = line(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (result) yield result;
      }
      if (buffer.length + frameSize > MAX_FRAME)
        throw new HttpError(502, "Upstream SSE frame is too large");
      if (done) {
        if (buffer) {
          const result = line(buffer);
          if (result) yield result;
        }
        const result = line("");
        if (result) yield result;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
