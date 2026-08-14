export function MoveList({ sans }: { sans: string[] }) {
  if (sans.length === 0) {
    return (
      <div className="move-list empty" aria-label="Current move sequence">
        No moves yet
      </div>
    );
  }
  const rows: Array<{
    number: number;
    white: string | undefined;
    black: string | undefined;
  }> = [];
  for (let index = 0; index < sans.length; index += 2) {
    rows.push({
      number: index / 2 + 1,
      white: sans[index],
      black: sans[index + 1],
    });
  }
  return (
    <ol className="move-list" aria-label="Current move sequence">
      {rows.map((row) => (
        <li key={row.number}>
          <span className="move-number">{row.number}.</span>
          <strong>{row.white}</strong>
          <span>{row.black ?? '…'}</span>
        </li>
      ))}
    </ol>
  );
}
