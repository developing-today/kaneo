import { and, eq, sql } from "drizzle-orm";
import db from "../database";
import {
  dataMigrationTable,
  externalLinkTable,
  integrationRepositoryTable,
  integrationTable,
} from "../database/schema";

const COMPLETION_ID = "integration-repository-v1";

type ParsedConfig = {
  repositoryOwner?: unknown;
  repositoryName?: unknown;
  repositoryId?: unknown;
  installationId?: unknown;
  verifiedGithubAccountId?: unknown;
  verifiedByUserId?: unknown;
};

function parseBinding(config: string): ParsedConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(config);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as ParsedConfig;
}

function bindingFromConfig(config: string) {
  const parsed = parseBinding(config);
  if (!parsed) return null;
  const repositoryOwner = parsed.repositoryOwner;
  const repositoryName = parsed.repositoryName;
  if (
    typeof repositoryOwner !== "string" ||
    repositoryOwner.length === 0 ||
    typeof repositoryName !== "string" ||
    repositoryName.length === 0
  ) {
    return null;
  }
  const asInt = (value: unknown) =>
    Number.isSafeInteger(value) ? (value as number) : null;
  const asString = (value: unknown) =>
    typeof value === "string" && value.length > 0 ? value : null;
  return {
    repositoryOwner,
    repositoryName,
    repositoryId: asInt(parsed.repositoryId),
    installationId: asInt(parsed.installationId),
    verifiedGithubAccountId: asString(parsed.verifiedGithubAccountId),
    verifiedByUserId: asString(parsed.verifiedByUserId),
  };
}

/**
 * Backfills the `integration_repository` table for existing single-repo GitHub
 * integrations and points their external links at the new primary binding.
 *
 * Runs once (guarded by a data-migration marker). Every GitHub integration gets
 * one primary binding whose repository fields mirror its `config`; external
 * links that predate the binding column are re-attached to that binding so a
 * single-repo project is equivalent to its pre-migration state.
 */
export async function migrateIntegrationRepositories() {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('integration-repository-migration-v1'))`,
    );
    const markers = await tx
      .select({ id: dataMigrationTable.id })
      .from(dataMigrationTable);
    if (markers.some((marker) => marker.id === COMPLETION_ID)) return;

    const integrations = await tx
      .select({
        id: integrationTable.id,
        config: integrationTable.config,
      })
      .from(integrationTable)
      .where(eq(integrationTable.type, "github"));

    for (const integration of integrations) {
      const binding = bindingFromConfig(integration.config);
      if (!binding) continue;
      await tx
        .insert(integrationRepositoryTable)
        .values({
          integrationId: integration.id,
          repositoryOwner: binding.repositoryOwner,
          repositoryName: binding.repositoryName,
          repositoryId: binding.repositoryId,
          installationId: binding.installationId,
          verifiedGithubAccountId: binding.verifiedGithubAccountId,
          verifiedByUserId: binding.verifiedByUserId,
          isPrimary: true,
        })
        .onConflictDoNothing({
          target: [
            integrationRepositoryTable.integrationId,
            integrationRepositoryTable.repositoryOwner,
            integrationRepositoryTable.repositoryName,
          ],
        });
      // Reuse an existing binding (e.g. one created by the app before this
      // migration first ran) and make sure it is the primary.
      await tx
        .update(integrationRepositoryTable)
        .set({ isPrimary: true })
        .where(
          and(
            eq(integrationRepositoryTable.integrationId, integration.id),
            eq(
              integrationRepositoryTable.repositoryOwner,
              binding.repositoryOwner,
            ),
            eq(
              integrationRepositoryTable.repositoryName,
              binding.repositoryName,
            ),
          ),
        );
    }

    await tx.execute(sql`
      UPDATE ${externalLinkTable} AS el
      SET integration_repository_id = ir.id
      FROM ${integrationTable} AS i
      JOIN ${integrationRepositoryTable} AS ir ON ir.integration_id = i.id AND ir.is_primary
      WHERE el.integration_id = i.id
        AND i.type = 'github'
        AND el.integration_repository_id IS NULL
    `);

    await tx
      .insert(dataMigrationTable)
      .values({ id: COMPLETION_ID })
      .onConflictDoNothing();
  });
}
