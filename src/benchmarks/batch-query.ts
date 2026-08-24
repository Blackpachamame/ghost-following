import type { ActivityPeriod } from "../domain/activity.js";
export { chunkValues } from "../utils/chunks.js";

export interface BatchAlias {
  alias: string;
  login: string;
}

export interface BuiltBatchQuery {
  query: string;
  variables: Record<string, string>;
  aliases: BatchAlias[];
}

export function buildBatchActivityQuery(
  logins: readonly string[],
  period: ActivityPeriod,
): BuiltBatchQuery {
  if (logins.length === 0) {
    throw new RangeError("A batch query requires at least one login.");
  }

  const aliases = logins.map((login, index) => ({ alias: `u${index}`, login }));
  const loginDefinitions = aliases.map(
    (_alias, index) => `$login${index}: String!`,
  );
  const selections = aliases.map(
    ({ alias }, index) => `
      ${alias}: user(login: $login${index}) {
        login
        contributionsCollection(from: $from, to: $to) {
          hasAnyContributions
          hasAnyRestrictedContributions
          restrictedContributionsCount
          contributionCalendar {
            totalContributions
          }
        }
      }`,
  );
  const variables: Record<string, string> = {
    from: period.from,
    to: period.to,
  };
  for (const [index, login] of logins.entries()) {
    variables[`login${index}`] = login;
  }

  return {
    query: `
      query BatchActivity(
        $from: DateTime!
        $to: DateTime!
        ${loginDefinitions.join("\n        ")}
      ) {
        ${selections.join("\n")}
        rateLimit {
          cost
          limit
          remaining
          resetAt
        }
      }
    `,
    variables,
    aliases,
  };
}
