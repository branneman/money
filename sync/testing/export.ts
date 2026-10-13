// Renders a made-up export file, for tests. A cell that needs quoting always gets it; any
// other cell is quoted when `quote` says so.
export const renderExport = (
  header: readonly string[],
  rows: readonly (readonly string[])[],
  options: {
    delimiter?: string;
    eol?: string;
    finalEol?: boolean;
    quote?: (cell: string) => boolean;
  } = {},
): string => {
  const { delimiter = ";", eol = "\r\n", finalEol = true, quote = () => false } = options;
  const cell = (text: string): string =>
    text.includes(delimiter) || /["\r\n]/.test(text) || quote(text)
      ? `"${text.replaceAll('"', '""')}"`
      : text;
  const lines = [header, ...rows].map((cells) => cells.map(cell).join(delimiter));
  return lines.join(eol) + (finalEol ? eol : "");
};
