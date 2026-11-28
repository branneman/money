import type { IncomingMessage } from "node:http";

export type JsonBody =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly status: 400 | 413 | 415 };

// Fatal: invalid UTF-8 is refused, not quietly replaced by a character the sender never sent.
const UTF8 = new TextDecoder("utf-8", { fatal: true });

const isJsonMediaType = (contentType: string | undefined): boolean =>
  contentType !== undefined &&
  (contentType.split(";", 1)[0] ?? "").trim().toLowerCase() === "application/json";

// Reads a small JSON body. Counts the bytes that actually arrive, never
// trusting Content-Length, and stops as soon as the limit is passed: the
// request is paused, so the rest is neither read nor buffered. The caller
// answers, and should close the connection.
export const readJson = (request: IncomingMessage, limit: number): Promise<JsonBody> =>
  new Promise((resolve) => {
    if (!isJsonMediaType(request.headers["content-type"])) {
      request.pause();
      resolve({ ok: false, status: 415 });
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;

    const finish = (result: JsonBody): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.pause();
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      received += chunk.length;
      if (received > limit) {
        chunks.length = 0;
        finish({ ok: false, status: 413 });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      try {
        finish({ ok: true, value: JSON.parse(UTF8.decode(Buffer.concat(chunks))) });
      } catch {
        finish({ ok: false, status: 400 }); // invalid JSON, or an empty body
      }
    };
    // A client that hangs up mid-body: nobody is left to answer, but the
    // promise must still settle.
    const onError = (): void => finish({ ok: false, status: 400 });

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
  });
