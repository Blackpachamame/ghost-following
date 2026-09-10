import { enrichHistoricalActivity, type HistoricalCandidate } from "../activity/historical.js";
import { CheckpointWriter, removeCheckpoint } from "../checkpoint.js";
import type { AuditResult, SerializableGraphQLRateLimit } from "../domain/audit.js";
import { writeAuditExports } from "../export/files.js";
import { GitHubGraphQLAccountError, GitHubRateLimitError } from "../github/errors.js";
import { GitHubGraphQLClient, type GraphQLRateLimit } from "../github/graphql.js";
import type { Sleep } from "../github/retry.js";
import type { EnrichHistoryOptions } from "./args.js";
import {
  createHistoryEnrichmentCheckpoint,
  historyEnrichmentCheckpointPathFor,
  loadHistoryEnrichmentCheckpoint,
  validateHistoryEnrichmentResume,
  type CompletedHistoricalActivity,
} from "./checkpoint.js";
import { assertDistinctPaths, readAuditExport } from "./input.js";

export interface EnrichmentDependencies {
  token?: string;
  getToken?(): string | undefined;
  fetch?: typeof globalThis.fetch;
  sleep?: Sleep;
  now?(): Date;
  concurrency?: number;
  checkpointRoot?: string;
  onProgress?(completed: number, total: number): void;
  onCheckpointSaved?(path: string): void;
}

function loginKey(login: string): string {
  return login.toLocaleLowerCase("en-US");
}

function serializeRateLimit(rateLimit: GraphQLRateLimit): SerializableGraphQLRateLimit {
  return {
    cost: rateLimit.cost,
    limit: rateLimit.limit,
    remaining: rateLimit.remaining,
    resetAt: rateLimit.resetAt.toISOString(),
  };
}

export async function enrichHistoryReport(
  options: EnrichHistoryOptions,
  dependencies: EnrichmentDependencies = {},
): Promise<AuditResult> {
  const { audit: source, sourceHash } = await readAuditExport(options.inputPath);
  const checkpointPath = historyEnrichmentCheckpointPathFor(source.user, dependencies.checkpointRoot);
  const destinations = [
    { path: options.jsonPath, label: "JSON output" },
    ...(options.csvPath === undefined ? [] : [{ path: options.csvPath, label: "CSV output" }]),
    { path: checkpointPath, label: "enrichment checkpoint" },
  ];
  await assertDistinctPaths(options.inputPath, destinations);
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now();
  const checkpoint = options.resume
    ? await loadHistoryEnrichmentCheckpoint(checkpointPath)
    : createHistoryEnrichmentCheckpoint(source, sourceHash, options.historyYears, startedAt);
  if (options.resume) {
    validateHistoryEnrichmentResume(checkpoint, source, sourceHash, options.historyYears);
  }

  const candidates: HistoricalCandidate[] = source.accounts
    .filter(({ status, accountType }) => status === "NO_RECENT_VISIBLE_ACTIVITY" && accountType === "User")
    .map(({ login, status }) => ({ account: { login }, status }));
  const completed = Object.values(checkpoint.completedHistoricalActivity);
  const pendingCount = candidates.length - completed.length;
  // Reading the environment and constructing the client are deferred until all
  // local validation succeeds and there is actually work to query.
  const token = pendingCount > 0 ? dependencies.token ?? dependencies.getToken?.() : undefined;
  if (pendingCount > 0 && !token) {
    throw new Error("Historical enrichment requires GITHUB_TOKEN when accounts remain pending. The token is never stored.");
  }

  const writer = new CheckpointWriter(checkpointPath);
  const save = async (): Promise<void> => {
    await writer.save(checkpoint, now());
    dependencies.onCheckpointSaved?.(checkpointPath);
  };
  await save();
  dependencies.onProgress?.(completed.length, candidates.length);

  if (pendingCount > 0) {
    const client = new GitHubGraphQLClient({
      token: token!,
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      ...(dependencies.sleep === undefined ? {} : { sleep: dependencies.sleep }),
    });
    const provider = {
      async getHistoricalActivity(login: string, period: AuditResult["period"]) {
        try {
          const response = await client.getHistoricalActivity(login, period);
          // Track observation order, including across concurrent accounts and
          // quota resets. The source REST snapshot is never replaced.
          checkpoint.lastGraphqlRateLimit = serializeRateLimit(response.rateLimit);
          return response;
        } catch (error) {
          const rate = error instanceof GitHubGraphQLAccountError
            ? error.rateLimit
            : error instanceof GitHubRateLimitError ? error.details : undefined;
          if (rate !== undefined && "cost" in rate && typeof rate.cost === "number" &&
              rate.limit !== undefined && rate.remaining !== undefined &&
              rate.resetAt !== undefined) {
            checkpoint.lastGraphqlRateLimit = serializeRateLimit({
              cost: rate.cost, limit: rate.limit, remaining: rate.remaining, resetAt: rate.resetAt,
            });
          }
          throw error;
        }
      },
    };
    try {
      // Source quota may be old; historical starts with a new observation.
      // Reused results contain only historical fields and the source identity.
      await enrichHistoricalActivity(candidates, provider, source.period, {
        historyYears: options.historyYears,
        ...(dependencies.concurrency === undefined ? {} : { concurrency: dependencies.concurrency }),
        completedHistoricalActivity: completed.map((item) => ({
          account: { login: item.login }, status: "NO_RECENT_VISIBLE_ACTIVITY" as const,
          lastVisibleActivityAt: item.lastVisibleActivityAt,
          historicalLookupStatus: item.historicalLookupStatus,
        })),
        async onHistoricalAccountCompleted(result, count, total) {
          const status = result.historicalLookupStatus;
          if (status !== "FOUND" && status !== "NOT_FOUND_IN_LOOKBACK" && status !== "FAILED") {
            throw new Error("Historical lookup did not produce a completed result.");
          }
          const saved: CompletedHistoricalActivity = {
            login: result.account.login,
            lastVisibleActivityAt: result.lastVisibleActivityAt ?? null,
            historicalLookupStatus: status,
          };
          checkpoint.completedHistoricalActivity[loginKey(saved.login)] = saved;
          await save();
          dependencies.onProgress?.(count, total);
        },
      });
    } catch (error) {
      // The shared historical stage drains in-flight work before throwing.
      // Capture the last observation even if its account did not complete.
      await save();
      await writer.flush();
      throw error;
    }
  }

  await writer.flush();
  const audit: AuditResult = {
    ...source,
    generatedAt: now().toISOString(),
    history: { ...source.history, years: options.historyYears },
    accounts: source.accounts.map((account) => {
      const historical = checkpoint.completedHistoricalActivity[loginKey(account.login)];
      if (account.status !== "NO_RECENT_VISIBLE_ACTIVITY" || historical === undefined) return account;
      return {
        ...account,
        lastVisibleActivityAt: historical.lastVisibleActivityAt,
        historicalLookupStatus: historical.historicalLookupStatus,
      };
    }),
    rateLimits: {
      ...source.rateLimits,
      graphql: checkpoint.lastGraphqlRateLimit ?? source.rateLimits.graphql,
    },
  };
  // Recheck aliases before writing, including ones created while queries ran.
  await assertDistinctPaths(options.inputPath, destinations);
  await writeAuditExports(audit, options);
  await removeCheckpoint(checkpointPath);
  return audit;
}

