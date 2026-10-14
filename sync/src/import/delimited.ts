// Text to a header and rows of cells. Quoting follows RFC 4180: a cell that starts with a
// double quote runs to the closing one, and may hold the delimiter, a line break and a
// doubled quote. Anything else that is not a plain table is refused, never repaired: what
// is read here is stored for good.
import { ImportError, reject } from "./error.ts";

export type Table = { header: string[]; rows: string[][] };

const cells = (count: number): string => `${count} ${count === 1 ? "cell" : "cells"}`;

const split = (text: string, delimiter: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  // start: nothing of the cell read yet. plain: inside an unquoted cell. open: inside
  // quotes. closed: just past the closing quote.
  let state: "start" | "plain" | "open" | "closed" = "start";
  const here = (): string => `row ${rows.length + 1}`;
  const endCell = (): void => {
    row.push(cell);
    cell = "";
    state = "start";
  };
  const endRow = (): void => {
    endCell();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (state === "open") {
      if (character !== '"') cell += character;
      else if (text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else state = "closed";
    } else if (character === delimiter) endCell();
    else if (character === "\n") endRow();
    else if (character === "\r" && text[index + 1] === "\n") {
      index += 1;
      endRow();
    } else if (character === "\r") {
      // A line ends in CRLF or LF. A carriage return alone is neither: refused, so that a
      // file ending its lines that way is named for what it is.
      throw new ImportError(`${here()} has a carriage return that does not end a line`);
    } else if (state === "closed") {
      throw new ImportError(`${here()} has text after a closing quote`);
    } else if (character === '"') {
      if (state !== "start") {
        throw new ImportError(`${here()} has a quote inside a cell that is not quoted`);
      }
      state = "open";
    } else {
      cell += character;
      state = "plain";
    }
  }
  if (state === "open") throw new ImportError(`${here()} has a quote that is never closed`);
  // A line ending at the end of the file ends the last row and starts no new one.
  if (state !== "start" || row.length > 0) endRow();
  return rows;
};

export const readDelimited = (text: string, delimiter: string): Table => {
  const all = split(text, delimiter);
  if (all.length === 0) throw new ImportError("the file is empty");
  const [header, ...rows] = all;

  const problems: string[] = [];
  const firstAt = new Map<string, number>();
  header.forEach((name, index) => {
    if (name === "") {
      problems.push(`column ${index + 1} of the header has no name`);
      return;
    }
    const earlier = firstAt.get(name);
    if (earlier === undefined) firstAt.set(name, index);
    else problems.push(`columns ${earlier + 1} and ${index + 1} of the header have the same name`);
  });
  if (rows.length === 0) problems.push("the file has a header and no rows");
  rows.forEach((row, index) => {
    if (row.length !== header.length) {
      problems.push(
        `row ${index + 2} has ${cells(row.length)}, and the header has ${header.length}`,
      );
    }
  });
  if (problems.length > 0) throw reject(problems);
  return { header, rows };
};
