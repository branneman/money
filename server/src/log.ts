// The server's lines. A request line holds the method, the route's pattern and never its
// path, the status and the time taken. An event is a fixed text from the server's own
// code, never anything a person typed, a cookie, or anything from the archive.

export type Log = {
  request(method: string, route: string, status: number, ms: number): void;
  event(text: string): void;
};

export const makeLog = (out: (line: string) => void): Log => ({
  request: (method, route, status, ms) =>
    out(`request method=${method} route=${route} status=${status} ms=${ms}`),
  event: (text) => out(text),
});
