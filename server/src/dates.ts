const NITTER_DATE = /^(\w{3}) (\d{1,2}), (\d{4}) · (\d{1,2}):(\d{2}) (AM|PM) UTC$/;
const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

export function normalizeTweetDate(value: string): string | null {
  const match = NITTER_DATE.exec(value.trim());
  if (!match) return null;

  const month = MONTHS[match[1]];
  if (month === undefined) return null;

  let hour = Number(match[4]) % 12;
  if (match[6] === 'PM') hour += 12;
  const date = new Date(Date.UTC(
    Number(match[3]), month, Number(match[2]), hour, Number(match[5]),
  ));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
