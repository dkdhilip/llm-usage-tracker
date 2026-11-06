/** The short context around a match, with the matched words highlighted. The server sends the context with
 *  "[matched]" where the match was, and the matched words apart (`match`) when it kept them (a word or phrase rule).
 *  Without them (a pattern or an older match) "[matched]" is shown as it is. */
export function Snippet({ snippet, match }: { snippet: string; match?: string | null }) {
  const at = match ? snippet.indexOf("[matched]") : -1;
  if (!match || at < 0) return <>{snippet}</>;
  return (
    <>
      {snippet.slice(0, at)}
      <mark className="rounded bg-warning-soft px-0.5 font-semibold text-warning-fg">{match}</mark>
      {snippet.slice(at + "[matched]".length)}
    </>
  );
}
