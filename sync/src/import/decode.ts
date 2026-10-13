// Bytes to text, by the encoding the import format declares. The decoded text is stored
// for good, and a wrong single-byte encoding still decodes, to the wrong letters. So every
// mismatch that can be detected refuses the file.
import type { ImportFormat } from "@money/shared";

import { ImportError } from "./error.ts";

type Encoding = ImportFormat["encoding"];

const UTF8_MARK = [0xef, 0xbb, 0xbf];

const startsWith = (bytes: Uint8Array, mark: readonly number[]): boolean =>
  mark.every((byte, index) => bytes[index] === byte);

// The text, or null when the bytes are not UTF-8.
const strictUtf8 = (bytes: Uint8Array): string | null => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return null;
  }
};

// Anything below a space other than tab and the line endings, DEL, and U+0080 to U+009F.
// The last range is what a byte with no meaning in the declared encoding decodes to.
const isControl = (code: number): boolean =>
  (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
  (code >= 0x7f && code <= 0x9f);

const hasControl = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    if (isControl(text.charCodeAt(index))) return true;
  }
  return false;
};

const beyondAscii = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) return true;
  }
  return false;
};

export const decode = (bytes: Uint8Array, encoding: Encoding): string => {
  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) {
    throw new ImportError("the file starts with a UTF-16 byte order mark, which no format reads");
  }
  const marked = startsWith(bytes, UTF8_MARK);
  let text: string;
  if (encoding === "utf-8") {
    // The mark is not part of the first header name.
    const decoded = strictUtf8(marked ? bytes.subarray(UTF8_MARK.length) : bytes);
    if (decoded === null) {
      throw new ImportError("the file is not valid UTF-8, but its format declares utf-8");
    }
    text = decoded;
  } else {
    if (marked) {
      throw new ImportError(
        `the file starts with a UTF-8 byte order mark, but its format declares ${encoding}`,
      );
    }
    // Real single-byte text almost never forms valid multi-byte UTF-8 by accident.
    const asUtf8 = strictUtf8(bytes);
    if (asUtf8 !== null && beyondAscii(asUtf8)) {
      throw new ImportError(
        `the file is valid UTF-8 with characters beyond ASCII, but its format declares ${encoding}`,
      );
    }
    text = new TextDecoder(encoding).decode(bytes);
  }
  if (hasControl(text)) {
    throw new ImportError(
      `the file holds a control character once read as ${encoding}, so the encoding is probably another`,
    );
  }
  return text;
};
