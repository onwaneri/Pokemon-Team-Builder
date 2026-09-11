/** Normalize a moveset to exactly four entries: pads with '' and truncates extras. Client-safe. */
export function padMoves(moves: readonly string[] | undefined): string[] {
  return [...(moves ?? []), '', '', '', ''].slice(0, 4);
}
