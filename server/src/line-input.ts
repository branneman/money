// The editing of one typed line, apart from the terminal so it can be tested. The input
// arrives in chunks of any size, and a paste can hold several lines: what follows the
// first line break is returned as `rest`, kept for the next read, never dropped.

const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const BACKSPACE = "\u007f";

export type Split = { line: string | null; rest: string; aborted: boolean };

export const splitInput = (pending: string, chunk: string): Split => {
  let line = "";
  const text = pending + chunk;
  for (let at = 0; at < text.length; at += 1) {
    const key = text[at];
    if (key === CTRL_C || key === CTRL_D) return { line: null, rest: "", aborted: true };
    if (key === "\r" || key === "\n") {
      const skip = key === "\r" && text[at + 1] === "\n" ? 2 : 1;
      return { line, rest: text.slice(at + skip), aborted: false };
    }
    line = key === BACKSPACE ? line.slice(0, -1) : line + key;
  }
  // Without a break the edited text is what is kept, so a backspace is not applied twice.
  return { line: null, rest: line, aborted: false };
};
