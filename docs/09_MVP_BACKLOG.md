# 09. MVPバックログ

    ## GitHub Issue化ルール
    - 各Issueに`requirement:<ID>`、`priority:P0|P1|P2`、`area:core|api|storage|plugin|quality|docs`を付与する。
    - 実装Issueには必ず受入条件とテスト対象を記載する。
    - P0完了前に管理UI・高度な分析・課金を追加しない。

    | Priority | Issue title | 完了条件 |
    |---|---|---|
    | P0 | Bootstrap monorepo | pnpm workspace、TypeScript strict、Docker Compose、CI、lint、test基盤を作る。 |
| P0 | Contract boundary | OpenAPI 3.1、JSON Schema、エラー形式、authentication middlewareを実装する。 |
| P0 | Tenant isolation | tenant context、RBAC scope、DB query guard、越境テストを実装する。 |
| P0 | Core primary flow | OpenAI-compatible API、Provider Adapter SPI、ローカルHTTP Adapter、クラウドHTTP Adapterを実装する。 |
| P0 | Persistence and audit | PostgreSQL schema、migration、append-only audit、idempotency、outboxを実装する。 |
| P1 | Plugin host | SecretReference interfaceと環境変数実装を用意し、外部Secret Managerを差替可能にする。 |
| P1 | SDK and CLI | TypeScript SDK、sample app、CLI smoke testを実装する。 |
| P1 | Verification suite | V&V計画に対応するunit/integration/contract/e2e/security testを実装する。 |
| P1 | Observability | OpenTelemetry trace、metrics、health/readiness、構造化ログを実装する。 |
| P2 | Operational documentation | runbook、backup/restore、migration、incident templateを追加する。 |

    ## 最初のスプリント（推奨順）
    1. Bootstrap monorepo
    2. Contract boundary
    3. Tenant isolation
    4. Core primary flow
    5. Persistence and audit
    6. Verification suite
