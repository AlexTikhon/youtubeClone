export interface RankingSignals {
  publishedAt: Date;
  viewsCount: number;
  likesCount: number;
  subscribed: boolean;
  watchedRecently: boolean;
}

export function feedScore(signals: RankingSignals, asOf: Date): number {
  const ageHours = Math.max(
    0,
    (asOf.getTime() - signals.publishedAt.getTime()) / 3_600_000,
  );
  const recency = Math.max(0, 1_000 - ageHours * 2);
  const popularity =
    Math.log2(1 + signals.viewsCount) * 35 +
    Math.log2(1 + signals.likesCount) * 55;
  const subscriptionBoost = signals.subscribed ? 500 : 0;
  const watchedPenalty = signals.watchedRecently ? 650 : 0;
  return (
    Math.round(
      (recency + popularity + subscriptionBoost - watchedPenalty) * 1_000,
    ) / 1_000
  );
}

export function compareRanked(
  a: { score: number; publishedAt: Date; id: string },
  b: { score: number; publishedAt: Date; id: string },
): number {
  return (
    b.score - a.score ||
    b.publishedAt.getTime() - a.publishedAt.getTime() ||
    b.id.localeCompare(a.id)
  );
}
