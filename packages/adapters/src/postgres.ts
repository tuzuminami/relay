import { RelayError } from "../../core/src/errors.ts";
import type { AuditLog, CompletionRecorder, IdempotencyStore, RouteCatalog, UsageRepository } from "../../core/src/ports.ts";
import type { AuditEvent, ChatCompletionResponse, ModelRoute, ProviderConfig, UsageRecord } from "../../core/src/types.ts";

export interface PgQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rowCount: number | null;
  readonly rows: readonly Row[];
}

export interface PgQueryable {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>>;
}

export interface PgClientLike extends PgQueryable {
  release(): void;
}

export interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgClientLike>;
}

interface ProviderRow extends Record<string, unknown> {
  readonly tenant_id: string;
  readonly provider_id: string;
  readonly adapter_type: "openai-compatible";
  readonly base_url: string;
  readonly capabilities: readonly string[];
  readonly secret_reference: string;
  readonly enabled: boolean;
}

interface RouteRow extends Record<string, unknown> {
  readonly route_id: string;
  readonly tenant_id: string;
  readonly purpose: string;
  readonly data_classifications: readonly string[];
  readonly required_capabilities: readonly string[];
  readonly max_cost_cents: number;
  readonly provider_id: string;
  readonly model: string;
  readonly enabled: boolean;
}

interface UsageRow extends Record<string, unknown> {
  readonly id: string;
  readonly tenant_id: string;
  readonly request_id: string;
  readonly route_id: string;
  readonly provider_id: string;
  readonly model: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly estimated_cost_cents: number;
  readonly latency_ms: number;
  readonly terminal_reason: string;
  readonly correlation_id: string;
  readonly created_at: Date;
}

interface IdempotencyRow extends Record<string, unknown> {
  readonly request_hash: string;
  readonly response_json: ChatCompletionResponse | null;
  readonly status: "in_progress" | "completed" | "failed";
}

export class PostgresRelayStore implements RouteCatalog, AuditLog, UsageRepository, IdempotencyStore, CompletionRecorder {
  private readonly pool: PgPoolLike;

  constructor(pool: PgPoolLike) {
    this.pool = pool;
  }

  async listRoutesForTenant(tenantId: string): Promise<readonly ModelRoute[]> {
    const result = await this.pool.query<RouteRow>(
      `SELECT route_id, tenant_id, purpose, data_classifications, required_capabilities,
              max_cost_cents, provider_id, model, enabled
         FROM relay_routes
        WHERE tenant_id = $1 AND enabled = true
        ORDER BY route_id ASC`,
      [tenantId],
    );
    return result.rows.map(routeFromRow);
  }

  async getProvider(tenantId: string, providerId: string): Promise<ProviderConfig | undefined> {
    const result = await this.pool.query<ProviderRow>(
      `SELECT tenant_id, provider_id, adapter_type, base_url, capabilities, secret_reference, enabled
         FROM relay_providers
        WHERE tenant_id = $1 AND provider_id = $2 AND enabled = true`,
      [tenantId, providerId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : providerFromRow(row);
  }

  async append(event: AuditEvent): Promise<void>;
  async append(record: UsageRecord): Promise<void>;
  async append(input: AuditEvent | UsageRecord): Promise<void> {
    if ("action" in input) {
      await insertAudit(this.pool, input);
      return;
    }
    await insertUsage(this.pool, input);
  }

  async listForTenant(tenantId: string): Promise<readonly UsageRecord[]> {
    const result = await this.pool.query<UsageRow>(
      `SELECT id, tenant_id, request_id, route_id, provider_id, model, input_tokens,
              output_tokens, estimated_cost_cents, latency_ms, terminal_reason,
              correlation_id, created_at
         FROM relay_usage_records
        WHERE tenant_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 100`,
      [tenantId],
    );
    return result.rows.map(usageFromRow);
  }

  async get(tenantId: string, key: string): Promise<{ readonly requestHash: string; readonly response: ChatCompletionResponse } | undefined> {
    const record = await this.lookup(tenantId, key);
    if (record === undefined || record.status !== "completed") {
      return undefined;
    }
    return { requestHash: record.requestHash, response: record.response };
  }

  async lookup(tenantId: string, key: string) {
    const result = await this.pool.query<IdempotencyRow>(
      `SELECT request_hash, response_json, status
         FROM relay_idempotency_records
        WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, key],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    if (row.status === "completed" && row.response_json !== null) {
      return { status: "completed" as const, requestHash: row.request_hash, response: row.response_json };
    }
    if (row.status === "failed") {
      return { status: "failed" as const, requestHash: row.request_hash };
    }
    return { status: "in_progress" as const, requestHash: row.request_hash };
  }

  async reserve(tenantId: string, key: string, requestHash: string) {
    const insert = await this.pool.query(
      `INSERT INTO relay_idempotency_records
        (tenant_id, idempotency_key, request_hash, status)
       VALUES ($1, $2, $3, 'in_progress')
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
      [tenantId, key, requestHash],
    );
    if (insert.rowCount === 1) {
      return { status: "reserved" as const };
    }

    const result = await this.pool.query<IdempotencyRow>(
      `SELECT request_hash, response_json, status
         FROM relay_idempotency_records
        WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, key],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return { status: "conflict" as const, requestHash: "" };
    }
    if (row.request_hash !== requestHash) {
      return { status: "conflict" as const, requestHash: row.request_hash };
    }
    if (row.status === "completed" && row.response_json !== null) {
      return { status: "completed" as const, requestHash: row.request_hash, response: row.response_json };
    }
    if (row.status === "failed") {
      return { status: "failed" as const, requestHash: row.request_hash };
    }
    return { status: "in_progress" as const, requestHash: row.request_hash };
  }

  async fail(tenantId: string, key: string, requestHash: string): Promise<void> {
    await this.pool.query(
      `UPDATE relay_idempotency_records
          SET status = 'failed',
              completed_at = COALESCE(completed_at, now())
        WHERE tenant_id = $1
          AND idempotency_key = $2
          AND request_hash = $3
          AND status = 'in_progress'`,
      [tenantId, key, requestHash],
    );
  }

  async recordCompletion(input: {
    readonly tenantId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly response: ChatCompletionResponse;
    readonly usage: UsageRecord;
    readonly audit: AuditEvent;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await completeIdempotency(client, input.tenantId, input.idempotencyKey, input.requestHash, input.response);
      await insertUsage(client, input.usage);
      await insertAudit(client, input.audit);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function completeIdempotency(
  queryable: PgQueryable,
  tenantId: string,
  idempotencyKey: string,
  requestHash: string,
  response: ChatCompletionResponse,
): Promise<void> {
  const result = await queryable.query(
    `UPDATE relay_idempotency_records
        SET response_json = $4::jsonb,
            status = 'completed',
            completed_at = COALESCE(completed_at, now())
      WHERE tenant_id = $1
        AND idempotency_key = $2
        AND request_hash = $3
        AND status = 'in_progress'`,
    [tenantId, idempotencyKey, requestHash, response],
  );
  if (result.rowCount !== 1) {
    throw new RelayError("IDEMPOTENCY_CONFLICT", "Idempotency key was already recorded.", 409);
  }
}

async function insertUsage(queryable: PgQueryable, record: UsageRecord): Promise<void> {
  await queryable.query(
    `INSERT INTO relay_usage_records
      (id, tenant_id, request_id, route_id, provider_id, model, input_tokens,
       output_tokens, estimated_cost_cents, latency_ms, terminal_reason,
       correlation_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      record.id,
      record.tenantId,
      record.requestId,
      record.routeId,
      record.providerId,
      record.model,
      record.usage.inputTokens,
      record.usage.outputTokens,
      record.usage.estimatedCostCents,
      record.latencyMs,
      record.terminalReason,
      record.correlationId,
      record.createdAt,
    ],
  );
}

async function insertAudit(queryable: PgQueryable, event: AuditEvent): Promise<void> {
  await queryable.query(
    `INSERT INTO relay_audit_events
      (id, tenant_id, actor_id, action, resource_type, resource_id, reason_code,
       correlation_id, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
    [
      event.id,
      event.tenantId,
      event.actorId,
      event.action,
      event.resourceType,
      event.resourceId,
      event.reasonCode,
      event.correlationId,
      event.metadata,
      event.createdAt,
    ],
  );
}

function providerFromRow(row: ProviderRow): ProviderConfig {
  return {
    tenantId: row.tenant_id,
    providerId: row.provider_id,
    adapterType: row.adapter_type,
    baseUrl: row.base_url,
    capabilities: row.capabilities as ProviderConfig["capabilities"],
    secretReference: row.secret_reference,
    enabled: row.enabled,
  };
}

function routeFromRow(row: RouteRow): ModelRoute {
  return {
    routeId: row.route_id,
    tenantId: row.tenant_id,
    purpose: row.purpose,
    allowedDataClassifications: row.data_classifications as ModelRoute["allowedDataClassifications"],
    requiredCapabilities: row.required_capabilities as ModelRoute["requiredCapabilities"],
    maxCostCents: row.max_cost_cents,
    providerId: row.provider_id,
    model: row.model,
    enabled: row.enabled,
  };
}

function usageFromRow(row: UsageRow): UsageRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    requestId: row.request_id,
    routeId: row.route_id,
    providerId: row.provider_id,
    model: row.model,
    usage: {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      estimatedCostCents: row.estimated_cost_cents,
    },
    latencyMs: row.latency_ms,
    terminalReason: row.terminal_reason,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
  };
}
